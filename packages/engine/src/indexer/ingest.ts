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
import { basesOf, snapshotOf, type AllocationSnapshot, type NormalizedAttribution } from "../accounting/attribution";
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
  newAttributions?: number;
  anomalies: string[];
}

type BasisSource = Pick<ReturnType<LaunchProvider["info"]>, "allocation" | "destination" | "poolAddress">;

/** Reason recorded when a record names a basis the loaded provider cannot produce (fail closed). */
export const SNAPSHOT_UNAVAILABLE = "allocation_basis_snapshot_unavailable";

/**
 * The immutable allocation snapshot of a fee record: the full basis it was attributed under,
 * resolved from the loaded provider's bases by id. Null when the record names no basis or a basis
 * the provider does not have — such a record is stored as not payout-eligible.
 */
export function snapshotFor(info: BasisSource, basisId: string | null | undefined): AllocationSnapshot | null {
  if (!basisId) return null;
  const b = basesOf(info).get(basisId);
  return b ? snapshotOf(b, info.poolAddress) : null;
}

/**
 * Idempotently persist non-swap fee records (keyed). Existing records are never rewritten: the
 * first observation wins, so re-processing cannot double count or reinterpret history. Each new
 * record stores the immutable snapshot of the basis it was attributed under (`info` supplies the
 * bases); a record whose basis cannot be resolved is stored but never payable.
 */
export async function persistAttributions(db: Models, records: NormalizedAttribution[], info: BasisSource | null, extra: Record<string, unknown> = {}): Promise<number> {
  if (!records.length) return 0;
  const res = await db.FeeAttribution.bulkWrite(
    records.map((a) => {
      const basis = info ? snapshotFor(info, a.basisId) : null;
      const missing = !basis && a.payoutEligible;
      return {
      updateOne: {
        filter: { key: a.key },
        update: {
          $setOnInsert: {
            key: a.key,
            kind: a.kind,
            provider: a.provider,
            phase: a.phase,
            sourcePool: a.sourcePool,
            destinationPool: a.destinationPool,
            pool: a.destinationPool ?? a.sourcePool,
            beneficiary: a.beneficiary,
            feeMint: a.feeMint,
            grossAmount: a.grossAmount === null ? null : dec(a.grossAmount),
            creatorAmount: dec(a.creatorAmount),
            excludedAmount: dec(a.excludedAmount),
            excludedReason: missing ? SNAPSHOT_UNAVAILABLE : a.excludedReason,
            signature: a.signature,
            slot: a.slot,
            observedSlot: a.observedSlot ?? null,
            blockTime: a.blockTime ? new Date(a.blockTime * 1000) : null,
            evidence: a.evidence,
            status: missing ? "unresolved" : a.status,
            payoutEligible: a.payoutEligible && !missing,
            basisId: a.basisId,
            basis,
            cumulative: (a.evidence?.cumulative as string | undefined) ?? null,
            checkpointKey: (a.evidence?.checkpointKey as string | undefined) ?? null,
            createdAt: new Date(),
            ...extra,
          },
        },
        upsert: true,
      },
    };
    }),
    { ordered: false },
  );
  return res.upsertedCount ?? 0;
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
    const ops = parsed.swaps.map((s) => {
      const basisId = s.basisId ?? info.allocation?.id ?? null;
      const basis = snapshotFor(info, basisId);
      // A swap whose basis cannot be resolved is recorded (buyer tracking still works) but its fee
      // is never payable: without the basis there is no evidence of why it would be the creator's.
      const missing = !basis && (s.payoutEligible ?? true) && s.eligibleFee > 0n;
      return {
      updateOne: {
        filter: { signature: s.signature, eventIndex: s.eventIndex },
        update: {
          $setOnInsert: {
            signature: s.signature,
            eventIndex: s.eventIndex,
            provider: info.provider,
            pool: s.pool ?? info.poolAddress,
            sourcePool: info.poolAddress,
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
            // Attribution provenance. Written once ($setOnInsert): a later configuration change can
            // never reinterpret a historical record.
            feePhase: s.feePhase ?? "bonding_curve",
            excludedFee: dec(s.excludedFee ?? s.totalFee - s.eligibleFee),
            excludedReason: missing ? SNAPSHOT_UNAVAILABLE : (s.excludedReason ?? null),
            feeStatus: missing ? "unresolved" : (s.feeStatus ?? "observed"),
            payoutEligible: missing ? false : (s.payoutEligible ?? true),
            basisId,
            basis,
            beneficiary: info.beneficiary,
            evidence: s.evidence ?? null,
            estimatedCreatorFee: s.estimatedCreatorFee != null ? dec(s.estimatedCreatorFee) : null,
            slot: s.slot,
            orderInSlot: s.eventIndex, // event index inside the transaction (NOT the block position)
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
    };
    });
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

  for (let i = 0; i < parsed.claims.length; i++) {
    const c = parsed.claims[i]!;
    // Claims are keyed by (signature, position among the transaction's claims): one transaction can
    // carry several claims (e.g. two LP positions), and a single-claim transaction keeps index 0.
    const r = await ctx.db.FeeClaim.updateOne(
      { signature: c.signature, index: i },
      {
        $setOnInsert: {
          signature: c.signature,
          index: i,
          evidence: c.evidence ?? null,
          provider: info.provider,
          pool: c.pool ?? info.poolAddress,
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
    // An auto-claim row may already exist as "submitted" — or as "failed" when the broadcast
    // returned an ambiguous error (timeout) or confirmation was not observed before expiry, yet
    // the transaction landed. The chain is authoritative: an observed claim is confirmed. (Left
    // "failed", its amount would be missing from reconciliation and trip a false over-attribution
    // halt.)
    if (!r.upsertedCount) await ctx.db.FeeClaim.updateOne({ signature: c.signature, index: i, status: { $ne: "confirmed" } }, { $set: { status: "confirmed", quoteAmount: dec(c.quoteAmount), baseAmount: dec(c.baseAmount), slot: c.slot, blockTime: c.blockTime ? new Date(c.blockTime * 1000) : null }, $unset: { error: 1 } });
    const lk = i === 0 ? `FEE_CLAIMED:${c.signature}` : `FEE_CLAIMED:${c.signature}:${i}`;
    await ctx.db.LedgerEntry.updateOne({ key: lk }, { $setOnInsert: { key: lk, type: "FEE_CLAIMED", amount: dec(c.quoteAmount), mint: info.quoteMint, signature: c.signature, memo: `claimed by ${c.claimer}${c.pool && c.pool !== info.poolAddress ? ` (pool ${c.pool})` : ""}` } }, { upsert: true });
    if (r.upsertedCount) result.newClaims++;
  }

  if (parsed.attributions?.length) {
    result.newAttributions = await persistAttributions(ctx.db, parsed.attributions, info);
  }

  if (parsed.anomalies.length) {
    log.warn({ signature: tx.signature, anomalies: parsed.anomalies }, "unrecognised program activity on the pool");
    await ctx.terminal?.warn(`Unrecognised pool activity in ${tx.signature.slice(0, 8)}… flagged for review (not counted).`, `anomaly:${tx.signature}`);
  }
  return result;
}
