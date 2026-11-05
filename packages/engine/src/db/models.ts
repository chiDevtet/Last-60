/**
 * MongoDB schema. Every collection that participates in money movement has a uniqueness
 * constraint that makes double-processing structurally impossible:
 *   swaps            (signature, eventIndex)
 *   fee_claims       (signature)
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
    eligibleFee: { type: D, required: true },
    eligibleFeeMint: { type: String, required: true },
    slot: { type: Number, required: true },
    /** Monotone ordering key inside a slot: transaction position (when known) * 1000 + event index. */
    orderInSlot: { type: Number, required: true, default: 0 },
    blockTime: { type: Date, default: null },
    commitment: { type: String, enum: ["confirmed", "finalized"], required: true },
    status: { type: String, enum: ["active", "dropped"], default: "active" },
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

// ─── fee claims ─────────────────────────────────────────────────────────────────
const feeClaimSchema = new Schema(
  {
    signature: { type: String, required: true, unique: true },
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
feeClaimSchema.index({ pool: 1, slot: 1 });

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
      tokenMint: String,
      skippedRoundPolicy: String,
      minPayoutLamports: D,
      settingsVersion: Number,
    },
    fees: { type: D, default: null },
    nonPayoutAssetFees: [{ _id: false, mint: String, amount: D }],
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
