/**
 * Creator-fee attribution model, shared by every launch provider.
 *
 * LAST60 accounts ONLY for value that is allocated to the configured beneficiary (normally the token
 * creator) by on-chain configuration and position ownership. It never uses a pool's gross fees, the
 * protocol's / partner's / platform's share, or other LP holders' fees as a substitute.
 *
 * Every fee record — a decoded swap (`swaps`) or a non-swap attribution (`fee_attributions`: LP
 * position checkpoints, fee collections, shared-vault inflows of other pools) — carries the same
 * provenance fields, so for any amount one can answer: which chain/provider/pool, whose wallet,
 * which asset, which phase, gross vs. creator-allocated vs. excluded (and why), which transaction /
 * slot / account / instruction proved it, how certain it is, and whether it may be paid out.
 *
 * Fail-safe rule: an amount that cannot be proven from on-chain evidence is recorded as
 * `unresolved` and `payoutEligible = false`. It is never estimated into a payout.
 */
import { createHash } from "node:crypto";

export type FeePhase = "bonding_curve" | "post_migration_trading" | "migrated_lp";

/**
 * estimated  — derived from on-chain data but final amount is decided later on-chain (e.g. a share
 *              rate applied at collection); never payout-eligible.
 * observed   — exact per-event or per-checkpoint amount computed with the program's own formula.
 * collected  — exact amount moved to the beneficiary by a collection/claim instruction.
 * reconciled — observed amount later matched against the program's own counters.
 * confirmed  — observed/collected at finalized commitment.
 * unresolved — the allocation could not be proven (or contradicts the declared configuration).
 */
export type FeeEvidenceStatus = "estimated" | "observed" | "collected" | "reconciled" | "confirmed" | "unresolved";

export type AllocationVerification = "verified" | "mismatch" | "not_declared" | "unverifiable";

/**
 * The basis on which a fee was allocated: who the beneficiary was and which on-chain parameters
 * determined the split, read from which account at which slot. Stored (by id, plus a snapshot) with
 * every fee record so historical records keep the basis that applied when the fees were generated.
 */
export interface AllocationBasis {
  id: string;
  provider: string;
  pool: string;
  phase: FeePhase;
  role: string;
  beneficiary: string;
  /** On-chain parameters that determine the beneficiary's share (never an application default). */
  params: Record<string, string | number | boolean>;
  /** Account(s) the parameters were read from. */
  source: string;
  /** Result of comparing the on-chain allocation with the operator-declared expectation. */
  verification: AllocationVerification;
  problems: string[];
}

export function basisId(b: Omit<AllocationBasis, "id" | "verification" | "problems" | "source">): string {
  const canon = JSON.stringify([b.provider, b.pool, b.phase, b.role, b.beneficiary, Object.keys(b.params).sort().map((k) => [k, String(b.params[k])])]);
  return createHash("sha256").update(canon).digest("hex").slice(0, 24);
}

export function makeBasis(b: Omit<AllocationBasis, "id">): AllocationBasis {
  return { ...b, id: basisId(b) };
}

/** Whether fees allocated on this basis may be distributed. A mismatch / unverifiable basis never pays. */
export function basisPayable(b: Pick<AllocationBasis, "verification">): boolean {
  return b.verification === "verified" || b.verification === "not_declared";
}

/** A fee record that is not a decoded swap (LP checkpoint, collection, shared-vault inflow, claim). */
export interface NormalizedAttribution {
  /** Idempotency key, unique per economic fact. */
  key: string;
  kind: "position_checkpoint" | "creator_fee_collection" | "locked_lp_fee_collection" | "shared_vault_inflow" | "excluded";
  phase: FeePhase;
  provider: string;
  /** Bonding-curve pool the token launched on. */
  sourcePool: string;
  /** Post-graduation pool, when the record belongs to it. */
  destinationPool: string | null;
  /** Beneficiary wallet the allocation belongs to (or would, for excluded records). */
  beneficiary: string;
  feeMint: string;
  /** Total fee the record relates to, when known (null = not observable). */
  grossAmount: bigint | null;
  /** Amount allocated to the beneficiary. */
  creatorAmount: bigint;
  excludedAmount: bigint;
  excludedReason: string | null;
  signature: string | null;
  /** Accounting slot (decides the reward period). */
  slot: number;
  /** Slot at which the evidence was read, when it differs from `slot` (checkpoints). */
  observedSlot?: number | null;
  blockTime: number | null;
  /** Account / position / instruction used to establish the allocation. */
  evidence: Record<string, string | number | boolean | null>;
  status: FeeEvidenceStatus;
  payoutEligible: boolean;
  basisId: string | null;
}

/** Reason codes for amounts that are recorded but not allocated to the beneficiary. */
export const EXCLUSION = {
  notBeneficiaryShare: "not_beneficiary_share", // protocol / partner / platform / referral / LP share of a trade
  lpFeesViaPosition: "lp_fees_accounted_by_position_checkpoint",
  creatorFeeViaCollection: "creator_fee_accounted_at_collection",
  positionNotHeldByBeneficiary: "position_not_held_by_beneficiary",
  otherPoolSharedVault: "shared_vault_other_pool",
  allocationMismatch: "allocation_mismatch",
  unverifiedMigration: "unverified_migration",
  noCreatorEntitlement: "no_creator_entitlement",
  cpmmCreatorNotBeneficiary: "cpmm_pool_creator_is_not_beneficiary",
} as const;

/**
 * U1 guard. Historical fee records keep the basis they were generated under; a different
 * beneficiary role on the same pool would make one reward period mix entitlements and make
 * reconciliation compare mismatched bases. Correct re-attribution of history is not provable in
 * general, so the change is refused while the pool has activity indexed under another role (or
 * legacy rows without a stored basis). Returns a human-readable reason, or null when allowed.
 */
export async function roleChangeBlockReason(db: { Swap: any; FeeAttribution: any }, pool: string | null, role: string): Promise<string | null> {
  if (!pool) return null;
  const conflicting = await db.Swap.findOne({ pool, "basis.role": { $ne: role } }, { "basis.role": 1, signature: 1, slot: 1 }).lean();
  if (!conflicting) return null;
  const prev = conflicting.basis?.role ?? "unknown (legacy record without a stored basis)";
  return `pool ${pool} already has fee records attributed under role "${prev}" (e.g. ${String(conflicting.signature).slice(0, 12)}… at slot ${conflicting.slot}); changing the fee beneficiary role to "${role}" would mix allocation bases. Keep the role, or use a new pool; historical records are never re-attributed implicitly`;
}
