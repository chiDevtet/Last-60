/**
 * Idempotent ingestion of one transaction. Safe to call any number of times, from any process,
 * in any order: swaps are keyed by (signature, eventIndex) and claims by signature, written with
 * $setOnInsert upserts. Side effects (terminal lines, buyer stats) happen only for the writer
 * that actually inserted the row, so they also happen exactly once.
 */
import type { Models } from "../db/models";
import { dec } from "../db/decimal";
import { normalizeTransaction } from "../chain/tx";
import type { LaunchProvider } from "../providers/LaunchProvider";
import type { TerminalWriter } from "../terminal/terminal";
import { rootLogger, type Logger } from "../util/logger";

export interface IngestContext {
  db: Models;
  provider: LaunchProvider;
  terminal?: TerminalWriter;
  minBuyQuote: bigint;
  log?: Logger;
}

export interface IngestResult {
  signature: string;
  swaps: number;
  newSwaps: number;
  newClaims: number;
  anomalies: string[];
}

export async function ingestRawTransaction(ctx: IngestContext, raw: any, opts: { source: "indexer" | "catchup" | "backfill"; commitment: "confirmed" | "finalized" }): Promise<IngestResult> {
  const log = ctx.log ?? rootLogger().child({ component: "ingest" });
  const tx = normalizeTransaction(raw);
  const result: IngestResult = { signature: tx.signature, swaps: 0, newSwaps: 0, newClaims: 0, anomalies: [] };
  if (tx.err) return result; // failed transactions never count
  const info = ctx.provider.info();
  const parsed = ctx.provider.parseTransaction(tx);
  result.anomalies = parsed.anomalies;
  result.swaps = parsed.swaps.length;
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;

  if (parsed.swaps.length) {
    const ops = parsed.swaps.map((s) => ({
      updateOne: {
        filter: { signature: s.signature, eventIndex: s.eventIndex },
        update: {
          $setOnInsert: {
            signature: s.signature,
            eventIndex: s.eventIndex,
            provider: info.provider,
            pool: info.poolAddress,
            tokenMint: info.tokenMint,
            quoteMint: info.quoteMint,
            side: s.side,
            trader: s.trader,
            traderSource: s.traderSource,
            quoteAmount: dec(s.quoteAmount),
            baseAmount: dec(s.baseAmount),
            totalFee: dec(s.totalFee),
            eligibleFee: dec(s.eligibleFee),
            eligibleFeeMint: s.eligibleFeeMint,
            slot: s.slot,
            orderInSlot: s.eventIndex,
            blockTime,
            commitment: opts.commitment,
            status: "active",
            roundNumber: null,
            source: opts.source,
            ingestedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
    const res = await ctx.db.Swap.bulkWrite(ops, { ordered: false });
    const inserted = new Set(Object.keys(res.upsertedIds ?? {}).map(Number));
    result.newSwaps = inserted.size;
    if (opts.commitment === "finalized" && inserted.size < parsed.swaps.length) {
      await ctx.db.Swap.updateMany({ signature: tx.signature, commitment: "confirmed" }, { $set: { commitment: "finalized", status: "active" } });
    }
    for (const idx of inserted) {
      const s = parsed.swaps[idx]!;
      if (s.side !== "buy") continue;
      const qualifies = s.quoteAmount >= ctx.minBuyQuote;
      await ctx.db.BuyerActivity.updateOne(
        { wallet: s.trader },
        {
          $setOnInsert: { firstBuyAt: blockTime ?? new Date() },
          $max: { lastBuyAt: blockTime ?? new Date(), ...(qualifies ? { lastQualifyingBuyAt: blockTime ?? new Date() } : {}) },
          $inc: { buyCount: 1, qualifyingBuyCount: qualifies ? 1 : 0, totalQuoteSpent: dec(s.quoteAmount) },
          ...(qualifies ? { $set: { lastQualifyingSignature: s.signature } } : {}),
        },
        { upsert: true },
      );
      await ctx.terminal?.buy({ wallet: s.trader, quoteAmount: s.quoteAmount, signature: s.signature, eventIndex: s.eventIndex, qualifies });
    }
  }

  for (const c of parsed.claims) {
    const r = await ctx.db.FeeClaim.updateOne(
      { signature: c.signature },
      {
        $setOnInsert: {
          signature: c.signature,
          provider: info.provider,
          pool: info.poolAddress,
          role: info.feeBeneficiaryRole,
          claimer: c.claimer,
          quoteMint: info.quoteMint,
          quoteAmount: dec(c.quoteAmount),
          baseAmount: dec(c.baseAmount),
          slot: c.slot,
          blockTime: c.blockTime ? new Date(c.blockTime * 1000) : null,
          source: "external",
          status: "confirmed",
        },
      },
      { upsert: true },
    );
    // An auto-claim row may already exist as "submitted"; the chain has now confirmed it.
    if (!r.upsertedCount) await ctx.db.FeeClaim.updateOne({ signature: c.signature, status: "submitted" }, { $set: { status: "confirmed", quoteAmount: dec(c.quoteAmount), baseAmount: dec(c.baseAmount), slot: c.slot } });
    await ctx.db.LedgerEntry.updateOne(
      { key: `FEE_CLAIMED:${c.signature}` },
      { $setOnInsert: { key: `FEE_CLAIMED:${c.signature}`, type: "FEE_CLAIMED", amount: dec(c.quoteAmount), mint: info.quoteMint, signature: c.signature, memo: `claimed by ${c.claimer}` } },
      { upsert: true },
    );
    if (r.upsertedCount) result.newClaims++;
  }

  if (parsed.anomalies.length) {
    log.warn({ signature: tx.signature, anomalies: parsed.anomalies }, "unrecognised program activity on the pool");
    await ctx.terminal?.warn(`Unrecognised pool activity in ${tx.signature.slice(0, 8)}… flagged for review (not counted).`, `anomaly:${tx.signature}`);
  }
  return result;
}
