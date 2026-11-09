/**
 * The public activity log ("terminal"). Every entry is produced by a real backend action at the
 * moment it happens. The writer only exposes typed, public-safe methods — there is deliberately
 * no method that could carry scheduler internals (execute time, delay, candidate list).
 */
import { formatSol, shortAddress, type TerminalEventDTO, type TerminalEventType } from "@last60/shared";
import type { Models } from "../db/models";
import { rootLogger } from "../util/logger";

type Details = Record<string, string | number | boolean | null>;

export class TerminalWriter {
  private readonly log = rootLogger().child({ component: "terminal" });
  constructor(
    private readonly db: Models,
    private readonly retentionDays = 30,
    private readonly asset = { symbol: "SOL", decimals: 9 },
  ) {}

  private fmt(v: bigint) {
    return this.asset.decimals === 9 ? formatSol(v, 6, 2) : v.toString();
  }

  private async write(type: TerminalEventType, message: string, o: { roundNumber?: number | null; signature?: string | null; details?: Details | null; dedupeKey?: string } = {}) {
    try {
      if (o.dedupeKey && (await this.db.TerminalEvent.exists({ dedupeKey: o.dedupeKey }))) return;
      const c: any = await this.db.Counter.findOneAndUpdate({ _id: "terminal" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" }).lean();
      const now = new Date();
      await this.db.TerminalEvent.create({
        seq: c.seq,
        ts: now,
        type,
        message,
        roundNumber: o.roundNumber ?? null,
        signature: o.signature ?? null,
        details: o.details ?? null,
        dedupeKey: o.dedupeKey ?? null,
        expiresAt: new Date(now.getTime() + this.retentionDays * 86_400_000),
      });
    } catch (err: any) {
      if (err?.code === 11000) return; // concurrent duplicate — fine
      this.log.warn({ err: String(err) }, "failed to write terminal event");
    }
  }

  roundInitialized(roundNumber: number) {
    return this.write("SYSTEM", `New reward round #${roundNumber} initialized.`, { roundNumber, dedupeKey: `round-init:${roundNumber}` });
  }
  monitoring(roundNumber: number, minBuy: bigint) {
    return this.write("INDEXER", `Monitoring qualifying buy transactions (min ${this.fmt(minBuy)} ${this.asset.symbol}).`, { roundNumber, dedupeKey: `monitor:${roundNumber}` });
  }
  buy(p: { wallet: string; quoteAmount: bigint; signature: string; eventIndex: number; qualifies: boolean }) {
    const msg = p.qualifies
      ? `Wallet ${shortAddress(p.wallet, 3, 3)} purchased ${this.fmt(p.quoteAmount)} ${this.asset.symbol}.`
      : `Wallet ${shortAddress(p.wallet, 3, 3)} purchased ${this.fmt(p.quoteAmount)} ${this.asset.symbol} (below minimum).`;
    return this.write("BUY", msg, { signature: p.signature, details: { wallet: p.wallet, amount: p.quoteAmount.toString(), qualifies: p.qualifies }, dedupeKey: `buy:${p.signature}:${p.eventIndex}` });
  }
  feesAccrued(p: { delta: bigint; periodTotal: bigint; bucket: string }) {
    return this.write("FEES", `${this.fmt(p.delta)} ${this.asset.symbol} accrued (current pool ${this.fmt(p.periodTotal)} ${this.asset.symbol}).`, { details: { delta: p.delta.toString(), periodTotal: p.periodTotal.toString() }, dedupeKey: `fees:${p.bucket}` });
  }
  processingStarted(roundNumber: number) {
    return this.write("SYSTEM", `Reward processing initiated for round #${roundNumber}.`, { roundNumber, dedupeKey: `processing:${roundNumber}` });
  }
  accounting(roundNumber: number, p: { fees: bigint; reward: bigint; retained: bigint; recipients: number; perRecipient: bigint; rolloverIn: bigint }) {
    const roll = p.rolloverIn > 0n ? ` incl. ${this.fmt(p.rolloverIn)} rolled over` : "";
    return this.write(
      "ACCOUNTING",
      `Fees ${this.fmt(p.fees)} → reward ${this.fmt(p.reward)}${roll}, retained ${this.fmt(p.retained)}. ${p.recipients} recipient(s) × ${this.fmt(p.perRecipient)} ${this.asset.symbol}.`,
      { roundNumber, details: { fees: p.fees.toString(), reward: p.reward.toString(), retained: p.retained.toString(), recipients: p.recipients, perRecipient: p.perRecipient.toString() }, dedupeKey: `accounting:${roundNumber}` },
    );
  }
  skipped(roundNumber: number, reason: string, rolled: bigint) {
    return this.write("ACCOUNTING", `Round #${roundNumber}: ${reason}. ${rolled > 0n ? `${this.fmt(rolled)} ${this.asset.symbol} carried to the next round.` : "No funds distributed."}`, { roundNumber, dedupeKey: `skipped:${roundNumber}` });
  }
  payoutSubmitted(roundNumber: number, signature: string, attempt: number) {
    return this.write("PAYOUT", `Transaction submitted.`, { roundNumber, signature, details: { attempt }, dedupeKey: `submitted:${signature}` });
  }
  payoutConfirmed(roundNumber: number, p: { recipient: string; amount: bigint; signature: string; commitment: string }) {
    return this.write("CONFIRMED", `${this.fmt(p.amount)} ${this.asset.symbol} distributed to ${shortAddress(p.recipient, 3, 3)}.`, { roundNumber, signature: p.signature, details: { recipient: p.recipient, amount: p.amount.toString(), commitment: p.commitment }, dedupeKey: `confirmed:${p.signature}` });
  }
  payoutSimulated(roundNumber: number, p: { recipient: string; amount: bigint; payoutId: string }) {
    return this.write("PAYOUT", `DRY-RUN: would distribute ${this.fmt(p.amount)} ${this.asset.symbol} to ${shortAddress(p.recipient, 3, 3)} (no transaction sent).`, { roundNumber, details: { recipient: p.recipient, amount: p.amount.toString(), dryRun: true }, dedupeKey: `simulated:${p.payoutId}` });
  }
  roundCompleted(roundNumber: number, paid: bigint, dryRun: boolean) {
    return this.write("SYSTEM", dryRun ? `Reward round #${roundNumber} completed (dry-run, nothing transferred).` : `Reward round #${roundNumber} completed. ${this.fmt(paid)} ${this.asset.symbol} paid.`, { roundNumber, dedupeKey: `completed:${roundNumber}` });
  }
  missed(roundNumber: number) {
    return this.write("WARN", `Round #${roundNumber} window missed (engine unavailable); its buys and fees carry into the next round.`, { roundNumber, dedupeKey: `missed:${roundNumber}` });
  }
  feeClaimed(amount: bigint, signature: string, into = "the payout wallet") {
    return this.write("FEES", `Collected ${this.fmt(amount)} ${this.asset.symbol} of trading fees into ${into}.`, { signature, dedupeKey: `claim:${signature}` });
  }
  warn(message: string, dedupeKey?: string, roundNumber?: number) {
    return this.write("WARN", message, { dedupeKey, roundNumber });
  }
  error(message: string, dedupeKey?: string, roundNumber?: number) {
    return this.write("ERROR", message, { dedupeKey, roundNumber });
  }
  system(message: string, dedupeKey?: string) {
    return this.write("SYSTEM", message, { dedupeKey });
  }
}

export function toTerminalDTO(e: any): TerminalEventDTO {
  return {
    seq: e.seq,
    ts: new Date(e.ts).toISOString(),
    type: e.type,
    message: e.message,
    roundNumber: e.roundNumber ?? null,
    signature: e.signature ?? null,
    details: e.details ?? null,
  };
}
