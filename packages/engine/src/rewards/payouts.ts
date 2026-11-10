/**
 * PayoutExecutor — moves allocated rewards on-chain, exactly once per (round, recipient).
 *
 * State machine per payout:
 *   pending ──CAS+fence──► signing ──persist sig/blockhash/bytes──► submitted ──► confirmed
 *      ▲                                                               │
 *      └── attempt provably dead: finalized height > lastValidBlockHeight and signature unknown,
 *          or landed with an error at `finalized` ────────────────────┘ → failed after max attempts
 *
 * The rule that makes double payment impossible: a NEW transaction for a payout is only ever
 * created after the previous one can no longer land. Rebroadcasts reuse the identical bytes
 * (same signature), which Solana deduplicates.
 */
import type { Keypair } from "@solana/web3.js";
import { PayoutSigner, type PayoutAuthorization } from "../signer/payoutSigner";
import type { AppConfig } from "../config/env";
import { liveSigningBlockReason, type SettingsStore } from "../config/runtime";
import { RpcError, type ChainRpc } from "../chain/rpc";
import { buildUnsignedPayoutTransaction } from "../chain/payoutTx";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import { inTransaction } from "../db/connection";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { TerminalWriter } from "../terminal/terminal";
import { backoffDelay } from "../util/backoff";
import { randomToken } from "../util/crypto";
import type { Clock } from "../util/time";
import { rootLogger, type Logger } from "../util/logger";

export interface PayoutDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  rpc: ChainRpc;
  /** The dedicated payout signer (preferred). */
  signer?: PayoutSigner | null;
  /** @deprecated raw keypair (tests); wrapped into a PayoutSigner. */
  payer?: Keypair | null;
  terminal: TerminalWriter;
  clock: Clock;
  log?: Logger;
  tokenInfo?: (mint: string) => Promise<{ program: string; decimals: number }>;
}

const SIGNING_LOCK_MS = 30_000;
const TOKEN_PROGRAM_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const REBROADCAST_MS = 2_000;
const TX_FEE_ESTIMATE = 10_000n; // base fee + priority headroom per payout
const WSOL = "So11111111111111111111111111111111111111112";
/** Rent-exempt size of a token account (Token: 165 bytes; Token-2022 accounts with extensions are larger). */
const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_2022_ACCOUNT_SIZE = 182;

export class PayoutExecutor {
  private readonly log: Logger;
  private readonly signer: PayoutSigner | null;
  constructor(private readonly d: PayoutDeps) {
    this.log = (d.log ?? rootLogger()).child({ component: "payouts" });
    this.signer = d.signer ?? (d.payer ? PayoutSigner.fromKeypair(d.payer) : null);
  }

  private now() {
    return this.d.clock.now();
  }

  async isHalted(): Promise<string | null> {
    const h: any = await this.d.db.SystemState.findById("payout_halt").lean();
    return h?.value?.reason ?? null;
  }

  /** Process every payout that is due. Returns the number of payouts that changed state. */
  async processDue(): Promise<number> {
    const settings = await this.d.settings.get();
    const now = this.now();
    // Reset abandoned `signing` rows: they were never broadcast (we only send after persisting).
    await this.d.db.Payout.updateMany({ state: "signing", "lock.expiresAt": { $lt: new Date(now) } }, { $set: { state: "pending", lock: null } });
    const due: any[] = await this.d.db.Payout.find({ state: { $in: ["pending", "submitted"] }, nextAttemptAt: { $lte: new Date(now) } })
      .select("+current.serializedTx")
      .sort({ roundNumber: 1, position: 1 })
      .limit(100)
      .lean();
    if (!due.length) return 0;
    const halted = await this.isHalted();
    let changed = 0;
    const rounds = new Set<number>();
    const queue = [...due];
    const workers = Array.from({ length: Math.min(this.d.cfg.payout.concurrency, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          const did = p.state === "pending" ? await this.startAttempt(p, { paused: settings.pausePayouts, halted }) : await this.checkSubmitted(p);
          if (did) {
            changed++;
            rounds.add(p.roundNumber);
          }
        } catch (err: any) {
          this.log.error({ payoutId: String(p._id), err: String(err?.message ?? err) }, "payout step failed");
          await this.d.db.Payout.updateOne({ _id: p._id }, { $set: { lastError: String(err?.message ?? err).slice(0, 500), nextAttemptAt: new Date(this.now() + backoffDelay(p.attemptCount ?? 0, { baseMs: 2000, maxMs: 60_000 })) } });
          rounds.add(p.roundNumber);
        }
      }
    });
    await Promise.all(workers);
    for (const r of rounds) await this.refreshRound(r);
    return changed;
  }

  private async startAttempt(p: any, o: { paused: boolean; halted: string | null }): Promise<boolean> {
    if (p.mode === "dry_run") return this.simulate(p);
    if (o.paused || o.halted) return false;
    const settings = await this.d.settings.get();
    // Re-check the live/mainnet switches against THIS process' environment right before signing.
    const blocked = liveSigningBlockReason(this.d.cfg, settings);
    if (blocked) {
      await this.d.db.Payout.updateOne({ _id: p._id, state: "pending" }, { $set: { lastError: `not signed: ${blocked}`, nextAttemptAt: new Date(this.now() + 15_000) } });
      await this.d.terminal.warn(`Live payouts are queued and not being signed: ${blocked}.`, `live-blocked:${Math.floor(this.now() / 600_000)}`, p.roundNumber);
      return false;
    }
    // Fail closed: no validated signer → nothing is signed, and never from another wallet.
    if (!this.signer) throw new Error("live payout requested but no validated payout signer is loaded (LAST60_PAYOUT_WALLET_PRIVATE_KEY missing or invalid)");
    const payerPk = this.signer.address;
    if (this.d.cfg.payout.walletPublicKey && this.d.cfg.payout.walletPublicKey !== payerPk) {
      throw new Error(`payout signer ${payerPk} is not the configured LAST60_PAYOUT_WALLET_ADDRESS ${this.d.cfg.payout.walletPublicKey}; refusing to sign`);
    }
    if (settings.expectedPayoutPublicKey && settings.expectedPayoutPublicKey !== payerPk) {
      throw new Error(`payout key ${payerPk} does not match the configured payout public key ${settings.expectedPayoutPublicKey}; refusing to sign`);
    }
    const amount = big(p.amount);

    // CAS pending → signing with a fresh fencing token. Claiming the row FIRST makes it a
    // reservation: every concurrent worker (in any process) that checks funds after this point counts
    // this payout as in flight, so two workers can never both rely on the same available balance.
    const token = randomToken(12);
    const claimed = await this.d.db.Payout.findOneAndUpdate(
      { _id: p._id, state: "pending" },
      { $set: { state: "signing", lock: { owner: this.d.cfg.instanceId, token, expiresAt: new Date(this.now() + SIGNING_LOCK_MS) } } },
      { returnDocument: "after" },
    ).lean();
    if (!claimed) return false;

    const token2022 = p.mint !== WSOL ? await this.d.tokenInfo?.(p.mint) : undefined;
    const shortfall = await this.fundsShortfall(p, amount, payerPk, token2022);
    if (shortfall) {
      // Release the reservation (only if we still own it) and wait for funding.
      // Jittered retry: two workers that reserved at the same instant both see each other and back
      // off (safe — nothing is over-committed); jitter breaks the symmetry so one proceeds next time.
      await this.d.db.Payout.updateOne({ _id: p._id, state: "signing", "lock.token": token }, { $set: { state: "pending", lock: null, lastError: shortfall, nextAttemptAt: new Date(this.now() + 5_000 + Math.floor(Math.random() * 15_000)) } });
      await this.d.db.Round.updateOne({ roundNumber: p.roundNumber, state: { $in: ["paying", "awaiting_funds"] } }, { $set: { state: "awaiting_funds" } });
      await this.d.terminal.warn(`Payout wallet balance is insufficient; round #${p.roundNumber} payouts are queued until it is funded.`, `funds:${p.roundNumber}:${Math.floor(this.now() / 600_000)}`, p.roundNumber);
      this.log.warn({ payoutId: String(p._id), roundNumber: p.roundNumber, detail: shortfall }, "payout waiting for funds");
      return false;
    }

    const { blockhash, lastValidBlockHeight } = await this.d.rpc.getLatestBlockhash("confirmed");
    // 1. Construction (unsigned) → 2. authorization (the fenced, claimed payout row) → 3. signing
    // (the signer re-validates every instruction against the authorization).
    const unsigned = buildUnsignedPayoutTransaction({
      payer: this.signer.publicKey,
      recipient: p.recipient,
      amount,
      mint: p.mint,
      blockhash,
      priorityFeeMicroLamports: this.d.cfg.payout.priorityFeeMicroLamports,
      computeUnitLimit: this.d.cfg.payout.computeUnitLimit,
      memo: this.d.cfg.payout.memo ? `last60:r${p.roundNumber}:${String(p._id)}` : null,
      token: token2022,
    });
    const auth = await authorizePayout(this.d.db, p._id, token, token2022?.program ?? null);
    const built = this.signer.signPayout(unsigned, auth);
    const n = (p.attemptCount ?? 0) + 1;
    // Persist BEFORE broadcasting. If this CAS fails we lost the lock and must not send.
    const persisted = await this.d.db.Payout.updateOne(
      { _id: p._id, state: "signing", "lock.token": token },
      {
        $set: {
          state: "submitted",
          lock: null,
          current: { signature: built.signature, blockhash, lastValidBlockHeight, serializedTx: built.serialized, createdAt: new Date(this.now()), lastBroadcastAt: null, broadcasts: 0 },
          lastError: null,
          nextAttemptAt: new Date(this.now()),
        },
        $inc: { attemptCount: 1 },
        $push: { attempts: { n, signature: built.signature, blockhash, lastValidBlockHeight, createdAt: new Date(this.now()), outcome: "in_flight" } },
      },
    );
    if (!persisted.modifiedCount) {
      this.log.warn({ payoutId: String(p._id) }, "lost payout lock before broadcast; not sending");
      return false;
    }
    await this.broadcast(p._id, built.signature, built.serialized, true);
    await this.d.terminal.payoutSubmitted(p.roundNumber, built.signature, n);
    return true;
  }

  /** Send (or re-send) the exact persisted bytes. */
  private async broadcast(payoutId: unknown, signature: string, serialized: string, first: boolean) {
    try {
      await this.d.rpc.sendRawTransaction(serialized, { skipPreflight: !first, preflightCommitment: "confirmed" });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/already been processed|AlreadyProcessed/i.test(msg)) {
        // Landed via an earlier broadcast — status checks will confirm it.
      } else if (first && err instanceof RpcError && err.code === -32002) {
        // Preflight simulation rejected the FIRST broadcast: the RPC did not forward it and no
        // other copy exists, so this signature can never land. Safe to retire immediately.
        await this.retireAttempt(payoutId, signature, "failed", `preflight rejected: ${msg.slice(0, 300)}`);
        return;
      } else {
        this.log.warn({ signature, err: msg }, "broadcast failed; will rebroadcast or wait for expiry");
      }
    }
    await this.d.db.Payout.updateOne({ _id: payoutId, "current.signature": signature }, { $set: { "current.lastBroadcastAt": new Date(this.now()) }, $inc: { "current.broadcasts": 1 } });
  }

  private async checkSubmitted(p: any): Promise<boolean> {
    const sig: string = p.current?.signature;
    if (!sig) throw new Error("submitted payout without a signature");
    const first = await this.d.rpc.getSignatureStatusesWithContext([sig], true);
    const st = first.value[0];
    const required = this.d.cfg.payout.commitment;
    if (st) {
      if (st.err) {
        if (st.confirmationStatus === "finalized") return this.retireAttempt(p._id, sig, "failed", `transaction failed on-chain: ${JSON.stringify(st.err)}`);
        return false; // wait for finality before deciding (forks)
      }
      const reached = required === "confirmed" ? st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" : st.confirmationStatus === "finalized";
      if (!reached) return false;
      return this.confirm(p, sig, st.slot);
    }
    // Unknown signature: has its blockhash expired at FINALIZED height? Slot and height come from
    // one node in one call, so they are consistent with each other.
    const fin = await this.d.rpc.getEpochInfo("finalized");
    if (fin.blockHeight > p.current.lastValidBlockHeight) {
      const again = await this.d.rpc.getSignatureStatusesWithContext([sig], true); // close the race
      if (again.value[0]) return false;
      // "Unknown" proves the transaction can never land only if BOTH answers came from nodes that
      // had processed at least the finalized slot at which the blockhash is known to be expired.
      // A lagging or freshly restarted backend (load-balanced RPCs, failover) may simply not have
      // seen the landing slot yet; re-signing on its word would pay the recipient twice.
      if (first.contextSlot >= fin.absoluteSlot && again.contextSlot >= fin.absoluteSlot) {
        return this.retireAttempt(p._id, sig, "expired", "blockhash expired without the transaction landing");
      }
      this.log.warn({ payoutId: String(p._id), signature: sig, contextSlots: [first.contextSlot, again.contextSlot], finalizedSlot: fin.absoluteSlot }, "signature unknown to a lagging RPC node; expiry not proven, re-checking later");
      await this.d.db.Payout.updateOne({ _id: p._id, "current.signature": sig }, { $set: { lastError: "expiry not proven: status answered by a node behind the finalized slot", nextAttemptAt: new Date(this.now() + 5_000) } });
      return false;
    }
    const last = p.current.lastBroadcastAt ? new Date(p.current.lastBroadcastAt).getTime() : 0;
    if (this.now() - last >= REBROADCAST_MS && p.current.serializedTx) await this.broadcast(p._id, sig, p.current.serializedTx, false);
    await this.d.db.Payout.updateOne({ _id: p._id, "current.signature": sig }, { $set: { nextAttemptAt: new Date(this.now() + 1000) } });
    return false;
  }

  /** The attempt can provably never land: back to pending (new attempt) or failed after max. */
  private async retireAttempt(payoutId: unknown, signature: string, outcome: "expired" | "failed", reason: string): Promise<boolean> {
    const p: any = await this.d.db.Payout.findById(payoutId).lean();
    if (!p || p.current?.signature !== signature) return false;
    const exhausted = (p.attemptCount ?? 0) >= this.d.cfg.payout.maxAttempts;
    // The state change and (when exhausted) the PAYOUT_FAILED entry commit atomically.
    const modified = await inTransaction(this.d.db, async (session) => {
      const res = await this.d.db.Payout.updateOne(
        { _id: payoutId, state: "submitted", "current.signature": signature },
        {
          $set: {
            state: exhausted ? "failed" : "pending",
            current: null,
            lastError: reason,
            ...(exhausted ? { ledgerApplied: true } : {}),
            nextAttemptAt: new Date(this.now() + backoffDelay(p.attemptCount ?? 0, { baseMs: 2000, maxMs: 60_000, jitter: false })),
            "attempts.$[a].outcome": outcome,
            "attempts.$[a].error": reason,
          },
        },
        { arrayFilters: [{ "a.signature": signature }], session },
      );
      if (!res.modifiedCount) return false;
      if (exhausted) await this.d.db.LedgerEntry.updateOne({ key: `PAYOUT_FAILED:${String(payoutId)}` }, { $setOnInsert: { key: `PAYOUT_FAILED:${String(payoutId)}`, type: "PAYOUT_FAILED", roundNumber: p.roundNumber, amount: p.amount, mint: p.mint, payoutId, memo: reason } }, { upsert: true, session });
      return true;
    });
    if (!modified) return false;
    this.log.warn({ payoutId: String(payoutId), signature, outcome, exhausted, reason }, "payout attempt retired");
    if (exhausted) {
      await this.d.terminal.error(`Payout for round #${p.roundNumber} failed after ${p.attemptCount} attempts; queued for operator review (funds not sent).`, `payout-failed:${String(payoutId)}`, p.roundNumber);
    }
    return true;
  }

  /**
   * U2: the payout's state change, its PAYOUT_CONFIRMED ledger entry and the recipient's statistics
   * commit in ONE MongoDB transaction. A crash can no longer leave a confirmed payout without its
   * ledger entry; a retry finds the payout already confirmed (CAS fails) and writes nothing twice.
   */
  private async confirm(p: any, signature: string, slot: number): Promise<boolean> {
    const done = await inTransaction(this.d.db, async (session) => {
      const res = await this.d.db.Payout.updateOne(
        { _id: p._id, state: "submitted", "current.signature": signature },
        { $set: { state: "confirmed", confirmedSignature: signature, confirmedSlot: slot, confirmedAt: new Date(this.now()), lastError: null, ledgerApplied: true, "attempts.$[a].outcome": "confirmed" } },
        { arrayFilters: [{ "a.signature": signature }], session },
      );
      if (!res.modifiedCount) return false;
      await applyConfirmedLedger(this.d.db, p, signature, session);
      return true;
    });
    if (!done) return false;
    await this.d.terminal.payoutConfirmed(p.roundNumber, { recipient: p.recipient, amount: big(p.amount), signature, commitment: this.d.cfg.payout.commitment, kind: p.kind });
    return true;
  }

  private async simulate(p: any): Promise<boolean> {
    const res = await this.d.db.Payout.updateOne({ _id: p._id, state: "pending", mode: "dry_run" }, { $set: { state: "simulated", confirmedAt: new Date(this.now()) } });
    if (!res.modifiedCount) return false;
    await this.d.db.LedgerEntry.updateOne(
      { key: `PAYOUT_SIMULATED:${String(p._id)}` },
      { $setOnInsert: { key: `PAYOUT_SIMULATED:${String(p._id)}`, type: "PAYOUT_SIMULATED", roundNumber: p.roundNumber, amount: p.amount, mint: p.mint, payoutId: p._id, memo: `dry-run: ${p.recipient}` } },
      { upsert: true },
    );
    await this.d.terminal.payoutSimulated(p.roundNumber, { recipient: p.recipient, amount: big(p.amount), payoutId: String(p._id), kind: p.kind });
    return true;
  }

  /** Other live payouts currently reserved (signing) or in flight (submitted), per mint and in total. */
  private async inflight(excludeId: unknown): Promise<{ byMint: Map<string, bigint>; count: number }> {
    const r: any[] = await this.d.db.Payout.aggregate([{ $match: { state: { $in: ["signing", "submitted"] }, mode: "live", _id: { $ne: excludeId } } }, { $group: { _id: "$mint", t: { $sum: "$amount" }, n: { $sum: 1 } } }]);
    return { byMint: new Map(r.map((x) => [x._id as string, big(x.t)])), count: r.reduce((s, x) => s + (x.n as number), 0) };
  }

  /**
   * U5 preflight. Returns null when funds suffice, else an actionable diagnostic. Called while this
   * payout is already reserved (state `signing`), and every other reserved/in-flight payout is
   * counted, so concurrent workers cannot over-commit the same balance.
   *   SOL payout: SOL ≥ amount + other SOL payouts in flight + fees (this + in flight) + reserve
   *   SPL payout: token balance ≥ amount + same-mint payouts in flight, AND
   *               SOL ≥ fees + rent for the recipient's token account if it must be created + reserve
   */
  private async fundsShortfall(p: any, amount: bigint, payerPk: string, token?: { program: string; decimals: number }): Promise<string | null> {
    const inflight = await this.inflight(p._id);
    const reserve = this.d.cfg.payout.minReserveLamports;
    const fees = TX_FEE_ESTIMATE * BigInt(1 + inflight.count);
    const sol = await this.d.rpc.getBalance(payerPk, "confirmed");
    if (p.mint === WSOL) {
      const need = amount + (inflight.byMint.get(WSOL) ?? 0n) + fees + reserve;
      return sol >= need ? null : `insufficient SOL in payout wallet ${payerPk}: have ${sol}, need ${need} (payout ${amount} + in flight ${inflight.byMint.get(WSOL) ?? 0n} + fees ${fees} + reserve ${reserve}); fund it with at least ${need - sol} lamports`;
    }
    if (!token) return `token program/decimals for ${p.mint} unavailable; refusing to sign an SPL payout without them`;
    const program = new PublicKey(token.program);
    const mint = new PublicKey(p.mint);
    const source = getAssociatedTokenAddressSync(mint, new PublicKey(payerPk), false, program, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
    const dest = getAssociatedTokenAddressSync(mint, new PublicKey(p.recipient), true, program, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
    const [bal, destAcc] = await Promise.all([this.d.rpc.getTokenAccountBalance(source, "confirmed"), this.d.rpc.getAccountInfo(dest, "confirmed")]);
    const have = bal?.amount ?? 0n;
    const needToken = amount + (inflight.byMint.get(p.mint) ?? 0n);
    if (have < needToken) return `insufficient ${p.mint} in payout token account ${source}: have ${have}, need ${needToken} (payout ${amount} + in flight ${needToken - amount}); fund it with at least ${needToken - have} base units`;
    const rent = destAcc.value ? 0n : BigInt(await this.d.rpc.getMinimumBalanceForRentExemption(token.program === TOKEN_PROGRAM_2022 ? TOKEN_2022_ACCOUNT_SIZE : TOKEN_ACCOUNT_SIZE));
    // Other in-flight SPL payouts may also need rent; reserve one account's rent per in-flight payout.
    const rentOthers = inflight.count > 0 ? BigInt(await this.d.rpc.getMinimumBalanceForRentExemption(TOKEN_2022_ACCOUNT_SIZE)) * BigInt(inflight.count) : 0n;
    const needSol = fees + rent + rentOthers + (inflight.byMint.get(WSOL) ?? 0n) + reserve;
    return sol >= needSol ? null : `insufficient SOL for fees/rent in payout wallet ${payerPk}: have ${sol}, need ${needSol} (fees ${fees} + recipient token-account rent ${rent} + in-flight rent ${rentOthers} + reserve ${reserve}); fund it with at least ${needSol - sol} lamports`;
  }

  /** Recompute a round's paid/pending/failed totals and its state from its payouts. */
  async refreshRound(roundNumber: number) {
    const rows: any[] = await this.d.db.Payout.aggregate([{ $match: { roundNumber } }, { $group: { _id: "$state", t: { $sum: "$amount" }, n: { $sum: 1 } } }]);
    const by = Object.fromEntries(rows.map((r) => [r._id, { t: big(r.t), n: r.n as number }]));
    const t = (k: string) => by[k]?.t ?? 0n;
    const nOf = (k: string) => by[k]?.n ?? 0;
    const total = rows.reduce((s, r) => s + r.n, 0);
    const paid = t("confirmed");
    const pending = t("pending") + t("signing") + t("submitted");
    const failed = t("failed");
    const round: any = await this.d.db.Round.findOne({ roundNumber }).lean();
    if (!round || !["paying", "awaiting_funds", "attention"].includes(round.state)) return;
    let state = round.state;
    if (nOf("confirmed") + nOf("simulated") === total) state = "completed";
    else if (nOf("failed") > 0 && pending === 0n) state = "attention";
    else if (round.state === "awaiting_funds" && nOf("submitted") === 0) state = "awaiting_funds";
    else state = "paying";
    const res = await this.d.db.Round.updateOne(
      { roundNumber, state: round.state },
      { $set: { paid: dec(paid), pending: dec(pending), failed: dec(failed), state, ...(state === "completed" ? { completedAt: new Date(this.now()) } : {}) } },
    );
    if (res.modifiedCount && state === "completed" && round.state !== "completed") await this.d.terminal.roundCompleted(roundNumber, paid, !!round.dryRun);
  }

  /** Operator action: requeue a failed payout. Safe because every prior attempt is provably dead. */
  requeueFailed(payoutId: string, actor: string): Promise<boolean> {
    return requeueFailedPayout(this.d.db, payoutId, actor, this.now());
  }
}

/**
 * Payout authorization: what may be signed is defined by the payout row this worker has claimed
 * (state `signing`, our fencing token, live mode) in a round that is paying — never by a request.
 */
export async function authorizePayout(db: Models, payoutId: unknown, lockToken: string, tokenProgram: string | null): Promise<PayoutAuthorization> {
  const p: any = await db.Payout.findOne({ _id: payoutId, state: "signing", "lock.token": lockToken, mode: "live" }).lean();
  if (!p) throw new Error("payout authorization failed: the payout is not claimed by this worker");
  const round: any = await db.Round.findOne({ roundNumber: p.roundNumber }, { state: 1 }).lean();
  // Payout rows are created only inside their round's planning transaction; a round that is already
  // settled can never authorize another transfer.
  if (round && ["completed", "rolled_over", "missed", "open", "scheduled", "snapshotting"].includes(round.state)) throw new Error(`payout authorization failed: round #${p.roundNumber} is ${round.state}`);
  return Object.freeze({ kind: "reward_payout" as const, payoutId: String(p._id), roundNumber: p.roundNumber as number, recipient: p.recipient as string, amount: big(p.amount), mint: p.mint as string, tokenProgram: p.mint === WSOL ? null : tokenProgram, lockToken });
}

/**
 * Requeue a `failed` payout (DB-only, usable from the admin API and CLI). A payout only reaches
 * `failed` after every attempt was proven dead (expired or failed at finalized), so retrying
 * cannot double pay.
 */
export async function requeueFailedPayout(db: Models, payoutId: string, actor: string, now = Date.now()): Promise<boolean> {
  if (!/^[0-9a-f]{24}$/i.test(payoutId)) return false; // not an ObjectId (avoid a CastError → HTTP 500)
  const p: any = await db.Payout.findById(payoutId).lean();
  if (!p || p.state !== "failed") return false;
  const res = await db.Payout.updateOne({ _id: p._id, state: "failed" }, { $set: { state: "pending", attemptCount: 0, nextAttemptAt: new Date(now), lastError: `requeued by ${actor}` } });
  if (!res.modifiedCount) return false;
  await db.LedgerEntry.create({ key: `PAYOUT_REQUEUED:${payoutId}:${now}`, type: "PAYOUT_REQUEUED", roundNumber: p.roundNumber, amount: p.amount, mint: p.mint, payoutId: p._id, memo: `requeued by ${actor}` });
  await db.Round.updateOne({ roundNumber: p.roundNumber, state: "attention" }, { $set: { state: "paying" } });
  return true;
}

/** Ledger entry + buyer statistics for a confirmed payout (inside the caller's transaction). */
async function applyConfirmedLedger(db: Models, p: any, signature: string, session: any) {
  await db.LedgerEntry.updateOne(
    { key: `PAYOUT_CONFIRMED:${String(p._id)}` },
    { $setOnInsert: { key: `PAYOUT_CONFIRMED:${String(p._id)}`, type: "PAYOUT_CONFIRMED", roundNumber: p.roundNumber, amount: p.amount, mint: p.mint, payoutId: p._id, signature, memo: p.recipient } },
    { upsert: true, session },
  );
  // A drawn holder may never have bought through the indexed pools: do not create a buyer record for it.
  await db.BuyerActivity.updateOne({ wallet: p.recipient }, { $inc: { rewardsReceived: p.amount, roundsWon: 1 } }, { upsert: p.kind !== "holder", session });
}

/**
 * U2 recovery for legacy / partially completed rows: confirmed or failed payouts whose ledger
 * effects were not applied atomically (`ledgerApplied` not true). Idempotent — each row is repaired
 * under a CAS on `ledgerApplied` inside a transaction, so concurrent repairs or retries never
 * duplicate a ledger entry or a statistics increment.
 *   - confirmed, PAYOUT_CONFIRMED missing → write it + buyer statistics.
 *   - confirmed, PAYOUT_CONFIRMED present (legacy write order: ledger then stats) → only mark
 *     applied; statistics are display-only and cannot be proven missing, so they are left as is.
 *   - failed, PAYOUT_FAILED missing → write it.
 */
export async function repairPayoutLedger(db: Models): Promise<{ repaired: number; marked: number }> {
  let repaired = 0;
  let marked = 0;
  const rows: any[] = await db.Payout.find({ state: { $in: ["confirmed", "failed"] }, ledgerApplied: { $ne: true } }).limit(500).lean();
  for (const p of rows) {
    const key = p.state === "confirmed" ? `PAYOUT_CONFIRMED:${String(p._id)}` : `PAYOUT_FAILED:${String(p._id)}`;
    await inTransaction(db, async (session) => {
      const cas = await db.Payout.updateOne({ _id: p._id, state: p.state, ledgerApplied: { $ne: true } }, { $set: { ledgerApplied: true } }, { session });
      if (!cas.modifiedCount) return;
      const exists = await db.LedgerEntry.exists({ key }).session(session);
      if (exists) {
        marked++;
        return;
      }
      if (p.state === "confirmed") await applyConfirmedLedger(db, p, p.confirmedSignature, session);
      else await db.LedgerEntry.updateOne({ key }, { $setOnInsert: { key, type: "PAYOUT_FAILED", roundNumber: p.roundNumber, amount: p.amount, mint: p.mint, payoutId: p._id, memo: p.lastError ?? "failed" } }, { upsert: true, session });
      repaired++;
    });
  }
  return { repaired, marked };
}
