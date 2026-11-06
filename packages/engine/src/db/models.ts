/**
 * MongoDB schema. Every collection that participates in money movement has a uniqueness
 * constraint that makes double-processing structurally impossible:
 *   swaps            (signature, eventIndex)
 *   fee_claims       (signature, index)
 *   fee_attributions (key)  — non-swap fee facts (LP checkpoints, collections, exclusions)
 *   revenue_events   (key), (signature, ordinal, stream, feeMint) — phase-aware collections / funding inflows
 *   reward_funding   (key = funding inflow) — one credit per transfer, consumed by one round
 *   revenue_reconciliations (key = collection) — derived per-claim reconciliation
 *   rounds           (roundNumber), (roundIndex)
 *   payouts          (roundNumber, recipient), confirmedSignature
 *   ledger_entries   (key)  — idempotency key per economic fact
 *   terminal_events  (seq)
 */
import mongoose, { Schema, type Connection, type InferSchemaType, type Model } from "mongoose";

const D = Schema.Types.Decimal128;
const lockSchema = new Schema({ owner: String, token: String, expiresAt: Date }, { _id: false });

// ─── system / settings ──────────────────────────────────────────────────────────
const systemStateSchema = new Schema(
  { _id: { type: String, required: true }, value: Schema.Types.Mixed, updatedAt: { type: Date, default: Date.now } },
  { collection: "system_state", versionKey: false },
);

const settingsSchema = new Schema(
  {
    _id: { type: String, default: "active" },
    version: { type: Number, required: true, default: 0 },
    overrides: { type: Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: null },
  },
  { collection: "settings", versionKey: false, minimize: false },
);

const configAuditSchema = new Schema(
  {
    version: { type: Number, required: true },
    actor: { type: String, required: true },
    action: { type: String, required: true },
    changes: [{ _id: false, key: String, from: Schema.Types.Mixed, to: Schema.Types.Mixed }],
    reason: { type: String, default: null },
    ip: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { collection: "config_audit", versionKey: false },
);
configAuditSchema.index({ at: -1 });

// ─── pools ──────────────────────────────────────────────────────────────────────
const poolSchema = new Schema(
  {
    key: { type: String, required: true, unique: true }, // `${provider}:${poolAddress}`
    provider: { type: String, required: true },
    poolAddress: { type: String, required: true },
    tokenMint: { type: String, required: true },
    quoteMint: { type: String, required: true },
    baseDecimals: Number,
    quoteDecimals: Number,
    baseTokenProgram: String,
    quoteTokenProgram: String,
    creator: String,
    feeBeneficiaryRole: String,
    beneficiary: String, // wallet whose fee share is "eligible"
    status: { type: String, enum: ["bonding", "migrating", "migrated", "unknown"], default: "unknown" },
    feeParams: Schema.Types.Mixed, // provider-specific, e.g. { creatorTradingFeePercentage, collectFeeMode }
    accounts: Schema.Types.Mixed, // provider-specific addresses (config, vaults, fee vaults)
    warnings: { type: [String], default: [] },
    /** Graduation destination resolved from the migration transaction and verified on-chain. */
    migration: { type: Schema.Types.Mixed, default: null },
    discoveredAt: { type: Date, default: Date.now },
    refreshedAt: Date,
  },
  { collection: "pools", versionKey: false },
);

// ─── swaps (decoded trade events) ───────────────────────────────────────────────
const swapSchema = new Schema(
  {
    signature: { type: String, required: true },
    eventIndex: { type: Number, required: true },
    provider: { type: String, required: true },
    pool: { type: String, required: true },
    tokenMint: { type: String, required: true },
    quoteMint: { type: String, required: true },
    side: { type: String, enum: ["buy", "sell"], required: true },
    trader: { type: String, required: true },
    traderSource: { type: String, enum: ["payer", "balance_owner", "fee_payer"], required: true },
    quoteAmount: { type: D, required: true },
    baseAmount: { type: D, required: true },
    totalFee: { type: D, required: true },
    /** Creator-allocated (beneficiary) share of `totalFee`, computed with the program's own formula. */
    eligibleFee: { type: D, required: true },
    eligibleFeeMint: { type: String, required: true },
    // ── attribution provenance (see accounting/attribution.ts) ──
    feePhase: { type: String, enum: ["bonding_curve", "post_migration_trading", "migrated_lp"], default: "bonding_curve" },
    /** totalFee − eligibleFee: shares that belong to someone else (protocol, partner, platform, LPs). */
    excludedFee: { type: D, default: null },
    excludedReason: { type: String, default: null },
    feeStatus: { type: String, enum: ["estimated", "observed", "collected", "reconciled", "confirmed", "unresolved"], default: "observed" },
    /** False: recorded but never distributed (unproven or mismatching allocation). Legacy rows lack it (= eligible). */
    payoutEligible: { type: Boolean, default: true },
    /** Allocation basis that applied when this fee was generated (immutable once written). */
    basisId: { type: String, default: null },
    basis: { type: Schema.Types.Mixed, default: null },
    beneficiary: { type: String, default: null },
    /** Bonding pool of the launch (equals `pool` for bonding-curve trades). */
    sourcePool: { type: String, default: null },
    evidence: { type: Schema.Types.Mixed, default: null },
    /** Informational: creator fee accrued but finalised at collection (e.g. CPMM share rate). Never summed. */
    estimatedCreatorFee: { type: D, default: null },
    slot: { type: Number, required: true },
    /**
     * Ordering key inside a slot: the EVENT INDEX inside its transaction. It is NOT the transaction's
     * position in the block and gives no ordering guarantee between different transactions of the
     * same slot; selection breaks cross-transaction ties within a slot with the block's own order
     * (getBlock), and `txIndex` holds the block position when it has been resolved.
     */
    orderInSlot: { type: Number, required: true, default: 0 },
    txIndex: { type: Number, default: null },
    blockTime: { type: Date, default: null },
    commitment: { type: String, enum: ["confirmed", "finalized"], required: true },
    status: { type: String, enum: ["active", "dropped"], default: "active" },
    /** First time a finality pass saw the signature unknown to a node past the finalized slot. */
    dropCandidateAt: { type: Date, default: null },
    roundNumber: { type: Number, default: null },
    source: { type: String, enum: ["indexer", "catchup", "backfill"], required: true },
    ingestedAt: { type: Date, default: Date.now },
  },
  { collection: "swaps", versionKey: false },
);
swapSchema.index({ signature: 1, eventIndex: 1 }, { unique: true });
swapSchema.index({ pool: 1, side: 1, status: 1, slot: -1, orderInSlot: -1 });
swapSchema.index({ pool: 1, status: 1, slot: 1 });
swapSchema.index({ trader: 1, slot: -1 });
swapSchema.index({ commitment: 1, status: 1, slot: 1 });
swapSchema.index({ pool: 1, basisId: 1 });
swapSchema.index({ sourcePool: 1, slot: 1 });

/**
 * Fee records are append-only for everything that decided their accounting: amounts, eligibility,
 * status and the allocation basis. Only bookkeeping fields (round assignment, finality / drop state,
 * block position) may change after insert. Inserts go through `$setOnInsert` upserts, which these
 * guards allow; any `$set` / `$unset` / `$inc` of a protected field throws.
 */
function guardImmutable(schema: Schema, protectedFields: string[]) {
  const isProtected = (k: string) => protectedFields.some((f) => k === f || k.startsWith(`${f}.`));
  const check = function (this: any) {
    const u = this.getUpdate?.() ?? {};
    for (const op of ["$set", "$unset", "$inc", "$rename", "$push", "$pull", "$min", "$max", "$mul"]) {
      for (const k of Object.keys(u[op] ?? {})) if (isProtected(k)) throw new Error(`immutable fee record field "${k}" cannot be updated (${op})`);
    }
    for (const k of Object.keys(u)) if (!k.startsWith("$") && isProtected(k)) throw new Error(`immutable fee record field "${k}" cannot be replaced`);
  };
  for (const hook of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"] as const) schema.pre(hook, check);
}
guardImmutable(swapSchema, ["basis", "basisId", "eligibleFee", "eligibleFeeMint", "totalFee", "excludedFee", "excludedReason", "feeStatus", "payoutEligible", "feePhase", "beneficiary", "pool", "sourcePool", "provider", "estimatedCreatorFee", "evidence"]);

// ─── fee claims ─────────────────────────────────────────────────────────────────
const feeClaimSchema = new Schema(
  {
    signature: { type: String, required: true },
    /** Instruction ordinal of the claim inside its transaction (several claims per tx are possible). */
    index: { type: Number, default: 0 },
    evidence: { type: Schema.Types.Mixed, default: null },
    provider: String,
    pool: String,
    role: String,
    claimer: String,
    quoteMint: String,
    quoteAmount: { type: D, required: true },
    baseAmount: { type: D, required: true },
    slot: Number,
    blockTime: Date,
    source: { type: String, enum: ["auto_claim", "external"], required: true },
    status: { type: String, enum: ["submitted", "confirmed", "failed"], required: true },
    roundNumber: { type: Number, default: null },
    error: String,
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "fee_claims", versionKey: false },
);
feeClaimSchema.index({ signature: 1, index: 1 }, { unique: true });
feeClaimSchema.index({ pool: 1, slot: 1 });

// ─── fee attributions (non-swap fee facts) ─────────────────────────────────────
export const FEE_PHASES = ["bonding_curve", "post_migration_trading", "migrated_lp"] as const;
export const FEE_STATUSES = ["estimated", "observed", "collected", "reconciled", "confirmed", "unresolved"] as const;
const feeAttributionSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, required: true },
    chain: { type: String, default: "solana" },
    provider: { type: String, required: true },
    phase: { type: String, enum: FEE_PHASES, required: true },
    sourcePool: { type: String, required: true },
    destinationPool: { type: String, default: null },
    /** Pool this record is accounted under (destination pool for post-migration records). */
    pool: { type: String, required: true },
    beneficiary: { type: String, required: true },
    feeMint: { type: String, required: true },
    grossAmount: { type: D, default: null },
    creatorAmount: { type: D, required: true },
    excludedAmount: { type: D, required: true },
    excludedReason: { type: String, default: null },
    signature: { type: String, default: null },
    slot: { type: Number, required: true },
    observedSlot: { type: Number, default: null },
    blockTime: { type: Date, default: null },
    evidence: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: FEE_STATUSES, required: true },
    payoutEligible: { type: Boolean, required: true },
    basisId: { type: String, default: null },
    /**
     * Immutable allocation-basis snapshot (accounting/attribution.ts `AllocationSnapshot`): provider,
     * source/destination pool, phase, role, beneficiary, on-chain parameters, source accounts,
     * verification and problems. Written once at insert; never rewritten. Null on legacy records.
     */
    basis: { type: Schema.Types.Mixed, default: null },
    /** Cumulative counter value for checkpoint records (position fee growth), as a decimal string. */
    cumulative: { type: String, default: null },
    checkpointKey: { type: String, default: null },
    roundNumber: { type: Number, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "fee_attributions", versionKey: false },
);
feeAttributionSchema.index({ pool: 1, slot: 1 });
feeAttributionSchema.index({ sourcePool: 1, slot: 1 });
feeAttributionSchema.index({ checkpointKey: 1, slot: -1 });
guardImmutable(feeAttributionSchema, ["basis", "basisId", "creatorAmount", "excludedAmount", "grossAmount", "excludedReason", "status", "payoutEligible", "phase", "beneficiary", "pool", "sourcePool", "destinationPool", "provider", "feeMint", "kind", "cumulative", "evidence"]);

// ─── revenue events (phase-aware streams; accounting/revenueStreams.ts) ─────────
/**
 * Immutable on-chain facts of the phase-aware revenue model: fee COLLECTIONS (bonding-curve creator
 * fee, CPMM creator fee, Forge platform LP fee claim) and FUNDING INFLOWS (transfers into a configured
 * Last-60 funding destination). One row per (signature, instruction ordinal, stream, mint): retries,
 * re-indexing and restarts can never create a second row.
 */
export const REVENUE_EVENT_STREAMS = ["bonding_curve_creator_fee", "cpmm_creator_trading_fee", "forge_platform_lp_fee_collection", "last60_funding_inflow"] as const;
const revenueEventSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["collection", "funding_inflow"], required: true },
    stream: { type: String, enum: REVENUE_EVENT_STREAMS, required: true },
    chain: { type: String, default: "solana" },
    cluster: { type: String, required: true },
    provider: { type: String, required: true },
    launchPhase: { type: String, default: null }, // "bonding_curve" | "post_migration" | null (inflow)
    tokenMint: { type: String, required: true },
    sourcePool: { type: String, required: true },
    pool: { type: String, required: true },
    signature: { type: String, required: true },
    /** Top-level instruction index and inner index (null = top-level) of the instruction that moved the funds. */
    instructionIndex: { type: Number, required: true },
    innerInstructionIndex: { type: Number, default: null },
    /** Execution-order ordinal across the whole transaction. */
    ordinal: { type: Number, required: true },
    slot: { type: Number, required: true },
    blockTime: { type: Date, default: null },
    feeMint: { type: String, required: true },
    /** Accounting asset (native SOL and WSOL share one asset; nothing else is merged). */
    asset: { type: String, required: true },
    decimals: { type: Number, default: null },
    grossAmount: { type: D, default: null },
    netAmount: { type: D, required: true },
    sourceAccount: { type: String, default: null },
    destinationAccount: { type: String, default: null },
    sourceOwner: { type: String, default: null },
    destinationOwner: { type: String, default: null },
    /** Actual beneficiary of the collected amount (creator / Forge platform wallet / Last-60 destination). */
    beneficiary: { type: String, default: null },
    status: { type: String, enum: FEE_STATUSES, required: true },
    /** Raw events are never payable themselves; eligibility lives on `reward_funding` credits. */
    payoutEligible: { type: Boolean, default: false },
    excludedReason: { type: String, default: null },
    memoClaimSignature: { type: String, default: null },
    evidence: { type: Schema.Types.Mixed, default: null },
    snapshot: { type: Schema.Types.Mixed, required: true },
    commitment: { type: String, enum: ["confirmed", "finalized"], required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "revenue_events", versionKey: false },
);
revenueEventSchema.index({ signature: 1, ordinal: 1, stream: 1, feeMint: 1 }, { unique: true });
revenueEventSchema.index({ sourcePool: 1, kind: 1, slot: 1 });
revenueEventSchema.index({ kind: 1, sourceOwner: 1, asset: 1, slot: 1 });
revenueEventSchema.index({ stream: 1, slot: 1 });
guardImmutable(revenueEventSchema, ["key", "kind", "stream", "provider", "launchPhase", "tokenMint", "sourcePool", "pool", "signature", "instructionIndex", "innerInstructionIndex", "ordinal", "slot", "feeMint", "asset", "grossAmount", "netAmount", "sourceAccount", "destinationAccount", "sourceOwner", "destinationOwner", "beneficiary", "status", "payoutEligible", "excludedReason", "memoClaimSignature", "evidence", "snapshot"]);

/**
 * Reward-funding credits: one per funding inflow correlated to a collection (unique `key` = the
 * inflow event key, so one transfer funds at most one claim, once). Amounts are immutable; only the
 * round bookkeeping (`roundNumber`, `consumedAt`) is written later, conditionally on `roundNumber:
 * null` inside the round's transaction, so a credit is consumed by exactly one round.
 */
const rewardFundingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    stream: { type: String, enum: ["bonding_curve_last60_reward_contribution", "forge_platform_lp_last60_contribution"], required: true },
    collectionKey: { type: String, required: true },
    correlationMethod: { type: String, enum: ["same_transaction", "memo", "exclusive_window"], required: true },
    provider: { type: String, required: true },
    tokenMint: { type: String, required: true },
    sourcePool: { type: String, required: true },
    pool: { type: String, required: true },
    signature: { type: String, required: true },
    ordinal: { type: Number, required: true },
    slot: { type: Number, required: true },
    /** Slot of the collection this inflow distributes. */
    collectionSlot: { type: Number, required: true },
    blockTime: { type: Date, default: null },
    /** Accounting asset funded (WSOL mint for native SOL / WSOL). */
    fundingMint: { type: String, required: true },
    observedAmount: { type: D, required: true },
    /** Portion supported by the policy (≤ remaining expected contribution of the claim). */
    creditableAmount: { type: D, required: true },
    /** Portion above the policy amount (recorded, never payable). */
    excessAmount: { type: D, required: true },
    status: { type: String, enum: FEE_STATUSES, required: true },
    payoutEligible: { type: Boolean, required: true },
    ineligibleReason: { type: String, default: null },
    policy: { type: Schema.Types.Mixed, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    roundNumber: { type: Number, default: null },
    consumedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "reward_funding", versionKey: false },
);
rewardFundingSchema.index({ collectionKey: 1, slot: 1 });
rewardFundingSchema.index({ roundNumber: 1, fundingMint: 1 });
rewardFundingSchema.index({ payoutEligible: 1, roundNumber: 1, fundingMint: 1, slot: 1 });
guardImmutable(rewardFundingSchema, ["key", "stream", "collectionKey", "correlationMethod", "provider", "tokenMint", "sourcePool", "pool", "signature", "ordinal", "slot", "collectionSlot", "fundingMint", "observedAmount", "creditableAmount", "excessAmount", "status", "payoutEligible", "ineligibleReason", "policy", "snapshot"]);

/**
 * Per-collection reconciliation (durable claim record). DERIVED: recomputed idempotently from the
 * immutable collection event and its credits, so a restart or re-run converges to the same row.
 */
const revenueReconciliationSchema = new Schema(
  {
    key: { type: String, required: true, unique: true }, // = collection event key (correlation id)
    stream: { type: String, required: true },
    provider: String,
    tokenMint: String,
    sourcePool: String,
    pool: String,
    collectionSignature: String,
    collectionOrdinal: Number,
    collectionSlot: Number,
    collectionBlockTime: { type: Date, default: null },
    feeMint: String,
    asset: String,
    decimals: { type: Number, default: null },
    recipient: String,
    creator: { type: String, default: null },
    gross: D,
    expectedLast60: D,
    expectedRetained: D,
    actualLast60: D,
    creditable: D,
    excess: D,
    untransferred: D,
    impliedRetained: D,
    status: { type: String, enum: ["awaiting_distribution", "partial", "reconciled", "excess", "unresolved", "not_applicable"], required: true },
    verified: Boolean,
    discrepancies: { type: [String], default: [] },
    problems: { type: [String], default: [] },
    distributions: { type: Schema.Types.Mixed, default: [] },
    policy: Schema.Types.Mixed,
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "revenue_reconciliations", versionKey: false },
);
revenueReconciliationSchema.index({ sourcePool: 1, stream: 1, collectionSlot: 1 });
revenueReconciliationSchema.index({ status: 1 });

// ─── unique buyer activity ──────────────────────────────────────────────────────
const buyerActivitySchema = new Schema(
  {
    wallet: { type: String, required: true, unique: true },
    firstBuyAt: Date,
    lastBuyAt: Date,
    lastQualifyingBuyAt: Date,
    lastQualifyingSignature: String,
    buyCount: { type: Number, default: 0 },
    qualifyingBuyCount: { type: Number, default: 0 },
    totalQuoteSpent: { type: D, default: () => mongoose.Types.Decimal128.fromString("0") },
    rewardsReceived: { type: D, default: () => mongoose.Types.Decimal128.fromString("0") },
    roundsWon: { type: Number, default: 0 },
  },
  { collection: "buyer_activity", versionKey: false },
);
buyerActivitySchema.index({ lastQualifyingBuyAt: -1 });

// ─── rounds ─────────────────────────────────────────────────────────────────────
export const ROUND_STATES = ["open", "scheduled", "snapshotting", "paying", "awaiting_funds", "completed", "rolled_over", "attention", "missed"] as const;
export type RoundState = (typeof ROUND_STATES)[number];

const roundSchema = new Schema(
  {
    roundNumber: { type: Number, required: true, unique: true },
    roundIndex: { type: Number, required: true, unique: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    windowStartsAt: { type: Date, required: true },
    state: { type: String, enum: ROUND_STATES, required: true, default: "open" },

    // ── PRIVATE scheduling state: sealed, never selected by default, never returned by any API ──
    executeAtCipher: { type: String, select: false, default: null },
    scheduleGeneratedAt: { type: Date, select: false, default: null },

    // ── public once execution has begun (on-chain activity reveals it anyway) ──
    executedAt: { type: Date, default: null },
    snapshotSlot: { type: Number, default: null },
    prevSnapshotSlot: { type: Number, default: null },
    prevRoundNumber: { type: Number, default: null },
    periodStartAt: { type: Date, default: null }, // only used for the first-ever round
    config: {
      buyerCount: Number,
      minBuyQuote: D,
      rewardBps: Number,
      payoutMint: String,
      payoutMode: String,
      provider: String,
      pool: String,
      previousPool: { type: String, default: null }, // set when the pool/provider changed during the period
      pools: { type: [String], default: undefined }, // every pool whose activity the period covered
      tokenMint: String,
      skippedRoundPolicy: String,
      minPayoutLamports: D,
      settingsVersion: Number,
    },
    fees: { type: D, default: null },
    nonPayoutAssetFees: [{ _id: false, mint: String, amount: D }],
    /** Fees in the period that were recorded but are not payout-eligible (unresolved / mismatching basis). */
    ineligibleFees: [{ _id: false, mint: String, amount: D, reason: String }],
    /** Per-phase breakdown of the distributed fees (bonding curve / post-migration / migrated LP). */
    feeBreakdown: { type: Schema.Types.Mixed, default: null },
    /** Reward-funding policy in force for this round (immutable snapshot) and contributions consumed. */
    fundingPolicy: { type: Schema.Types.Mixed, default: null },
    /** Σ verified Last-60 contributions (payout asset) consumed by this round; 0/null under the legacy policy. */
    funding: { type: D, default: null },
    fundingBreakdown: { type: Schema.Types.Mixed, default: null },
    reward: { type: D, default: null },
    retained: { type: D, default: null },
    rolloverIn: { type: D, default: null },
    rolloverOut: { type: D, default: null },
    dust: { type: D, default: null },
    perRecipient: { type: D, default: null },
    recipientCount: { type: Number, default: 0 },
    eligibleBuyerCount: { type: Number, default: 0 },
    paid: { type: D, default: null },
    pending: { type: D, default: null },
    failed: { type: D, default: null },
    dryRun: { type: Boolean, default: false },
    outcome: { type: String, default: null }, // human-readable reason for rolled_over / missed
    lock: { type: lockSchema, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  { collection: "rounds", versionKey: false, timestamps: true },
);
roundSchema.index({ state: 1, roundNumber: 1 });
roundSchema.index({ snapshotSlot: -1 });

// ─── payouts ────────────────────────────────────────────────────────────────────
export const PAYOUT_STATES = ["pending", "signing", "submitted", "confirmed", "failed", "simulated"] as const;
export type PayoutStateDb = (typeof PAYOUT_STATES)[number];

const attemptSchema = new Schema(
  {
    n: Number,
    signature: String,
    blockhash: String,
    lastValidBlockHeight: Number,
    createdAt: Date,
    outcome: { type: String, enum: ["in_flight", "expired", "failed", "confirmed"], default: "in_flight" },
    error: String,
  },
  { _id: false },
);

const payoutSchema = new Schema(
  {
    roundNumber: { type: Number, required: true },
    recipient: { type: String, required: true },
    position: { type: Number, required: true },
    amount: { type: D, required: true },
    mint: { type: String, required: true },
    mode: { type: String, enum: ["live", "dry_run"], required: true },
    state: { type: String, enum: PAYOUT_STATES, required: true, default: "pending" },
    attemptCount: { type: Number, default: 0 },
    current: {
      type: new Schema(
        {
          signature: String,
          blockhash: String,
          lastValidBlockHeight: Number,
          serializedTx: { type: String, select: false },
          createdAt: Date,
          lastBroadcastAt: Date,
          broadcasts: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    attempts: { type: [attemptSchema], default: [] },
    confirmedSignature: { type: String, default: null },
    confirmedSlot: { type: Number, default: null },
    confirmedAt: { type: Date, default: null },
    /**
     * True once the PAYOUT_CONFIRMED / PAYOUT_FAILED ledger entry and buyer statistics were written
     * in the same MongoDB transaction as the state change. Rows without it are repaired by the
     * reconciler (idempotent).
     */
    ledgerApplied: { type: Boolean, default: false },
    lock: { type: lockSchema, default: null },
    nextAttemptAt: { type: Date, default: () => new Date(0) },
    lastError: { type: String, default: null },
  },
  { collection: "payouts", versionKey: false, timestamps: true },
);
payoutSchema.index({ roundNumber: 1, recipient: 1 }, { unique: true });
payoutSchema.index({ state: 1, nextAttemptAt: 1 });
payoutSchema.index({ "current.signature": 1 }, { sparse: true });
payoutSchema.index({ confirmedSignature: 1 }, { unique: true, partialFilterExpression: { confirmedSignature: { $type: "string" } } });
payoutSchema.index({ recipient: 1, roundNumber: -1 });
payoutSchema.index({ state: 1, ledgerApplied: 1 });

// ─── ledger ─────────────────────────────────────────────────────────────────────
export const LEDGER_TYPES = [
  "FEE_ACCRUED", // eligible fees attributed to a round (payout asset)
  "FEE_NON_PAYOUT_ASSET", // eligible fees in another asset: recorded, never converted
  "REWARD_ALLOCATED", // reward share of accrued fees
  "RETAINED", // non-reward share of accrued fees
  "ROLLOVER_IN",
  "ROLLOVER_OUT",
  "DUST_RETAINED",
  "PAYOUT_SCHEDULED",
  "PAYOUT_CONFIRMED",
  "PAYOUT_SIMULATED",
  "PAYOUT_FAILED",
  "PAYOUT_REQUEUED",
  "FEE_CLAIMED",
  "FEE_EXCLUDED", // fees recorded in a round's period but not allocated / not provable (never paid)
  "FUNDING_CREDITED", // verified, reconciled Last-60 contribution consumed by a round (phase-aware policy)
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

const ledgerSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    roundNumber: { type: Number, default: null },
    amount: { type: D, required: true },
    mint: { type: String, required: true },
    payoutId: { type: Schema.Types.ObjectId, default: null },
    signature: { type: String, default: null },
    memo: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "ledger_entries", versionKey: false },
);
ledgerSchema.index({ type: 1, createdAt: -1 });
ledgerSchema.index({ roundNumber: 1, type: 1 });

// ─── terminal events ───────────────────────────────────────────────────────────
const terminalEventSchema = new Schema(
  {
    seq: { type: Number, required: true, unique: true },
    ts: { type: Date, required: true },
    type: { type: String, required: true },
    message: { type: String, required: true },
    roundNumber: { type: Number, default: null },
    signature: { type: String, default: null },
    details: { type: Schema.Types.Mixed, default: null },
    dedupeKey: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: "terminal_events", versionKey: false },
);
terminalEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
terminalEventSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { collection: "counters", versionKey: false });

// ─── workers ────────────────────────────────────────────────────────────────────
const leaseSchema = new Schema(
  { _id: String, owner: String, token: String, expiresAt: Date, acquiredAt: Date },
  { collection: "worker_leases", versionKey: false },
);

const workerStateSchema = new Schema(
  {
    _id: String,
    heartbeatAt: Date,
    status: { type: String, enum: ["running", "paused", "degraded", "error", "stopped", "standby"], default: "running" },
    detail: { type: String, default: null },
    instance: String,
    metrics: { type: Schema.Types.Mixed, default: {} },
    cursor: { type: Schema.Types.Mixed, default: null },
  },
  { collection: "worker_state", versionKey: false, minimize: false },
);

// ─── reconciliation ─────────────────────────────────────────────────────────────
const reconciliationSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    kind: { type: String, enum: ["fee_source", "ledger", "payout_wallet"], required: true },
    status: { type: String, enum: ["ok", "mismatch", "over_attribution", "shared_vault", "skipped"], required: true },
    slot: Number,
    expected: D,
    actual: D,
    diff: D,
    details: Schema.Types.Mixed,
  },
  { collection: "reconciliation_reports", versionKey: false },
);
reconciliationSchema.index({ kind: 1, at: -1 });

// ─── admin auth ─────────────────────────────────────────────────────────────────
const adminNonceSchema = new Schema(
  { nonce: { type: String, unique: true }, wallet: String, message: String, expiresAt: Date },
  { collection: "admin_nonces", versionKey: false },
);
adminNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const schemas = {
  SystemState: systemStateSchema,
  Settings: settingsSchema,
  ConfigAudit: configAuditSchema,
  Pool: poolSchema,
  Swap: swapSchema,
  FeeClaim: feeClaimSchema,
  FeeAttribution: feeAttributionSchema,
  RevenueEvent: revenueEventSchema,
  RewardFunding: rewardFundingSchema,
  RevenueReconciliation: revenueReconciliationSchema,
  BuyerActivity: buyerActivitySchema,
  Round: roundSchema,
  Payout: payoutSchema,
  LedgerEntry: ledgerSchema,
  TerminalEvent: terminalEventSchema,
  Counter: counterSchema,
  WorkerLease: leaseSchema,
  WorkerState: workerStateSchema,
  Reconciliation: reconciliationSchema,
  AdminNonce: adminNonceSchema,
};

export type SwapDoc = InferSchemaType<typeof swapSchema>;
export type RoundDoc = InferSchemaType<typeof roundSchema> & { _id: mongoose.Types.ObjectId };
export type PayoutDoc = InferSchemaType<typeof payoutSchema> & { _id: mongoose.Types.ObjectId };
export type PoolDoc = InferSchemaType<typeof poolSchema>;

type ModelsOf<T extends Record<string, Schema>> = { [K in keyof T]: Model<any> };
export type Models = ModelsOf<typeof schemas> & { conn: Connection };

export function createModels(conn: Connection): Models {
  const out: Record<string, unknown> = { conn };
  for (const [name, schema] of Object.entries(schemas)) {
    out[name] = conn.models[name] ?? conn.model(name, schema);
  }
  return out as Models;
}

export async function ensureIndexes(m: Models): Promise<void> {
  for (const [name, model] of Object.entries(m)) {
    if (name === "conn") continue;
    await (model as Model<any>).createCollection().catch(() => undefined);
    await (model as Model<any>).syncIndexes();
  }
}
