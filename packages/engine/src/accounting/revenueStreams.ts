/**
 * Phase-aware revenue attribution and Last-60 buyer-reward funding (pure; no I/O).
 *
 * The approved Forge business model defines seven economically different streams. They are NEVER
 * collapsed into one "creator fee" total:
 *
 *   phase           stream                                      allocation of   paid to   reward funding?
 *   bonding_curve   bonding_curve_creator_fee                   (gross)         creator   no  (gross collection, 0.50 % of volume)
 *   bonding_curve   bonding_curve_creator_retained              creator 25 %    creator   no  (developer revenue; derived)
 *   bonding_curve   bonding_curve_last60_reward_contribution    creator 75 %    Last-60   YES (observed transfer only)
 *   post_migration  cpmm_creator_trading_fee                    creator 100 %   creator   no  (developer revenue; never funding)
 *   post_migration  forge_platform_lp_fee_collection            (gross)         Forge     no  (Forge-owned Fee Key, gross claim)
 *   post_migration  forge_platform_lp_last60_contribution       creator 50 %    Last-60   YES (the CREATOR'S allocation of Forge's
 *                                                                                              LP claims, dedicated to buyer rewards;
 *                                                                                              observed transfer only)
 *   post_migration  forge_platform_lp_retained                  Forge 50 %      Forge     no  (derived: gross − contribution)
 *
 * The creator's 50 % LP allocation is NOT the creator's native CPMM creator fee and NOT personal
 * developer revenue: Forge holds it (it claims the platform-owned Fee Key) and must route it to the
 * Last-60 funding destination. It is attributed to the launch creator (`allocationOwner: creator`),
 * custodied by Forge until transferred, and funds buyer rewards only once that transfer is observed.
 *
 * A fee RATE (bonding-curve creator fee 0.50 % of volume, CPMM creator fee 0.05 % of volume) says
 * how much is charged per trade. An ALLOCATION percentage (75 % / 50 %) is applied to fees ACTUALLY
 * COLLECTED. Neither a rate nor a percentage is evidence that anything was collected or transferred:
 * the expected split computed here is a validation target, and only an observed, correlated transfer
 * into a configured Last-60 funding destination funds buyer rewards — capped at the policy amount.
 */
import { createHash } from "node:crypto";
import type { FeeEvidenceStatus } from "./attribution";

export const REVENUE_STREAMS = [
  "bonding_curve_creator_fee",
  "bonding_curve_creator_retained",
  "bonding_curve_last60_reward_contribution",
  "cpmm_creator_trading_fee",
  "forge_platform_lp_fee_collection",
  "forge_platform_lp_last60_contribution",
  "forge_platform_lp_retained",
] as const;
export type RevenueStream = (typeof REVENUE_STREAMS)[number];
export type LaunchPhase = "bonding_curve" | "post_migration";
/** Streams that are observed collections (a durable claim record is created for each). */
export type CollectionStream = "bonding_curve_creator_fee" | "cpmm_creator_trading_fee" | "forge_platform_lp_fee_collection";
/** Streams that can fund Last-60 buyer rewards. */
export type ContributionStream = "bonding_curve_last60_reward_contribution" | "forge_platform_lp_last60_contribution";

export interface StreamInfo {
  phase: LaunchPhase;
  kind: "collection" | "contribution" | "retained";
  /** Who finally receives the amount. */
  beneficiary: "creator" | "forge" | "last60";
  /**
   * Whose ALLOCATION the amount is under the approved model (null for gross collections). Both
   * Last-60 contributions are creator allocations: 75 % of the creator's collected bonding-curve fee,
   * and the creator's 50 % allocation of Forge's platform LP claims.
   */
  allocationOwner: "creator" | "forge" | null;
  /** Wallet that holds the amount right after the on-chain claim (before any distribution). */
  custodian: "creator" | "forge";
  /** Whether verified, reconciled amounts of this stream may fund buyer rewards. */
  rewardEligible: boolean;
  label: string;
}

export const STREAM_INFO: Record<RevenueStream, StreamInfo> = {
  bonding_curve_creator_fee: { phase: "bonding_curve", kind: "collection", beneficiary: "creator", allocationOwner: null, custodian: "creator", rewardEligible: false, label: "Bonding-curve creator fee collected (gross, 0.50 % of volume)" },
  bonding_curve_creator_retained: { phase: "bonding_curve", kind: "retained", beneficiary: "creator", allocationOwner: "creator", custodian: "creator", rewardEligible: false, label: "Bonding-curve creator fee retained by the creator (25 %, developer revenue)" },
  bonding_curve_last60_reward_contribution: { phase: "bonding_curve", kind: "contribution", beneficiary: "last60", allocationOwner: "creator", custodian: "creator", rewardEligible: true, label: "Bonding-curve creator fee → Last-60 buyer rewards (75 %)" },
  cpmm_creator_trading_fee: { phase: "post_migration", kind: "collection", beneficiary: "creator", allocationOwner: "creator", custodian: "creator", rewardEligible: false, label: "CPMM creator trading fee (0.05 % of volume, developer revenue, never Last-60)" },
  forge_platform_lp_fee_collection: { phase: "post_migration", kind: "collection", beneficiary: "forge", allocationOwner: null, custodian: "forge", rewardEligible: false, label: "Forge platform Fee Key LP fees claimed (gross)" },
  forge_platform_lp_last60_contribution: { phase: "post_migration", kind: "contribution", beneficiary: "last60", allocationOwner: "creator", custodian: "forge", rewardEligible: true, label: "Creator's 50 % allocation of Forge LP fees → Last-60 buyer rewards" },
  forge_platform_lp_retained: { phase: "post_migration", kind: "retained", beneficiary: "forge", allocationOwner: "forge", custodian: "forge", rewardEligible: false, label: "Forge platform LP fees retained by Forge (50 %)" },
};

/** The contribution / retained streams that belong to a collection stream (null: no split). */
export const SPLIT_OF: Record<CollectionStream, { contribution: ContributionStream; retained: RevenueStream } | null> = {
  bonding_curve_creator_fee: { contribution: "bonding_curve_last60_reward_contribution", retained: "bonding_curve_creator_retained" },
  forge_platform_lp_fee_collection: { contribution: "forge_platform_lp_last60_contribution", retained: "forge_platform_lp_retained" },
  cpmm_creator_trading_fee: null, // never shared with Last-60 and never part of the Forge LP split
};

// ── versioned reward-funding policy ─────────────────────────────────────────────────────────

/**
 * legacy_creator_fee_v1  — behaviour of PR #3–#5: a round's reward is REWARD_PERCENTAGE of the
 *                          verified creator-allocated fees of its period. Contributions are recorded
 *                          and reported but never fund rounds.
 * forge_phase_aware_v1   — PR #6's first phase-aware policy. RETIRED: it treated the Forge LP 50 % as a
 *                          Forge-funded contribution with no creator attribution, let the split
 *                          percentages be reconfigured, made amount-free `exclusive_window` links payable
 *                          and did not require the CLAIM transaction to be finalized. Kept only so stored
 *                          snapshots stay readable; it can no longer be selected, and its credits are
 *                          never consumable.
 * forge_phase_aware_v2   — the APPROVED model: rounds are funded ONLY by verified, finalized, correlated
 *                          (same transaction or `last60:v1` memo) contribution transfers — 75 % of each
 *                          collected bonding-curve creator fee and the creator's 50 % allocation of each
 *                          Forge platform LP claim. The shares are fixed (7 500 / 5 000 bps). REWARD_PERCENTAGE
 *                          is NOT applied to them (they already are the reward share); creator-allocated
 *                          fees of slots after the activation slot are recorded and reported but no longer
 *                          distributed, so the same economic value is never counted twice.
 */
export type FundingPolicyVersion = "legacy_creator_fee_v1" | "forge_phase_aware_v1" | "forge_phase_aware_v2";
export const FUNDING_POLICY_VERSIONS: readonly FundingPolicyVersion[] = ["legacy_creator_fee_v1", "forge_phase_aware_v1", "forge_phase_aware_v2"];
/** The only phase-aware version that can be configured and whose credits can fund rounds. */
export const CURRENT_PHASE_AWARE_VERSION = "forge_phase_aware_v2" as const;
export const isPhaseAwareVersion = (v: FundingPolicyVersion): boolean => v === "forge_phase_aware_v1" || v === "forge_phase_aware_v2";

export interface FundingPolicy {
  /** Stable id: hash of the version and every parameter (same id = same policy). */
  id: string;
  version: FundingPolicyVersion;
  /** Phase-aware policy is in force for slots strictly after this slot (null for legacy). */
  activationSlot: number | null;
  /** Share of each COLLECTED bonding-curve creator fee that funds Last-60 (bps). Creator keeps the rest. */
  bondingCreatorFeeLast60Bps: number;
  /** Share of each COLLECTED Forge platform LP fee claim that funds Last-60 (bps). Forge keeps the rest. */
  forgeLpLast60Bps: number;
}

export function makeFundingPolicy(p: Omit<FundingPolicy, "id">): FundingPolicy {
  for (const [k, v] of [["bondingCreatorFeeLast60Bps", p.bondingCreatorFeeLast60Bps], ["forgeLpLast60Bps", p.forgeLpLast60Bps]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`funding policy ${k} must be an integer in [0, 10000], got ${v}`);
  }
  if (isPhaseAwareVersion(p.version) && (p.activationSlot === null || !Number.isInteger(p.activationSlot) || p.activationSlot < 0)) throw new Error(`${p.version} requires a non-negative integer activation slot`);
  if (p.version === "forge_phase_aware_v2" && (p.bondingCreatorFeeLast60Bps !== APPROVED_SHARES.bondingCreatorFeeLast60Bps || p.forgeLpLast60Bps !== APPROVED_SHARES.forgeLpLast60Bps)) {
    throw new Error(`forge_phase_aware_v2 implements the approved model only: bonding 75 % (7500 bps) and Forge LP creator allocation 50 % (5000 bps); got ${p.bondingCreatorFeeLast60Bps} / ${p.forgeLpLast60Bps}`);
  }
  const canon = JSON.stringify([p.version, p.activationSlot, p.bondingCreatorFeeLast60Bps, p.forgeLpLast60Bps]);
  return { ...p, id: createHash("sha256").update(canon).digest("hex").slice(0, 24) };
}

/**
 * The approved economic model (fixed; not configurable under forge_phase_aware_v2):
 *   bonding curve  — of each COLLECTED creator fee: 75 % Last-60 buyer rewards, 25 % creator;
 *   post-migration — of each CLAIMED Forge platform LP fee: 50 % creator allocation → Last-60, 50 % Forge.
 */
export const APPROVED_SHARES = { bondingCreatorFeeLast60Bps: 7_500, forgeLpLast60Bps: 5_000 } as const;
/** @deprecated name kept for callers of PR #6; identical to APPROVED_SHARES. */
export const FORGE_POLICY_DEFAULTS = APPROVED_SHARES;
/** Approved fee RATES (charged per trade, millionths of volume). Rates are context, never evidence of collection. */
export const APPROVED_FEE_RATES = { bondingCreatorFeeRate: 5_000, cpmmCreatorFeeRate: 500 } as const;

export function policyLast60Bps(policy: FundingPolicy, stream: CollectionStream): number | null {
  if (stream === "bonding_curve_creator_fee") return policy.bondingCreatorFeeLast60Bps;
  if (stream === "forge_platform_lp_fee_collection") return policy.forgeLpLast60Bps;
  return null;
}

/** Immutable policy snapshot stored with every funding credit and reconciliation. */
export interface PolicySnapshot {
  v: 1;
  id: string;
  version: FundingPolicyVersion;
  activationSlot: number | null;
  bondingCreatorFeeLast60Bps: number;
  forgeLpLast60Bps: number;
}
export function policySnapshot(p: FundingPolicy): PolicySnapshot {
  return { v: 1, id: p.id, version: p.version, activationSlot: p.activationSlot, bondingCreatorFeeLast60Bps: p.bondingCreatorFeeLast60Bps, forgeLpLast60Bps: p.forgeLpLast60Bps };
}

/**
 * Whether a round with this snapshot slot is governed by the phase-aware policy. Only the current
 * (approved) version can be in force; a retired v1 policy object never funds a round.
 */
export function phaseAwareInForce(policy: FundingPolicy, snapshotSlot: number): boolean {
  return policy.version === CURRENT_PHASE_AWARE_VERSION && policy.activationSlot !== null && snapshotSlot > policy.activationSlot;
}

/**
 * Correlation methods whose links may fund rewards under the approved policy. `exclusive_window`
 * links by position, not by evidence naming the claim: it is recorded for reconciliation but never
 * payable (a Forge wallet that also pays out other streams could otherwise be credited for them).
 */
export const PAYABLE_CORRELATION_METHODS: readonly CorrelationMethod[] = ["same_transaction", "memo"];

// ── deterministic split ─────────────────────────────────────────────────────────────────────

/**
 * Expected split of an ACTUAL collected amount (integer base units of the fee mint; decimals never
 * enter integer arithmetic). The Last-60 contribution rounds DOWN; the rounding residual stays with
 * the retaining party (creator / Forge). Same rounding as Forgepad's claimer (`Math.floor(x × 0.5)`).
 */
export function expectedSplit(gross: bigint, last60Bps: number): { last60: bigint; retained: bigint } {
  if (gross < 0n) throw new Error("expectedSplit: negative amount");
  if (!Number.isInteger(last60Bps) || last60Bps < 0 || last60Bps > 10_000) throw new Error("expectedSplit: bps out of range");
  const last60 = (gross * BigInt(last60Bps)) / 10_000n;
  return { last60, retained: gross - last60 };
}

// ── assets ──────────────────────────────────────────────────────────────────────────────────

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Pseudo-mint for native lamport transfers (System Program). */
export const NATIVE_SOL = "native:SOL";

/**
 * Accounting asset of a mint. The ONLY equivalence: native SOL ⇄ wrapped SOL (the SPL Token native
 * mint, redeemable 1:1 by closing the account — a protocol guarantee, not a market conversion).
 * Every other mint is its own asset; USD1 → SOL via a swap (as Forgepad's claimer does for
 * USD1-quoted pools) is a market conversion and is never treated as equivalent.
 */
export function assetOf(mint: string): string {
  return mint === NATIVE_SOL || mint === WSOL_MINT ? WSOL_MINT : mint;
}

// ── correlation memo ────────────────────────────────────────────────────────────────────────

/**
 * Optional explicit link from a distribution transaction to its claim, carried in an SPL Memo:
 *   last60:v1:<claim transaction signature>
 * Needed only when the distribution is a SEPARATE transaction (Forgepad-side change, see
 * docs/REWARD_FUNDING.md). A claim and distribution in ONE transaction need no memo.
 */
export const FUNDING_MEMO_PREFIX = "last60:v1:";
export function parseFundingMemo(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith(FUNDING_MEMO_PREFIX)) return null;
  const sig = t.slice(FUNDING_MEMO_PREFIX.length).trim();
  return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig) ? sig : null;
}

// ── claim ↔ transfer correlation ────────────────────────────────────────────────────────────

export interface CollectionFact {
  /** Durable claim / correlation id (the collection event key). */
  key: string;
  stream: CollectionStream;
  signature: string;
  slot: number;
  /** Instruction ordinal of the collection inside its transaction. */
  ordinal: number;
  asset: string;
  /** Wallet that received the collected fees (must be the verified beneficiary to be creditable). */
  recipient: string;
  gross: bigint;
  /** Expected Last-60 contribution under the policy; null for streams without a split. */
  expectedLast60: bigint | null;
  /** Amount already linked from earlier transfers (valid ones). */
  linked: bigint;
  /** Whether the collection itself is verified (source, beneficiary, final status). */
  verified: boolean;
}

export interface TransferFact {
  key: string;
  signature: string;
  slot: number;
  ordinal: number;
  asset: string;
  /** Owner wallet the funds left (system account for native SOL, token-account owner for SPL). */
  sourceOwner: string;
  /** Configured Last-60 funding destination the funds reached. */
  destinationOwner: string;
  amount: bigint;
  /** Claim signature named by a `last60:v1:` memo in the same transaction, if any. */
  memoClaimSignature: string | null;
}

export type CorrelationMethod = "same_transaction" | "memo" | "exclusive_window";
export type FundingCorrelationMode = "strict" | "exclusive_window";

export type CorrelationResult =
  | { linked: true; collectionKey: string; method: CorrelationMethod }
  | { linked: false; reason: string };

/**
 * Pure: link a funding transfer to the collection it distributes. Never by amount alone.
 *   1. same_transaction — a collection in the SAME transaction, earlier in execution order, whose
 *      recipient is the transfer's source, same asset;
 *   2. memo — the transaction carries `last60:v1:<claim signature>` naming a collection with the same
 *      recipient and asset, not later than the transfer;
 *   3. exclusive_window (opt-in, FUNDING_CORRELATION_MODE=exclusive_window) — exactly one candidate:
 *      the LATEST collection from that source/asset before the transfer, still under-funded, and the
 *      transfer does not exceed its remaining expected amount. Any ambiguity → unlinked.
 * Collections with no split (CPMM creator fees) are never candidates.
 */
export function correlateTransfer(t: TransferFact, collections: CollectionFact[], mode: FundingCorrelationMode): CorrelationResult {
  const splittable = collections.filter((c) => c.expectedLast60 !== null && SPLIT_OF[c.stream] !== null);
  const sameTx = splittable.filter((c) => c.signature === t.signature && c.ordinal < t.ordinal && c.recipient === t.sourceOwner && c.asset === t.asset);
  if (sameTx.length === 1) return { linked: true, collectionKey: sameTx[0]!.key, method: "same_transaction" };
  if (sameTx.length > 1) {
    // Several collections then one transfer in the same tx: link to the nearest preceding one only if
    // it is the only under-funded one; otherwise ambiguous.
    const open = sameTx.filter((c) => c.linked < (c.expectedLast60 ?? 0n));
    if (open.length === 1) return { linked: true, collectionKey: open[0]!.key, method: "same_transaction" };
    return { linked: false, reason: "ambiguous_same_transaction_collections" };
  }
  if (t.memoClaimSignature) {
    const named = splittable.filter((c) => c.signature === t.memoClaimSignature);
    if (!named.length) return { linked: false, reason: "memo_names_unknown_claim" };
    const ok = named.filter((c) => c.recipient === t.sourceOwner && c.asset === t.asset && c.slot <= t.slot);
    if (ok.length === 1) return { linked: true, collectionKey: ok[0]!.key, method: "memo" };
    if (ok.length > 1) {
      const open = ok.filter((c) => c.linked < (c.expectedLast60 ?? 0n));
      if (open.length === 1) return { linked: true, collectionKey: open[0]!.key, method: "memo" };
      return { linked: false, reason: "ambiguous_memo_claim" };
    }
    return { linked: false, reason: named.some((c) => c.asset !== t.asset) ? "memo_claim_asset_mismatch" : named.some((c) => c.recipient !== t.sourceOwner) ? "memo_claim_source_mismatch" : "memo_claim_after_transfer" };
  }
  if (mode !== "exclusive_window") return { linked: false, reason: "uncorrelated_separate_transaction" };
  const fromSource = splittable.filter((c) => c.recipient === t.sourceOwner && c.asset === t.asset && (c.slot < t.slot || (c.signature === t.signature && c.ordinal < t.ordinal)));
  if (!fromSource.length) return { linked: false, reason: "no_preceding_collection_from_source" };
  const latest = fromSource.reduce((a, b) => (b.slot > a.slot || (b.slot === a.slot && b.ordinal > a.ordinal) ? b : a));
  const sameSlotLatest = fromSource.filter((c) => c.slot === latest.slot && c.signature !== latest.signature);
  if (sameSlotLatest.length) return { linked: false, reason: "ambiguous_window_same_slot" };
  const open = fromSource.filter((c) => c.linked < (c.expectedLast60 ?? 0n));
  if (open.length !== 1 || open[0]!.key !== latest.key) return { linked: false, reason: open.length > 1 ? "ambiguous_window_multiple_open_claims" : "window_latest_claim_not_open" };
  if (t.amount > (latest.expectedLast60 ?? 0n) - latest.linked) return { linked: false, reason: "window_transfer_exceeds_remaining_expected" };
  return { linked: true, collectionKey: latest.key, method: "exclusive_window" };
}

// ── reconciliation of one collection ────────────────────────────────────────────────────────

export type ReconciliationStatus = "awaiting_distribution" | "partial" | "reconciled" | "excess" | "unresolved" | "not_applicable";

export interface LinkedTransfer {
  key: string;
  amount: bigint;
  slot: number;
  ordinal: number;
}

export interface CreditDecision {
  transferKey: string;
  /** Observed amount of the transfer. */
  observed: bigint;
  /** Portion that is supported by the policy (≤ remaining expected) and may fund rewards. */
  creditable: bigint;
  /** Portion above the policy amount: recorded, never payable. */
  excess: bigint;
}

export interface CollectionReconciliation {
  status: ReconciliationStatus;
  gross: bigint;
  expectedLast60: bigint;
  expectedRetained: bigint;
  actualLast60: bigint;
  creditable: bigint;
  excess: bigint;
  untransferred: bigint;
  /** gross − observed Last-60 transfers: what the retaining party kept, implied (not independently observed). */
  impliedRetained: bigint;
  credits: CreditDecision[];
  discrepancies: string[];
}

/**
 * Pure: reconcile one collection against the transfers correlated to it (in chain order). The
 * observed transfers are the authority; the expected split only bounds what may be credited.
 * A collection that is not verified credits nothing (its transfers are recorded, never payable).
 */
export function reconcileCollection(c: Pick<CollectionFact, "gross" | "expectedLast60" | "verified">, transfers: LinkedTransfer[]): CollectionReconciliation {
  const expectedLast60 = c.expectedLast60 ?? 0n;
  const expectedRetained = c.gross - expectedLast60;
  const ordered = [...transfers].sort((a, b) => a.slot - b.slot || a.ordinal - b.ordinal || (a.key < b.key ? -1 : 1));
  let remaining = c.verified ? expectedLast60 : 0n;
  let actual = 0n;
  let creditable = 0n;
  let excess = 0n;
  const credits: CreditDecision[] = [];
  for (const t of ordered) {
    actual += t.amount;
    const cr = t.amount < remaining ? t.amount : remaining;
    remaining -= cr;
    creditable += cr;
    const ex = c.verified ? t.amount - cr : 0n;
    excess += ex;
    credits.push({ transferKey: t.key, observed: t.amount, creditable: cr, excess: ex });
  }
  const discrepancies: string[] = [];
  let status: ReconciliationStatus;
  if (c.expectedLast60 === null) status = "not_applicable";
  else if (!c.verified) {
    status = "unresolved";
    discrepancies.push("collection_not_verified");
  } else if (actual === 0n) status = expectedLast60 === 0n ? "reconciled" : "awaiting_distribution";
  else if (actual < expectedLast60) {
    status = "partial";
    discrepancies.push(`partial_distribution: ${actual} of ${expectedLast60} expected`);
  } else if (actual === expectedLast60) status = "reconciled";
  else {
    status = "excess";
    discrepancies.push(`excess_over_policy: ${actual} observed, ${expectedLast60} expected; ${actual - expectedLast60} never payable`);
  }
  const untransferred = expectedLast60 > actual ? expectedLast60 - actual : 0n;
  return { status, gross: c.gross, expectedLast60, expectedRetained, actualLast60: actual, creditable, excess, untransferred, impliedRetained: c.gross - actual, credits, discrepancies };
}

/** Evidence statuses whose amounts are final (shared with the fee model). */
export const FINAL_STATUSES: readonly FeeEvidenceStatus[] = ["observed", "collected", "reconciled", "confirmed"];

/**
 * Immutable v1 snapshot of the basis an event / credit was recorded under: source stream, phase,
 * verified provider and pool, fee mint, beneficiaries, policy, effective fee configuration,
 * verification and problems. Written once ($setOnInsert) and protected by the model guards.
 */
export interface RevenueSnapshot {
  v: 1;
  stream: RevenueStream | "last60_funding_inflow";
  launchPhase: LaunchPhase | null;
  provider: string;
  sourcePool: string;
  pool: string;
  tokenMint: string;
  feeMint: string;
  beneficiaries: { creator: string | null; platform: string | null; last60Destinations: string[] };
  policy: PolicySnapshot;
  effectiveFeeConfig: Record<string, string | number | boolean | null>;
  verification: "verified" | "unverifiable" | "mismatch" | "not_declared";
  problems: string[];
}

// ── consumption guard: never more than the expected allocation per collection ────────────────

export interface CapCredit {
  key: string;
  collectionKey: string;
  creditable: bigint;
  slot: number;
  ordinal: number;
  /** Already consumed by a round (counts against the allocation, never re-consumed). */
  consumed: boolean;
}

/**
 * Pure: the defence-in-depth cap applied when a round consumes credits. Credits are written one per
 * inflow, each capped at the claim's remaining expected allocation at the time it was written; two
 * reconciliation passes running concurrently could each see the same remaining amount. Walking every
 * credit of a collection in chain order (consumed ones first count against the allocation) guarantees
 * that the sum ever consumed for one claim never exceeds its expected Last-60 allocation. A credit
 * that would exceed it — or whose claim has no reconciliation row — is not consumable.
 */
export function capCreditsPerCollection(credits: CapCredit[], expectedByCollection: Map<string, bigint>): { allowed: Set<string>; blocked: { key: string; collectionKey: string; reason: string }[] } {
  const allowed = new Set<string>();
  const blocked: { key: string; collectionKey: string; reason: string }[] = [];
  const byCol = new Map<string, CapCredit[]>();
  for (const c of credits) (byCol.get(c.collectionKey) ?? byCol.set(c.collectionKey, []).get(c.collectionKey)!).push(c);
  for (const [col, list] of byCol) {
    const expected = expectedByCollection.get(col);
    const ordered = [...list].sort((a, b) => Number(b.consumed) - Number(a.consumed) || a.slot - b.slot || a.ordinal - b.ordinal || (a.key < b.key ? -1 : 1));
    let remaining = expected ?? 0n;
    for (const c of ordered) {
      if (c.consumed) {
        remaining -= c.creditable;
        continue;
      }
      if (expected === undefined) blocked.push({ key: c.key, collectionKey: col, reason: "no_reconciliation_row_for_claim" });
      else if (c.creditable > remaining) blocked.push({ key: c.key, collectionKey: col, reason: `over_allocation_guard: ${c.creditable} > remaining ${remaining < 0n ? 0n : remaining} of ${expected}` });
      else {
        remaining -= c.creditable;
        allowed.add(c.key);
      }
    }
  }
  return { allowed, blocked };
}
