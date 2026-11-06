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
import { PAYABLE_STATUSES, SNAPSHOT_VERSION } from "../accounting/attribution";

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
 * Why a fee record is not distributable, as a MongoDB expression evaluated per record (null =
 * distributable). Order matters: the first failing rule names the reason.
 *   1. `payoutEligible = false` (decided at ingestion: unproven, mismatching, not the beneficiary's);
 *   2. evidence status not final (`estimated`, `unresolved` are never paid);
 *   3. no immutable v1 allocation snapshot (legacy rows cannot prove why they were eligible);
 *   4. allocation basis not VERIFIED against an operator declaration — unless its id is one of the
 *      bases the loaded provider verifies now (the id hashes provider/pool/phase/role/beneficiary and
 *      every on-chain parameter, so the same id is the same basis, now cross-checked).
 */
function ineligibleReasonExpr(statusField: "$feeStatus" | "$status", verifiedBasisIds: string[]) {
  return {
    $switch: {
      branches: [
        { case: { $eq: ["$payoutEligible", false] }, then: { $ifNull: ["$excludedReason", "unresolved"] } },
        { case: { $not: [{ $in: [{ $ifNull: [statusField, "observed"] }, [...PAYABLE_STATUSES]] }] }, then: { $concat: ["fee_status_", { $toString: statusField }] } },
        { case: { $ne: ["$basis.v", SNAPSHOT_VERSION] }, then: "legacy_record_without_allocation_snapshot" },
        {
          case: { $and: [{ $ne: ["$basis.verification", "verified"] }, { $not: [{ $in: ["$basisId", verifiedBasisIds] }] }] },
          then: { $concat: ["allocation_", { $ifNull: ["$basis.verification", "unknown"] }, "_not_verified"] },
        },
      ],
      default: null,
    },
  };
}

/**
 * Σ creator-allocated fees in the period. Only distributable records count towards the payout
 * amount (see `ineligibleReasonExpr`); everything else is reported per mint and reason. Gross pool
 * fees are never used (only `eligibleFee` / `creatorAmount`), and estimated amounts (e.g. CPMM
 * per-swap creator-fee accruals) are never summed.
 */
export async function periodFees(db: Models, p: Pick<SelectionParams, "pool" | "afterSlot" | "periodStartAt" | "snapshotSlot">, payoutMint: string, opts: { verifiedBasisIds?: Iterable<string> } = {}): Promise<PeriodFees> {
  const verified = [...new Set(opts.verifiedBasisIds ?? [])].sort();
  const [swapRows, attrRows]: [any[], any[]] = await Promise.all([
    db.Swap.aggregate([
      { $match: periodMatch(p) },
      { $addFields: { _reason: ineligibleReasonExpr("$feeStatus", verified) } },
      { $group: { _id: { mint: "$eligibleFeeMint", eligible: { $eq: ["$_reason", null] }, phase: { $ifNull: ["$feePhase", "bonding_curve"] }, reason: "$_reason" }, total: { $sum: "$eligibleFee" }, n: { $sum: 1 } } },
    ]),
    db.FeeAttribution.aggregate([
      { $match: attributionPeriodMatch(p) },
      { $addFields: { _reason: ineligibleReasonExpr("$status", verified) } },
      { $group: { _id: { mint: "$feeMint", eligible: { $eq: ["$_reason", null] }, phase: "$phase", reason: "$_reason" }, total: { $sum: "$creatorAmount" }, n: { $sum: 1 } } },
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
