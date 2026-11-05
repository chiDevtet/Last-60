/**
 * Recipient selection: the most recent BUYER_COUNT unique wallets whose latest qualifying buy
 * lies in the round's reward period (previous snapshot slot, snapshot slot].
 *
 * Deterministic: depends only on indexed chain data and the snapshot slot. Each wallet appears
 * once, ranked by its most recent qualifying buy. When several wallets compete for the last
 * places inside the same slot, the block's own transaction order (getBlock signatures) decides;
 * if that is unavailable, signature order is the documented fallback.
 */
import { PublicKey } from "@solana/web3.js";
import type { ChainRpc } from "../chain/rpc";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";

export interface SelectionParams {
  /** The period's pool, or pools when the provider/pool was switched during the period. */
  pool: string | string[];
  afterSlot: number | null; // exclusive lower bound (previous snapshot slot)
  periodStartAt: Date | null; // used only when there is no previous snapshot
  snapshotSlot: number; // inclusive upper bound
  minBuyQuote: bigint;
  buyerCount: number;
  excluded: Set<string>;
}

export interface SelectedBuyer {
  wallet: string;
  signature: string;
  slot: number;
  quoteAmount: bigint;
  rank: number;
}

export interface SelectionResult {
  recipients: SelectedBuyer[];
  eligibleBuyerCount: number;
  tieBreak: "none" | "block_order" | "signature";
}

export function periodMatch(p: Pick<SelectionParams, "pool" | "afterSlot" | "periodStartAt" | "snapshotSlot">): Record<string, unknown> {
  const slot: Record<string, number> = { $lte: p.snapshotSlot };
  if (p.afterSlot !== null) slot.$gt = p.afterSlot;
  const m: Record<string, unknown> = { pool: Array.isArray(p.pool) ? { $in: p.pool } : p.pool, status: "active", slot };
  if (p.afterSlot === null && p.periodStartAt) m.blockTime = { $gte: p.periodStartAt };
  return m;
}

export async function selectRecipients(db: Models, rpc: ChainRpc | null, p: SelectionParams): Promise<SelectionResult> {
  const match = { ...periodMatch(p), side: "buy", quoteAmount: { $gte: dec(p.minBuyQuote) }, trader: { $nin: [...p.excluded] } };
  // Latest qualifying buy per wallet.
  const latest: any[] = await db.Swap.aggregate([
    { $match: match },
    { $sort: { slot: -1, orderInSlot: -1, signature: -1 } },
    { $group: { _id: "$trader", slot: { $first: "$slot" }, orderInSlot: { $first: "$orderInSlot" }, signature: { $first: "$signature" }, quoteAmount: { $first: "$quoteAmount" }, sigsInTopSlot: { $push: { slot: "$slot", signature: "$signature", orderInSlot: "$orderInSlot" } } } },
    { $sort: { slot: -1, orderInSlot: -1, _id: -1 } },
  ]).option({ allowDiskUse: true });

  const valid = latest.filter((r) => {
    try {
      return PublicKey.isOnCurve(new PublicKey(r._id).toBytes());
    } catch {
      return false;
    }
  });
  const eligibleBuyerCount = valid.length;
  let tieBreak: SelectionResult["tieBreak"] = "none";
  let ranked = valid;

  if (valid.length > p.buyerCount) {
    const boundarySlot = valid[p.buyerCount - 1]!.slot;
    const sameSlot = valid.filter((r) => r.slot === boundarySlot);
    const above = valid.filter((r) => r.slot > boundarySlot);
    if (sameSlot.length > 1 && above.length + sameSlot.length > p.buyerCount) {
      // Several wallets compete for the last places within one slot: use the block's tx order.
      const order = rpc ? await rpc.getBlockSignatures(boundarySlot).catch(() => null) : null;
      const posOf = (r: any) => {
        const sigs: string[] = r.sigsInTopSlot.filter((x: any) => x.slot === boundarySlot).map((x: any) => x.signature);
        return Math.max(...sigs.map((s) => (order ? order.indexOf(s) : -1)));
      };
      if (order && sameSlot.every((r) => posOf(r) >= 0)) {
        sameSlot.sort((a, b) => posOf(b) - posOf(a));
        tieBreak = "block_order";
      } else {
        sameSlot.sort((a, b) => (a.signature < b.signature ? 1 : -1));
        tieBreak = "signature";
      }
      ranked = [...above, ...sameSlot, ...valid.filter((r) => r.slot < boundarySlot)];
    }
  }

  return {
    recipients: ranked.slice(0, p.buyerCount).map((r, i) => ({ wallet: r._id, signature: r.signature, slot: r.slot, quoteAmount: big(r.quoteAmount), rank: i })),
    eligibleBuyerCount,
    tieBreak,
  };
}

/** Match for `fee_attributions` records of a period (checkpoints may have no block time). */
export function attributionPeriodMatch(p: Pick<SelectionParams, "pool" | "afterSlot" | "periodStartAt" | "snapshotSlot">): Record<string, unknown> {
  const slot: Record<string, number> = { $lte: p.snapshotSlot };
  if (p.afterSlot !== null) slot.$gt = p.afterSlot;
  const m: Record<string, unknown> = { pool: Array.isArray(p.pool) ? { $in: p.pool } : p.pool, slot };
  if (p.afterSlot === null && p.periodStartAt) m.$or = [{ blockTime: { $gte: p.periodStartAt } }, { blockTime: null }];
  return m;
}

export interface PeriodFees {
  /** Payout-eligible creator-allocated fees in the payout asset. */
  payout: bigint;
  /** Payout-eligible creator-allocated fees in other assets (recorded, never converted). */
  other: { mint: string; amount: bigint }[];
  /** Creator-allocated amounts that are NOT payout-eligible (unproven / mismatching basis), by mint and reason. */
  ineligible: { mint: string; amount: bigint; reason: string }[];
  /** Payout-asset eligible fees per phase. */
  byPhase: Record<string, string>;
  swaps: number;
  attributions: number;
}

/**
 * Σ creator-allocated fees in the period. Only records that are payout-eligible count towards the
 * distributable amount; gross pool fees are never used (only `eligibleFee` / `creatorAmount`).
 * Legacy swap rows written before attribution fields existed have no `payoutEligible` and count as
 * eligible (they were attributed with the same program formula).
 */
export async function periodFees(db: Models, p: Pick<SelectionParams, "pool" | "afterSlot" | "periodStartAt" | "snapshotSlot">, payoutMint: string): Promise<PeriodFees> {
  const [swapRows, attrRows]: [any[], any[]] = await Promise.all([
    db.Swap.aggregate([
      { $match: periodMatch(p) },
      { $group: { _id: { mint: "$eligibleFeeMint", eligible: { $ne: ["$payoutEligible", false] }, phase: { $ifNull: ["$feePhase", "bonding_curve"] }, reason: { $cond: [{ $eq: ["$payoutEligible", false] }, "$excludedReason", null] } }, total: { $sum: "$eligibleFee" }, n: { $sum: 1 } } },
    ]),
    db.FeeAttribution.aggregate([
      { $match: attributionPeriodMatch(p) },
      { $group: { _id: { mint: "$feeMint", eligible: "$payoutEligible", phase: "$phase", reason: { $cond: ["$payoutEligible", null, "$excludedReason"] } }, total: { $sum: "$creatorAmount" }, n: { $sum: 1 } } },
    ]),
  ]);
  let payout = 0n;
  const other = new Map<string, bigint>();
  const ineligible = new Map<string, { mint: string; amount: bigint; reason: string }>();
  const byPhase: Record<string, bigint> = {};
  let swaps = 0;
  let attributions = 0;
  const add = (r: any) => {
    const amount = big(r.total);
    if (amount <= 0n) return;
    const { mint, eligible, phase, reason } = r._id;
    if (!eligible) {
      const k = `${mint}|${reason ?? "unresolved"}`;
      const cur = ineligible.get(k) ?? { mint, amount: 0n, reason: reason ?? "unresolved" };
      cur.amount += amount;
      ineligible.set(k, cur);
    } else if (mint === payoutMint) {
      payout += amount;
      byPhase[phase] = (byPhase[phase] ?? 0n) + amount;
    } else other.set(mint, (other.get(mint) ?? 0n) + amount);
  };
  for (const r of swapRows) {
    swaps += r.n;
    add(r);
  }
  for (const r of attrRows) {
    attributions += r.n;
    add(r);
  }
  return {
    payout,
    other: [...other].map(([mint, amount]) => ({ mint, amount })),
    ineligible: [...ineligible.values()],
    byPhase: Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, v.toString()])),
    swaps,
    attributions,
  };
}
