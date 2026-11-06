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
  platformOwnedLockedLp: "platform_owned_locked_lp", // LaunchLab platform Fee Key (incl. creator_scale since 2026-08-17)
} as const;

/**
 * Immutable allocation-basis snapshot stored with EVERY fee record (swaps and non-swap attributions),
 * so that each record can be explained on its own — why its amount was considered creator-allocated
 * and payable, or excluded — without consulting any configuration that may have changed since.
 * Written once with the record ($setOnInsert) and never rewritten (see db/models.ts update guards).
 */
export interface AllocationSnapshot {
  /** Snapshot schema version (records without it are "legacy"). */
  v: 1;
  /** Stable basis id (sha256 of provider/pool/phase/role/beneficiary/params). */
  id: string;
  provider: string;
  /** Bonding-curve pool of the launch. */
  sourcePool: string;
  /** Post-graduation pool the basis applies to, when it is a destination basis. */
  destinationPool: string | null;
  /** Pool named by the basis itself (bonding pool, or destination pool). */
  pool: string;
  phase: FeePhase;
  role: string;
  beneficiary: string;
  params: Record<string, string | number | boolean>;
  source: string;
  verification: AllocationVerification;
  problems: string[];
}

export const SNAPSHOT_VERSION = 1 as const;

export function snapshotOf(b: AllocationBasis, sourcePool: string): AllocationSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    id: b.id,
    provider: b.provider,
    sourcePool,
    destinationPool: b.pool === sourcePool ? null : b.pool,
    pool: b.pool,
    phase: b.phase,
    role: b.role,
    beneficiary: b.beneficiary,
    params: { ...b.params },
    source: b.source,
    verification: b.verification,
    problems: [...b.problems],
  };
}

/**
 * Every allocation basis a loaded provider can attribute fees under, by id: the bonding-curve basis
 * and, once a migration is verified, the destination's trading and migrated-LP bases.
 */
export function basesOf(info: { allocation?: AllocationBasis; destination?: { allocation?: AllocationBasis; lpAllocation?: AllocationBasis } | null }): Map<string, AllocationBasis> {
  const out = new Map<string, AllocationBasis>();
  for (const b of [info.allocation, info.destination?.allocation, info.destination?.lpAllocation]) if (b) out.set(b.id, b);
  return out;
}

/**
 * Whether a basis may be distributed by a reward round. Stricter than `basisPayable`: only an
 * allocation whose on-chain parameters were compared with an operator declaration and MATCHED is
 * distributable. `not_declared` means "read from chain, never cross-checked" and is reported as such;
 * it is recorded, shown, and never paid (see rewards/selection.ts `periodFees`).
 */
export function basisDistributable(b: (Pick<AllocationBasis, "verification"> & Partial<Pick<AllocationBasis, "phase" | "provider" | "params">>) | null | undefined): boolean {
  if (b?.verification !== "verified") return false;
  return !cpmmCreatorFeeBasisIncomplete(b);
}

/** Valid CPMM `creator_fee_on` modes as persisted in a basis (see providers/migration.ts `decodeCreatorFeeOn`). */
export const CPMM_CREATOR_FEE_ON_MODES = ["both_tokens", "only_token_0", "only_token_1"] as const;

/**
 * A LaunchLab → CPMM creator-fee basis must carry a VERIFIED creator_fee_on mode and an effective
 * creator-fee share rate. Bases written before PR #6 (no mode persisted) and bases whose mode or rate
 * could not be established are never distributable (fail closed), even if marked verified.
 */
export function cpmmCreatorFeeBasisIncomplete(b: Partial<Pick<AllocationBasis, "phase" | "provider" | "params">>): boolean {
  if (b.phase !== "post_migration_trading" || b.provider !== "raydium_launchlab" || !b.params) return false;
  const mode = b.params.creatorFeeOn;
  const rate = b.params.effectiveCreatorFeeShareRate;
  return !(CPMM_CREATOR_FEE_ON_MODES as readonly unknown[]).includes(mode) || typeof rate !== "string" || !/^\d+$/.test(rate);
}
export const CPMM_BASIS_INCOMPLETE = "cpmm_creator_fee_basis_unresolved";

/** Fee evidence statuses whose amounts are final and may be distributed. */
export const PAYABLE_STATUSES: readonly FeeEvidenceStatus[] = ["observed", "collected", "reconciled", "confirmed"];

/** What a historical record is compared against before a beneficiary role / pool / provider change. */
export interface BasisExpectation {
  /** Provider id, when known (always known to workers and to the settings store). */
  provider?: string | null;
  role: string;
  /** Beneficiary wallet, when known (workers know it after loading the pool; the API does not). */
  beneficiary?: string | null;
  /**
   * Ids of the bases the loaded provider would attribute under. A record without a full snapshot
   * (legacy) is accepted only if its basisId is one of these — the id hashes provider, pool, phase,
   * role, beneficiary and parameters, so a match proves the same basis.
   */
  currentBasisIds?: Set<string>;
}

export interface HistoricalConflict {
  collection: "swaps" | "fee_attributions";
  ref: string;
  slot: number;
  reason: string;
}

/**
 * Pure: why a historical fee record is incompatible with the expected basis (null when compatible).
 * Checks role, provider, beneficiary, snapshot completeness and internal consistency (the snapshot's
 * phase / pools must describe the record it is attached to).
 */
export function historicalRecordConflict(rec: any, exp: BasisExpectation, kind: "swaps" | "fee_attributions"): string | null {
  const snap = rec.basis ?? null;
  const recPhase = kind === "swaps" ? (rec.feePhase ?? "bonding_curve") : rec.phase;
  if (exp.provider && rec.provider && rec.provider !== exp.provider) return `recorded under provider "${rec.provider}", not "${exp.provider}"`;
  const full = snap && snap.v === SNAPSHOT_VERSION;
  if (!snap || !snap.role) {
    if (rec.basisId && exp.currentBasisIds?.has(rec.basisId)) return null;
    return `legacy record without a stored allocation basis snapshot${rec.basisId ? ` (basisId ${rec.basisId} is not a current basis)` : ""}`;
  }
  if (snap.role !== exp.role) return `attributed under role "${snap.role}", not "${exp.role}"`;
  if (exp.provider && snap.provider && snap.provider !== exp.provider) return `basis provider "${snap.provider}" ≠ "${exp.provider}"`;
  const beneficiary = snap.beneficiary ?? rec.beneficiary ?? null;
  if (exp.beneficiary && beneficiary && beneficiary !== exp.beneficiary) return `beneficiary ${beneficiary} ≠ current beneficiary ${exp.beneficiary}`;
  if (rec.beneficiary && snap.beneficiary && rec.beneficiary !== snap.beneficiary) return `record beneficiary ${rec.beneficiary} ≠ its basis beneficiary ${snap.beneficiary}`;
  if (snap.id && rec.basisId && snap.id !== rec.basisId) return `basisId ${rec.basisId} ≠ snapshot id ${snap.id}`;
  if (full) {
    if (snap.phase !== recPhase && !(kind === "swaps" && recPhase === "post_migration_trading" && snap.phase === "migrated_lp")) return `snapshot phase "${snap.phase}" ≠ record phase "${recPhase}"`;
    const recPool = kind === "swaps" ? rec.pool : (rec.destinationPool ?? rec.sourcePool);
    if (snap.pool !== recPool) return `snapshot pool ${snap.pool} ≠ record pool ${recPool}`;
    if (rec.sourcePool && snap.sourcePool !== rec.sourcePool) return `snapshot source pool ${snap.sourcePool} ≠ record source pool ${rec.sourcePool}`;
  } else if (!exp.currentBasisIds || !rec.basisId || !exp.currentBasisIds.has(rec.basisId)) {
    // Partial (pre-snapshot-v1) basis: role/beneficiary agree, but provider/pool/phase were not
    // stored. Accept only when its id proves it is one of the current bases.
    return `record carries a partial (pre-v1) basis snapshot that cannot be matched to a current basis`;
  }
  return null;
}

/**
 * U1 guard (both collections). Historical fee records keep the basis they were generated under; a
 * different beneficiary role / beneficiary / provider on the same launch would make one reward
 * period mix entitlements and make reconciliation compare mismatched bases. Correct re-attribution
 * of history is not provable in general, so the change is refused while the launch (bonding pool
 * and its destination) has any record under another basis, any legacy record without a provable
 * basis, or any internally inconsistent snapshot. Returns up to `limit` conflicts.
 */
export async function historicalBasisConflicts(db: { Swap: any; FeeAttribution: any }, pools: string[], exp: BasisExpectation, limit = 5): Promise<HistoricalConflict[]> {
  const ps = [...new Set(pools.filter(Boolean))];
  if (!ps.length) return [];
  const out: HistoricalConflict[] = [];
  const scope = { $or: [{ pool: { $in: ps } }, { sourcePool: { $in: ps } }, { destinationPool: { $in: ps } }] };
  for (const [kind, model] of [["swaps", db.Swap], ["fee_attributions", db.FeeAttribution]] as const) {
    // Candidates: anything that is not a full, matching v1 snapshot (cheap index-friendly filter),
    // then the exact pure check. Matching v1 records are skipped by the query.
    const mismatch: any[] = [{ "basis.v": { $ne: SNAPSHOT_VERSION } }, { "basis.role": { $ne: exp.role } }];
    if (exp.provider) mismatch.push({ provider: { $ne: exp.provider } });
    if (exp.beneficiary) mismatch.push({ "basis.beneficiary": { $ne: exp.beneficiary } });
    const cursor = model.find({ $and: [scope, { $or: mismatch }] }, { basis: 1, basisId: 1, provider: 1, beneficiary: 1, pool: 1, sourcePool: 1, destinationPool: 1, feePhase: 1, phase: 1, signature: 1, key: 1, slot: 1 }).sort({ slot: 1 }).limit(200).lean();
    for (const rec of await cursor) {
      const reason = historicalRecordConflict(rec, exp, kind);
      if (reason) out.push({ collection: kind, ref: kind === "swaps" ? String(rec.signature) : String(rec.key), slot: rec.slot, reason });
      if (out.length >= limit) return out;
    }
    // Full v1 snapshots that match role/provider/beneficiary can still be internally inconsistent.
    const sample = await model.find({ $and: [scope, { "basis.v": SNAPSHOT_VERSION, "basis.role": exp.role }] }, { basis: 1, basisId: 1, provider: 1, beneficiary: 1, pool: 1, sourcePool: 1, destinationPool: 1, feePhase: 1, phase: 1, signature: 1, key: 1, slot: 1 }).limit(500).lean();
    for (const rec of sample) {
      const reason = historicalRecordConflict(rec, exp, kind);
      if (reason) out.push({ collection: kind, ref: kind === "swaps" ? String(rec.signature) : String(rec.key), slot: rec.slot, reason });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Human-readable reason a worker / admin change must be refused, or null when allowed. Used by every
 * code path that can change the beneficiary role, pool or provider: the settings store (admin API),
 * indexer attachment, rewards-worker provider (re)load and any runtime provider change.
 */
export async function roleChangeBlockReason(db: { Swap: any; FeeAttribution: any }, pool: string | null, role: string, exp: Omit<BasisExpectation, "role"> = {}): Promise<string | null> {
  if (!pool) return null;
  const provider = exp.provider ?? null;
  const conflicts = await historicalBasisConflicts(db, [pool], { ...exp, role }, 3);
  if (!conflicts.length) return null;
  const list = conflicts.map((c) => `${c.collection} ${c.ref.slice(0, 16)}… (slot ${c.slot}): ${c.reason}`).join("; ");
  return `pool ${pool} already has fee records whose allocation basis is incompatible with role "${role}"${exp.beneficiary ? ` / beneficiary ${exp.beneficiary}` : ""}${provider ? ` / provider ${provider}` : ""} — ${list}. Changing it would mix allocation bases. Keep the configuration, or use a new pool; historical records are never re-attributed implicitly`;
}
