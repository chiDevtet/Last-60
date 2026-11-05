/**
 * Public API data transfer objects. These are the ONLY shapes the public API may return.
 * They deliberately contain no scheduling internals (no execute time, no delay, no candidate list).
 * Amounts are base-unit decimal strings.
 */

export type LaunchProviderId = "meteora_dbc" | "raydium_launchlab" | "mock";

/** Publicly visible phase of a round. Derived from time + settled state only. */
export type RoundPhase =
  | "open" // before the final minute
  | "final_minute" // inside the final window, payout not yet started
  | "processing" // snapshot taken, payouts in flight
  | "settled" // all payouts confirmed
  | "rolled_over" // no qualifying buyers / below minimum: reward carried forward
  | "awaiting_funds" // payouts queued, payout wallet underfunded
  | "attention" // one or more payouts failed after max attempts (operators notified)
  | "missed"; // engine was unavailable for the entire window; funds flow to next round

export interface AssetInfo {
  symbol: string;
  mint: string;
  decimals: number;
}

export interface CurrentRoundDTO {
  roundNumber: number;
  startsAt: string; // ISO
  endsAt: string; // ISO
  finalWindowStartsAt: string; // ISO — public: the final minute is a published rule
  serverTime: string; // ISO
  phase: RoundPhase;
  durationSeconds: number;
  finalWindowSeconds: number;
  buyerCount: number;
  minBuy: string;
  rewardBps: number;
  qualifyingBuyers: number; // unique qualifying wallets in the current reward period
  /** Present only once the round's payout has started (it is public on-chain by then). */
  settledRoundNumber?: number | null;
}

export interface RewardPoolDTO {
  asset: AssetInfo;
  /** Eligible fees accrued in the current (not yet snapshotted) reward period. */
  periodFees: string;
  /** REWARD_PERCENTAGE share of periodFees + rollover. */
  periodReward: string;
  /** Remainder retained by the project. */
  periodRetained: string;
  rolloverIn: string;
  /** Allocated to winners of past rounds but not yet confirmed on-chain. */
  pendingPayouts: string;
  totalDistributed: string;
  distributed24h: string;
  rewardBps: number;
}

export interface BuyDTO {
  signature: string;
  wallet: string;
  quoteAmount: string;
  baseAmount: string;
  slot: number;
  blockTime: string | null;
  qualifies: boolean;
  commitment: "confirmed" | "finalized";
}

export type PayoutState = "pending" | "submitted" | "confirmed" | "failed" | "simulated";

export interface PayoutDTO {
  roundNumber: number;
  recipient: string;
  amount: string;
  state: PayoutState;
  signature: string | null;
  confirmedAt: string | null;
}

export interface RoundSummaryDTO {
  roundNumber: number;
  startsAt: string;
  endsAt: string;
  executedAt: string | null;
  phase: RoundPhase;
  fees: string;
  reward: string;
  retained: string;
  rolloverIn: string;
  rolloverOut: string;
  dust: string;
  perRecipient: string;
  recipientCount: number;
  paid: string;
  dryRun: boolean;
}

export interface RoundDetailDTO extends RoundSummaryDTO {
  snapshotSlot: number | null;
  buyerCount: number;
  minBuy: string;
  rewardBps: number;
  payouts: PayoutDTO[];
}

export interface StatsDTO {
  asset: AssetInfo;
  totalFeesAccrued: string;
  totalPaid: string;
  totalPending: string;
  totalRetained: string;
  currentReward: string;
  payoutCount: number;
  settledRounds: number;
  uniqueRecipients: number;
  uniqueBuyers: number;
}

export type TerminalEventType =
  | "SYSTEM"
  | "INDEXER"
  | "BUY"
  | "FEES"
  | "ACCOUNTING"
  | "PAYOUT"
  | "CONFIRMED"
  | "WARN"
  | "ERROR";

export interface TerminalEventDTO {
  seq: number;
  ts: string;
  type: TerminalEventType;
  message: string;
  roundNumber: number | null;
  signature: string | null;
  details: Record<string, string | number | boolean | null> | null;
}

export interface HealthDTO {
  status: "ok" | "degraded" | "down";
  time: string;
  components: Record<string, { status: "ok" | "degraded" | "down" | "paused"; lastHeartbeat: string | null; detail?: string }>;
  provider: LaunchProviderId;
  cluster: string;
  payoutMode: "dry_run" | "live";
}

export interface FeeChartPointDTO {
  roundNumber: number;
  fees: string;
  reward: string;
  recipients: number;
}

export interface DashboardSnapshotDTO {
  round: CurrentRoundDTO;
  pool: RewardPoolDTO;
  stats: StatsDTO;
  recentBuys: BuyDTO[];
  recentRounds: RoundSummaryDTO[];
  chart: FeeChartPointDTO[];
  meta: {
    appName: string;
    cluster: string;
    provider: LaunchProviderId;
    tokenMint: string;
    poolAddress: string;
    payoutMode: "dry_run" | "live";
    explorer: string;
    poolStatus: "bonding" | "migrating" | "migrated" | "unknown";
  };
}

/** Server-Sent Events emitted on /api/v1/stream. */
export type StreamEvent =
  | { event: "snapshot"; data: DashboardSnapshotDTO }
  | { event: "terminal"; data: TerminalEventDTO }
  | { event: "heartbeat"; data: { serverTime: string } };

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
