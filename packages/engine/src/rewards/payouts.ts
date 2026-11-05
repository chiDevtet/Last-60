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
import type { AppConfig } from "../config/env";
import type { SettingsStore } from "../config/runtime";
import { RpcError, type ChainRpc } from "../chain/rpc";
import { buildPayoutTransaction } from "../chain/payoutTx";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
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
  payer: Keypair | null;
  terminal: TerminalWriter;
  clock: Clock;
  log?: Logger;
  tokenInfo?: (mint: string) => Promise<{ program: string; decimals: number }>;
}

const SIGNING_LOCK_MS = 30_000;
const REBROADCAST_MS = 2_000;
const TX_FEE_ESTIMATE = 10_000n; // base fee + priority headroom per payout

export class PayoutExecutor {
  private readonly log: Logger;
  constructor(private readonly d: PayoutDeps) {
    this.log = (d.log ?? rootLogger()).child({ component: "payouts" });
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
    if (!this.d.payer) throw new Error("live payout requested but no payout signing key is loaded");
    const settings = await this.d.settings.get();
    const payerPk = this.d.payer.publicKey.toBase58();
    if (settings.expectedPayoutPublicKey && settings.expectedPayoutPublicKey !== payerPk) {
      throw new Error(`payout key ${payerPk} does not match the configured payout public key ${settings.expectedPayoutPublicKey}; refusing to sign`);
    }
    const amount = big(p.amount);

    // Funds check: balance must cover this payout, everything in flight, fees and the reserve.
    if (p.mint === "So11111111111111111111111111111111111111112") {
      const [balance, inflight] = await Promise.all([this.d.rpc.getBalance(payerPk, "confirmed"), this.inflightTotal(p._id)]);
      const need = amount + inflight + TX_FEE_ESTIMATE + this.d.cfg.payout.minReserveLamports;
      if (balance < need) {
        await this.d.db.Payout.updateOne({ _id: p._id, state: "pending" }, { $set: { lastError: `insufficient payout wallet balance (have ${balance}, need ${need})`, nextAttemptAt: new Date(this.now() + 15_000) } });
        await this.d.db.Round.updateOne({ roundNumber: p.roundNumber, state: { $in: ["paying", "awaiting_funds"] } }, { $set: { state: "awaiting_funds" } });
        await this.d.terminal.warn(`Payout wallet balance is insufficient; round #${p.roundNumber} payouts are queued until it is funded.`, `funds:${p.roundNumber}:${Math.floor(this.now() / 600_000)}`, p.roundNumber);
        return false;
      }
    }

    // CAS pending → signing with a fresh fencing token.
    const token = randomToken(12);
    const claimed = await this.d.db.Payout.findOneAndUpdate(
      { _id: p._id, state: "pending" },
      { $set: { state: "signing", lock: { owner: this.d.cfg.instanceId, token, expiresAt: new Date(this.now() + SIGNING_LOCK_MS) } } },
      { returnDocument: "after" },
    ).lean();
    if (!claimed) return false;

    const { blockhash, lastValidBlockHeight } = await this.d.rpc.getLatestBlockhash("confirmed");
    const token2022 = p.mint !== "So11111111111111111111111111111111111111112" ? await this.d.tokenInfo?.(p.mint) : undefined;
    const built = buildPayoutTransaction({
      payer: this.d.payer,
      recipient: p.recipient,
      amount,
      mint: p.mint,
      blockhash,
      priorityFeeMicroLamports: this.d.cfg.payout.priorityFeeMicroLamports,
      computeUnitLimit: this.d.cfg.payout.computeUnitLimit,
      memo: this.d.cfg.payout.memo ? `last60:r${p.roundNumber}:${String(p._id)}` : null,
      token: token2022,
    });
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
    const [st] = await this.d.rpc.getSignatureStatuses([sig], true);
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
    // Unknown signature: has its blockhash expired at FINALIZED height?
    const finalizedHeight = await this.d.rpc.getBlockHeight("finalized");
    if (finalizedHeight > p.current.lastValidBlockHeight) {
      const [again] = await this.d.rpc.getSignatureStatuses([sig], true); // close the race
      if (!again) return this.retireAttempt(p._id, sig, "expired", "blockhash expired without the transaction landing");
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
    const res = await this.d.db.Payout.updateOne(
      { _id: payoutId, state: "submitted", "current.signature": signature },
      {
        $set: {
          state: exhausted ? "failed" : "pending",
          current: null,
          lastError: reason,
          nextAttemptAt: new Date(this.now() + backoffDelay(p.attemptCount ?? 0, { baseMs: 2000, maxMs: 60_000, jitter: false })),
          "attempts.$[a].outcome": outcome,
          "attempts.$[a].error": reason,
        },
      },
      { arrayFilters: [{ "a.signature": signature }] },
    );
    if (!res.modifiedCount) return false;
    this.log.warn({ payoutId: String(payoutId), signature, outcome, exhausted, reason }, "payout attempt retired");
    if (exhausted) {
      await this.d.db.LedgerEntry.updateOne({ key: `PAYOUT_FAILED:${String(payoutId)}` }, { $setOnInsert: { key: `PAYOUT_FAILED:${String(payoutId)}`, type: "PAYOUT_FAILED", roundNumber: p.roundNumber, amount: p.amount, mint: p.mint, payoutId, memo: reason } }, { upsert: true });
      await this.d.terminal.error(`Payout for round #${p.roundNumber} failed after ${p.attemptCount} attempts; queued for operator review (funds not sent).`, `payout-failed:${String(payoutId)}`, p.roundNumber);
    }
    return true;
  }

  private async confirm(p: any, signature: string, slot: number): Promise<boolean> {
    const res = await this.d.db.Payout.updateOne(
      { _id: p._id, state: "submitted", "current.signature": signature },
      { $set: { state: "confirmed", confirmedSignature: signature, confirmedSlot: slot, confirmedAt: new Date(this.now()), lastError: null, "attempts.$[a].outcome": "confirmed" } },
      { arrayFilters: [{ "a.signature": signature }] },
    );
    if (!res.modifiedCount) return false;
    await this.d.db.LedgerEntry.updateOne(
      { key: `PAYOUT_CONFIRMED:${String(p._id)}` },
      { $setOnInsert: { key: `PAYOUT_CONFIRMED:${String(p._id)}`, type: "PAYOUT_CONFIRMED", roundNumber: p.roundNumber, amount: p.amount, mint: p.mint, payoutId: p._id, signature, memo: p.recipient } },
      { upsert: true },
    );
    await this.d.db.BuyerActivity.updateOne({ wallet: p.recipient }, { $inc: { rewardsReceived: p.amount, roundsWon: 1 } }, { upsert: true });
    await this.d.terminal.payoutConfirmed(p.roundNumber, { recipient: p.recipient, amount: big(p.amount), signature, commitment: this.d.cfg.payout.commitment });
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
    await this.d.terminal.payoutSimulated(p.roundNumber, { recipient: p.recipient, amount: big(p.amount), payoutId: String(p._id) });
    return true;
  }

  private async inflightTotal(excludeId: unknown): Promise<bigint> {
    const r: any[] = await this.d.db.Payout.aggregate([{ $match: { state: { $in: ["signing", "submitted"] }, mode: "live", _id: { $ne: excludeId } } }, { $group: { _id: null, t: { $sum: "$amount" } } }]);
    return big(r[0]?.t ?? 0);
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
 * Requeue a `failed` payout (DB-only, usable from the admin API and CLI). A payout only reaches
 * `failed` after every attempt was proven dead (expired or failed at finalized), so retrying
 * cannot double pay.
 */
export async function requeueFailedPayout(db: Models, payoutId: string, actor: string, now = Date.now()): Promise<boolean> {
  const p: any = await db.Payout.findById(payoutId).lean();
  if (!p || p.state !== "failed") return false;
  const res = await db.Payout.updateOne({ _id: p._id, state: "failed" }, { $set: { state: "pending", attemptCount: 0, nextAttemptAt: new Date(now), lastError: `requeued by ${actor}` } });
  if (!res.modifiedCount) return false;
  await db.LedgerEntry.create({ key: `PAYOUT_REQUEUED:${payoutId}:${now}`, type: "PAYOUT_REQUEUED", roundNumber: p.roundNumber, amount: p.amount, mint: p.mint, payoutId: p._id, memo: `requeued by ${actor}` });
  await db.Round.updateOne({ roundNumber: p.roundNumber, state: "attention" }, { $set: { state: "paying" } });
  return true;
}
