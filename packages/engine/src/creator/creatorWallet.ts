/**
 * Launch creator wallet automation (docs/CREATOR_WALLET.md). Runs in the rewards worker, under its
 * leader lease, only when the launch creator's own key is configured (LAST60_CREATOR_WALLET_*), the
 * policy is forge_phase_aware_v2 and live signing is allowed. It does exactly two kinds of transfer,
 * both from the creator wallet, both ONLY to the dedicated payout wallet:
 *
 *   1. bonding_settlement — for every verified, FINALIZED bonding-curve creator-fee claim received by the
 *      creator: the claim's outstanding Last-60 share (75 % of what was collected, less anything already
 *      transferred) with the memo `last60:v1:<claim signature>`. The normal revenue pipeline links it to
 *      its claim (memo correlation) and credits it; because it lands in the payout wallet the credit is
 *      `direct` custody and funds a round with no further step. The creator keeps the other 25 %.
 *   2. custody_sweep — for every payable credit of Forge's post-migration creator payout
 *      (route forge_creator_distribution) whose SOL sits in the creator wallet: an automatically opened
 *      custody request and the exact outstanding SOL with the memo `last60:custody:v1:<custodyId>`,
 *      bound by the normal custody verification. Never a second contribution.
 *
 * Amounts come only from the records (expected allocation, credits, custody rows) — never from a wallet
 * balance. Every transfer is persisted with its signed bytes BEFORE broadcast; at most one transfer per
 * claim / contribution is in flight; a confirmed transfer whose effect is not yet recorded still counts
 * as sent; an attempt is retired only on a finalized on-chain failure or a proven blockhash expiry. So a
 * claim or contribution is never paid twice, across restarts, RPC failures and concurrent passes.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { formatSol } from "@last60/shared";
import type { AppConfig } from "../config/env";
import { liveSigningBlockReason, type SettingsStore } from "../config/runtime";
import { RpcError, type ChainRpc } from "../chain/rpc";
import { normalizeTransaction } from "../chain/tx";
import { MEMO_PROGRAM_ID } from "../chain/payoutTx";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import type { LaunchProvider } from "../providers/LaunchProvider";
import type { TerminalWriter } from "../terminal/terminal";
import { CURRENT_PHASE_AWARE_VERSION, FORGE_CREATOR_DISTRIBUTION, FUNDING_MEMO_PREFIX, WSOL_MINT, assetOf } from "../accounting/revenueStreams";
import { forgeLaunchContextOf, ingestRevenue, reconcileFunding, revenueRuntimeOf, type LaunchRef, type RevenueRuntime } from "../revenue/ingest";
import { bindCustodyTransfer, createCustodyRequest, custodiedTotals, custodyMemo, custodyRequirement, CustodyError, refreshCustodyFinality } from "../custody/custody";
import type { Clock } from "../util/time";
import { rootLogger, type Logger } from "../util/logger";

export const CREATOR_WALLET_STATUS_ID = "creator_wallet_status";
export const CREATOR_WALLET_ACTOR = "creator-wallet-automation";
/** Network fee budget per transfer (5 000 base + priority fee headroom); never part of a transferred amount. */
const FEE_BUDGET_LAMPORTS = 20_000n;
const COMPUTE_UNITS = 40_000;
const REBROADCAST_MS = 10_000;
const BATCH = 25;
/** A confirmed transfer whose effect still is not recorded after this many passes is flagged stuck (still counted as sent). */
const MAX_EFFECT_ATTEMPTS = 20;

export interface CreatorWalletDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  rpc: ChainRpc;
  provider: () => LaunchProvider;
  /** The launch creator's keypair (rewards worker only); null: automation stays idle. */
  creator: Keypair | null;
  terminal: TerminalWriter;
  clock: Clock;
  log?: Logger;
}

export interface CreatorPassResult {
  blocked: string | null;
  refreshed: number;
  settlementsSent: number;
  sweepsSent: number;
}

const sol = (v: bigint) => formatSol(v, 9, 2);

export class CreatorWalletAutomation {
  private readonly log: Logger;
  private lastBlocked: string | null | undefined = undefined;
  constructor(private readonly d: CreatorWalletDeps) {
    this.log = (d.log ?? rootLogger()).child({ component: "creator-wallet" });
  }

  get address(): string | null {
    return this.d.creator?.publicKey.toBase58() ?? null;
  }
  private get payoutWallet(): string | null {
    return this.d.cfg.payout.walletPublicKey;
  }
  private now() {
    return this.d.clock.now();
  }

  /** Why the automation cannot sign right now (null: it can). */
  async blockReason(): Promise<string | null> {
    const { cfg } = this.d;
    if (!cfg.creatorWallet.automationEnabled) return "creator wallet automation is disabled (no creator key, or not forge_phase_aware_v2)";
    if (!this.d.creator) return "no creator wallet key is loaded in this process";
    if (cfg.revenue.activation.pending) return "funding policy activation slot not resolved yet";
    if (cfg.revenue.policy.version !== CURRENT_PHASE_AWARE_VERSION) return `funding policy is ${cfg.revenue.policy.version}, not ${CURRENT_PHASE_AWARE_VERSION}`;
    if (!this.payoutWallet) return "no payout wallet is configured";
    const s = await this.d.settings.get();
    if (s.pausePayouts) return "payouts are paused by the admin";
    const live = liveSigningBlockReason(cfg, s);
    if (live) return live;
    const info = this.d.provider().info();
    if (info.feeBeneficiaryRole !== "creator") return `fee beneficiary role is ${info.feeBeneficiaryRole}, not creator`;
    if (!info.creator || info.creator !== this.address) return `the configured creator key (${this.address}) is not this pool's on-chain creator (${info.creator || "unknown"})`;
    return null;
  }

  /** One pass: refresh in-flight transfers, then settle bonding claims and sweep Forge creator payouts. */
  async run(): Promise<CreatorPassResult> {
    const res: CreatorPassResult = { blocked: null, refreshed: 0, settlementsSent: 0, sweepsSent: 0 };
    res.blocked = await this.blockReason();
    if (res.blocked !== this.lastBlocked) {
      if (res.blocked) this.log.warn({ reason: res.blocked }, "creator wallet automation idle");
      else this.log.info({ creator: this.address, payoutWallet: this.payoutWallet }, "creator wallet automation active");
      // The two configuration errors an operator must fix are surfaced on the terminal (once a day).
      if (res.blocked && /not this pool's on-chain creator/.test(res.blocked)) await this.d.terminal.error(`Creator wallet automation stopped: ${res.blocked}.`, `creator-blocked:mismatch:${Math.floor(this.now() / 86_400_000)}`);
      this.lastBlocked = res.blocked;
    }
    if (res.blocked) {
      await this.publishStatus(res, null);
      return res;
    }
    const provider = this.d.provider();
    const r = revenueRuntimeOf(this.d.cfg)!;
    const info = provider.info();
    const launch: LaunchRef = { sourcePool: info.poolAddress, quoteMint: info.quoteMint, provider: info.provider, tokenMint: info.tokenMint, forge: forgeLaunchContextOf(provider, r) };
    res.refreshed = await this.refreshInFlight(provider, r, launch);
    // Fresh reconciliation rows for claims / credits the indexer recorded since the last pass (idempotent).
    await reconcileFunding(this.d.db, launch, r).catch((err) => this.log.warn({ err: String(err) }, "reconciliation before settlement failed"));
    const balance = await this.d.rpc.getBalance(this.address!);
    const budget = { available: balance - this.d.cfg.creatorWallet.feeReserveLamports };
    res.settlementsSent = await this.settleBondingClaims(info.poolAddress, info.quoteMint, budget);
    res.sweepsSent = await this.sweepForgePayouts(info.poolAddress, budget);
    await refreshCustodyFinality(this.d.db, this.d.rpc, this.now()).catch((err) => this.log.warn({ err: String(err) }, "custody finality refresh failed"));
    await this.publishStatus(res, balance);
    return res;
  }

  // ── what is already on its way ────────────────────────────────────────────────────────────

  /** Lamports of transfers for `ref` that are in flight, or confirmed but not yet reflected in the records. */
  private async pendingFor(ref: string): Promise<{ amount: bigint; inFlight: boolean }> {
    const rows: any[] = await this.d.db.CreatorWalletTransfer.find({ ref, $or: [{ status: "submitted" }, { status: "confirmed", effectRecorded: false }] }, { lamports: 1, status: 1 }).lean();
    return { amount: rows.reduce((s, x) => s + big(x.lamports), 0n), inFlight: rows.some((x) => x.status === "submitted") };
  }

  /** Signatures among `sigs` that are finalized and successful. */
  private async finalizedOk(sigs: string[]): Promise<Set<string>> {
    const uniq = [...new Set(sigs)];
    if (!uniq.length) return new Set();
    const st = await this.d.rpc.getSignatureStatuses(uniq, true);
    return new Set(uniq.filter((_, i) => st[i] && !st[i]!.err && st[i]!.confirmationStatus === "finalized"));
  }

  // ── 1. bonding curve: 75 % of each collected claim ─────────────────────────────────────────

  private async settleBondingClaims(sourcePool: string, quoteMint: string, budget: { available: bigint }): Promise<number> {
    const { db, cfg } = this.d;
    const me = this.address!;
    if (assetOf(quoteMint) !== WSOL_MINT) {
      await this.d.terminal.warn(`Creator wallet automation: the launch is quoted in ${quoteMint}, not SOL; the bonding-curve 75 % is not settled automatically (rounds pay SOL).`, `creator-non-sol:${sourcePool}`);
      return 0;
    }
    const recs: any[] = await db.RevenueReconciliation.find({
      sourcePool,
      stream: "bonding_curve_creator_fee",
      recipient: me,
      verified: true,
      asset: WSOL_MINT,
      "policy.version": CURRENT_PHASE_AWARE_VERSION,
      collectionSlot: { $gt: cfg.revenue.policy.activationSlot },
      status: { $in: ["awaiting_distribution", "partial"] },
    }).sort({ collectionSlot: 1 }).limit(BATCH).lean();
    if (!recs.length) return 0;
    // Only claims that can no longer be forked out (rounds require the claim to be finalized too).
    const final = await this.finalizedOk(recs.map((x) => x.collectionSignature));
    let sent = 0;
    for (const rec of recs) {
      if (!final.has(rec.collectionSignature)) continue;
      const expected = big(rec.expectedLast60);
      const [agg]: any[] = await db.RewardFunding.aggregate([{ $match: { collectionKey: rec.key } }, { $group: { _id: null, o: { $sum: "$observedAmount" } } }]);
      const observed = big(agg?.o ?? 0);
      const pending = await this.pendingFor(rec.key);
      if (pending.inFlight) continue;
      const outstanding = expected - observed - pending.amount;
      if (outstanding < cfg.creatorWallet.minTransferLamports) continue;
      const amount = this.fit(outstanding, budget);
      if (amount < cfg.creatorWallet.minTransferLamports) {
        await this.d.terminal.warn(`Creator wallet balance too low to send the Asteroid Protocol share (${sol(outstanding)} SOL) of bonding claim ${rec.collectionSignature.slice(0, 8)}…; retrying automatically.`, `creator-low:${rec.key}:${Math.floor(this.now() / 3_600_000)}`);
        continue;
      }
      const sig = await this.send({ kind: "bonding_settlement", ref: rec.key, sourcePool, collectionKey: rec.key, collectionSignature: rec.collectionSignature, lamports: amount, memo: `${FUNDING_MEMO_PREFIX}${rec.collectionSignature}` });
      if (sig) {
        budget.available -= amount + FEE_BUDGET_LAMPORTS;
        sent++;
      }
    }
    return sent;
  }

  // ── 2. post-migration: sweep Forge's creator payout into the payout wallet ─────────────────

  private async sweepForgePayouts(sourcePool: string, budget: { available: bigint }): Promise<number> {
    const { db, cfg } = this.d;
    const me = this.address!;
    const payout = this.payoutWallet!;
    const credits: any[] = await db.RewardFunding.find({ sourcePool, route: FORGE_CREATOR_DISTRIBUTION, payoutEligible: true, roundNumber: null, fundingMint: WSOL_MINT, destinationWallet: me, "policy.version": CURRENT_PHASE_AWARE_VERSION }).sort({ slot: 1 }).limit(BATCH).lean();
    if (!credits.length) return 0;
    const final = await this.finalizedOk(credits.map((c) => c.signature));
    const custodyCfg = { enabled: true, payoutWallet: payout, requestTtlMs: cfg.revenue.custody.requestTtlMs };
    let sent = 0;
    for (const credit of credits) {
      if (!final.has(credit.signature)) continue; // Forge's payout must be final before its SOL moves on
      const req = custodyRequirement(credit, payout);
      if (req.mode !== "transfer" || req.custodian !== me) continue;
      const bound = (await custodiedTotals(db, [credit.key])).get(credit.key)?.amount ?? 0n;
      const pending = await this.pendingFor(credit.key);
      if (pending.inFlight) continue;
      const outstanding = req.required - bound - pending.amount;
      if (outstanding <= 0n) continue;
      if (bound === 0n && outstanding < cfg.creatorWallet.minTransferLamports) continue; // dust: not worth a network fee
      let open: any = await db.CustodyTransfer.findOne({ fundingKey: credit.key, status: "requested", destinationWallet: payout, expiresAt: { $gt: new Date(this.now()) } }).lean();
      if (!open) {
        try {
          open = await createCustodyRequest(db, custodyCfg, { fundingKey: credit.key, actor: CREATOR_WALLET_ACTOR, now: this.now() });
        } catch (err) {
          if (err instanceof CustodyError && err.code === "open_request_exists") open = await db.CustodyTransfer.findOne({ fundingKey: credit.key, status: "requested" }).lean();
          else {
            this.log.warn({ fundingKey: credit.key, err: String((err as Error)?.message ?? err) }, "custody request refused");
            continue;
          }
        }
        if (!open) continue;
      }
      let want = big(open.expectedAmount);
      if (want > outstanding) want = outstanding;
      const amount = this.fit(want, budget);
      if (amount <= 0n) {
        await this.d.terminal.warn(`Creator wallet balance too low to sweep ${sol(want)} SOL of Forge's creator payout into the payout wallet; retrying automatically.`, `creator-low:${credit.key}:${Math.floor(this.now() / 3_600_000)}`);
        continue;
      }
      const sig = await this.send({ kind: "custody_sweep", ref: credit.key, sourcePool, collectionKey: credit.collectionKey ?? null, fundingKey: credit.key, custodyId: open.custodyId, lamports: amount, memo: custodyMemo(open.custodyId) });
      if (sig) {
        budget.available -= amount + FEE_BUDGET_LAMPORTS;
        sent++;
      }
    }
    return sent;
  }

  /** The part of `want` the creator wallet can send while keeping its fee reserve. */
  private fit(want: bigint, budget: { available: bigint }): bigint {
    const room = budget.available - FEE_BUDGET_LAMPORTS;
    if (room <= 0n) return 0n;
    return want < room ? want : room;
  }

  // ── signing and broadcasting ───────────────────────────────────────────────────────────────

  private async send(o: { kind: "bonding_settlement" | "custody_sweep"; ref: string; sourcePool: string; collectionKey?: string | null; collectionSignature?: string | null; fundingKey?: string | null; custodyId?: string | null; lamports: bigint; memo: string }): Promise<string | null> {
    const creator = this.d.creator!;
    const payout = new PublicKey(this.payoutWallet!);
    const { blockhash, lastValidBlockHeight } = await this.d.rpc.getLatestBlockhash("confirmed");
    // Transfer-only: ComputeBudget + one System transfer to the payout wallet + the memo naming what it settles.
    const tx = new Transaction({ feePayer: creator.publicKey, recentBlockhash: blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.d.cfg.payout.priorityFeeMicroLamports }),
      SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: payout, lamports: o.lamports }),
      new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(o.memo, "utf8") }),
    );
    tx.sign(creator);
    const signature = bs58.encode(tx.signature!);
    const at = new Date(this.now());
    try {
      await this.d.db.CreatorWalletTransfer.create({
        signature,
        kind: o.kind,
        ref: o.ref,
        sourcePool: o.sourcePool,
        collectionKey: o.collectionKey ?? null,
        collectionSignature: o.collectionSignature ?? null,
        fundingKey: o.fundingKey ?? null,
        custodyId: o.custodyId ?? null,
        from: creator.publicKey.toBase58(),
        to: payout.toBase58(),
        lamports: dec(o.lamports),
        memo: o.memo,
        serializedTx: tx.serialize().toString("base64"),
        lastValidBlockHeight,
        status: "submitted",
        createdAt: at,
        updatedAt: at,
      });
    } catch (err: any) {
      if (err?.code === 11000) return null; // another transfer for this ref is already in flight
      throw err;
    }
    this.log.info({ kind: o.kind, ref: o.ref, lamports: o.lamports.toString(), signature }, "creator wallet transfer submitted");
    await this.broadcast(signature, true);
    return signature;
  }

  private async broadcast(signature: string, first: boolean) {
    const row: any = await this.d.db.CreatorWalletTransfer.findOne({ signature }).lean();
    if (!row || row.status !== "submitted") return;
    try {
      await this.d.rpc.sendRawTransaction(row.serializedTx, { skipPreflight: !first, preflightCommitment: "confirmed" });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/already been processed|AlreadyProcessed/i.test(msg)) {
        // landed via an earlier broadcast
      } else if (first && err instanceof RpcError && err.code === -32002) {
        // Preflight rejected the FIRST broadcast: the RPC never forwarded it and no other copy exists.
        await this.retire(signature, `preflight rejected: ${msg.slice(0, 300)}`);
        return;
      } else {
        this.log.warn({ signature, err: msg }, "creator wallet broadcast failed; will rebroadcast or wait for expiry");
      }
    }
    await this.d.db.CreatorWalletTransfer.updateOne({ signature, status: "submitted" }, { $set: { lastBroadcastAt: new Date(this.now()), updatedAt: new Date(this.now()) }, $inc: { broadcasts: 1 } });
  }

  private async retire(signature: string, reason: string) {
    await this.d.db.CreatorWalletTransfer.updateOne({ signature, status: "submitted" }, { $set: { status: "failed", error: reason.slice(0, 500), updatedAt: new Date(this.now()) } });
    this.log.warn({ signature, reason }, "creator wallet transfer retired; the amount is outstanding again");
  }

  /** Advance submitted transfers (confirm / retire / rebroadcast) and record the effect of confirmed ones. */
  async refreshInFlight(provider: LaunchProvider, r: RevenueRuntime, launch: LaunchRef): Promise<number> {
    const { db, rpc } = this.d;
    // Only this launch's transfers: their effect is recorded with this launch's provider and facts.
    const rows: any[] = await db.CreatorWalletTransfer.find({ sourcePool: launch.sourcePool, $or: [{ status: "submitted" }, { status: "confirmed", effectRecorded: false, stuckReason: null }] }).sort({ createdAt: 1 }).limit(50).lean();
    if (!rows.length) return 0;
    const first = await rpc.getSignatureStatusesWithContext(rows.map((x) => x.signature), true);
    let changed = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const st = first.value[i] ?? null;
      if (row.status === "submitted") {
        if (st?.err) {
          if (st.confirmationStatus === "finalized") {
            await this.retire(row.signature, `transaction failed on-chain: ${JSON.stringify(st.err)}`);
            changed++;
          }
          continue; // wait for finality before deciding (forks)
        }
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          await db.CreatorWalletTransfer.updateOne({ signature: row.signature, status: "submitted" }, { $set: { status: "confirmed", slot: st.slot, updatedAt: new Date(this.now()) } });
          changed++;
        } else if (!st) {
          const fin = await rpc.getEpochInfo("finalized");
          if (fin.blockHeight > row.lastValidBlockHeight) {
            const again = await rpc.getSignatureStatusesWithContext([row.signature], true); // close the race
            // "Unknown" proves the transfer can never land only if both answers came from nodes at or past
            // the finalized slot at which its blockhash is expired (a lagging node may not have seen it).
            if (!again.value[0] && first.contextSlot >= fin.absoluteSlot && again.contextSlot >= fin.absoluteSlot) {
              await this.retire(row.signature, "blockhash expired without the transaction landing");
              changed++;
            }
          } else if (this.now() - (row.lastBroadcastAt ? new Date(row.lastBroadcastAt).getTime() : 0) >= REBROADCAST_MS) {
            await this.broadcast(row.signature, false);
          }
          continue;
        } else continue; // processed: not yet confirmed
      }
      if (await this.recordEffect(row, st?.confirmationStatus === "finalized" ? "finalized" : "confirmed", provider, r, launch)) changed++;
    }
    return changed;
  }

  /** Make the records reflect a confirmed transfer: the credit (settlement) or the custody binding (sweep). */
  private async recordEffect(row: any, commitment: "confirmed" | "finalized", provider: LaunchProvider, r: RevenueRuntime, launch: LaunchRef): Promise<boolean> {
    const { db } = this.d;
    const raw = await this.d.rpc.getTransactionRaw(row.signature, "confirmed").catch(() => null);
    if (!raw) return false; // RPC lag: retried next pass (the transfer keeps counting as sent)
    const tx = normalizeTransaction(raw);
    const attempt = async (stuck: string | null, effect: Record<string, unknown> | null) => {
      const n = (row.effectAttempts ?? 0) + 1;
      const stuckReason = stuck ?? (n >= MAX_EFFECT_ATTEMPTS ? "effect_not_recorded_after_retries" : null);
      await db.CreatorWalletTransfer.updateOne({ signature: row.signature }, { $set: { effectAttempts: n, stuckReason, effect, updatedAt: new Date(this.now()) } });
      if (stuckReason) await this.d.terminal.error(`Creator wallet transfer ${row.signature.slice(0, 8)}… (${sol(big(row.lamports))} SOL) reached the payout wallet but could not be recorded (${stuckReason}); it is counted as sent and will not be repeated — review it.`, `creator-stuck:${row.signature}`);
      return false;
    };
    if (row.kind === "bonding_settlement") {
      await ingestRevenue(db, tx, provider.parseTransaction(tx), provider, r, { commitment });
      await reconcileFunding(db, launch, r);
      const credit: any = await db.RewardFunding.findOne({ signature: row.signature }).lean();
      if (!credit) return attempt(null, { waiting: "credit_not_written_yet" });
      await db.CreatorWalletTransfer.updateOne({ signature: row.signature }, { $set: { effectRecorded: true, effect: { creditKey: credit.key, payoutEligible: credit.payoutEligible, creditable: big(credit.creditableAmount).toString(), reason: credit.ineligibleReason ?? null }, updatedAt: new Date(this.now()) } });
      if (credit.payoutEligible) await this.d.terminal.system(`Creator wallet sent ${sol(big(row.lamports))} SOL — the Asteroid Protocol share of a bonding-curve fee claim — to the payout wallet.`, `creator-settled:${row.signature}`);
      else await this.d.terminal.warn(`Creator wallet transfer ${row.signature.slice(0, 8)}… was recorded but is not payable: ${credit.ineligibleReason ?? "unknown"}.`, `creator-settled:${row.signature}`);
      return true;
    }
    const b = await bindCustodyTransfer(db, { custodyId: row.custodyId, tx, commitment, method: "creator_wallet_sweep", actor: CREATOR_WALLET_ACTOR, payoutWallet: this.payoutWallet, requireMemo: true, now: this.now() });
    if (!b.accepted) return attempt(`custody_binding_rejected: ${b.reason}`.slice(0, 300), { rejected: b.reason });
    await db.CreatorWalletTransfer.updateOne({ signature: row.signature }, { $set: { effectRecorded: true, effect: { custodyId: b.custodyId, custodyStatus: b.status, credited: b.credited.toString(), excess: b.excess.toString(), duplicate: b.duplicate }, updatedAt: new Date(this.now()) } });
    await this.d.terminal.system(`Creator wallet swept ${sol(big(row.lamports))} SOL of Forge's post-migration creator payout into the payout wallet.`, `creator-swept:${row.signature}`);
    return true;
  }

  /** Sanitized status for operators (`bun run cli creator-wallet`, system_state.creator_wallet_status). Never key material. */
  private async publishStatus(res: CreatorPassResult, balance: bigint | null) {
    const { db } = this.d;
    const pool = this.d.cfg.provider.poolAddress ? { sourcePool: this.d.cfg.provider.poolAddress } : {};
    const [inFlight, awaitingEffect, stuck] = await Promise.all([
      db.CreatorWalletTransfer.countDocuments({ ...pool, status: "submitted" }),
      db.CreatorWalletTransfer.countDocuments({ ...pool, status: "confirmed", effectRecorded: false }),
      db.CreatorWalletTransfer.countDocuments({ ...pool, stuckReason: { $type: "string" } }),
    ]);
    const value = { address: this.address, payoutWallet: this.payoutWallet, automationEnabled: this.d.cfg.creatorWallet.automationEnabled, blocked: res.blocked, balanceLamports: balance?.toString() ?? null, lastPass: { at: new Date(this.now()).toISOString(), refreshed: res.refreshed, settlementsSent: res.settlementsSent, sweepsSent: res.sweepsSent }, inFlight, awaitingEffect, stuck, instance: this.d.cfg.instanceId };
    await db.SystemState.updateOne({ _id: CREATOR_WALLET_STATUS_ID }, { $set: { value, updatedAt: new Date() } }, { upsert: true }).catch(() => undefined);
  }
}
