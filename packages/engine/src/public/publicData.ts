/**
 * Builders for every PUBLIC DTO. This module is the only path from the database to public API
 * responses. It whitelists fields explicitly; scheduler internals (executeAtCipher,
 * scheduleGeneratedAt, locks) are never selected and could not be mapped even if they were.
 */
import type {
  BuyDTO,
  CurrentRoundDTO,
  DashboardSnapshotDTO,
  FeeChartPointDTO,
  PayoutDTO,
  RewardPoolDTO,
  RoundDetailDTO,
  RoundPhase,
  RoundSummaryDTO,
  StatsDTO,
} from "@last60/shared";
import { WSOL_MINT } from "@last60/shared";
import type { AppConfig } from "../config/env";
import type { SettingsStore } from "../config/runtime";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import { toTerminalDTO } from "../terminal/terminal";
import { boundsOf, roundIndexAt, type ScheduleParams } from "../rewards/roundMath";
import { periodFees, periodMatch } from "../rewards/selection";

const EXECUTED_STATES = ["snapshotting", "paying", "awaiting_funds", "completed", "rolled_over", "attention"];
const PUBLIC_ROUND_FIELDS = "roundNumber roundIndex startsAt endsAt state completedAt snapshotSlot fees reward retained rolloverIn rolloverOut dust perRecipient recipientCount paid dryRun config.buyerCount config.minBuyQuote config.rewardBps";

export function phaseOf(r: any, now: number, windowStartsAt: number): RoundPhase {
  switch (r?.state) {
    case "snapshotting":
    case "paying":
      return "processing";
    case "completed":
      return "settled";
    case "rolled_over":
      return "rolled_over";
    case "awaiting_funds":
      return "awaiting_funds";
    case "attention":
      return "attention";
    case "missed":
      return "missed";
    default:
      return now >= windowStartsAt ? "final_minute" : "open";
  }
}

function clampInt(v: number, def: number, max: number): number {
  return Number.isInteger(v) && v >= 1 ? Math.min(v, max) : def;
}

export class PublicData {
  private readonly params: ScheduleParams;
  private cache = new Map<string, { at: number; v: unknown }>();

  constructor(
    private readonly db: Models,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.params = { roundDurationMs: cfg.schedule.roundDurationMs, windowStartMs: cfg.schedule.windowStartMs, windowDurationMs: cfg.schedule.windowDurationMs, anchorEpochMs: cfg.schedule.anchorEpochMs };
  }

  private async cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const c = this.cache.get(key);
    if (c && this.now() - c.at < ttl) return c.v as T;
    const v = await fn();
    this.cache.set(key, { at: this.now(), v });
    return v;
  }

  private async genesisIndex(): Promise<number> {
    const g: any = await this.db.SystemState.findById("genesis").lean();
    if (g?.value?.roundIndex !== undefined) return g.value.roundIndex;
    return this.cfg.schedule.genesisAt ? roundIndexAt(this.cfg.schedule.genesisAt.getTime(), this.params) : roundIndexAt(this.now(), this.params);
  }

  private async lastSnapshot(): Promise<{ slot: number; rolloverOut: bigint; roundNumber: number } | null> {
    const r: any = await this.db.Round.findOne({ snapshotSlot: { $ne: null }, state: { $in: EXECUTED_STATES.filter((s) => s !== "snapshotting") } }, { snapshotSlot: 1, rolloverOut: 1, roundNumber: 1 }).sort({ snapshotSlot: -1 }).lean();
    return r ? { slot: r.snapshotSlot, rolloverOut: big(r.rolloverOut), roundNumber: r.roundNumber } : null;
  }

  private async pool(): Promise<{ pool: string | null; pools: string[]; mint: string; status: string; decimals: number | null }> {
    const s = await this.settings.get();
    const p: any = s.poolAddress ? await this.db.Pool.findOne({ poolAddress: s.poolAddress }).lean() : await this.db.Pool.findOne({}).sort({ refreshedAt: -1 }).lean();
    const pool = p?.poolAddress ?? s.poolAddress;
    // A graduated launch's activity continues on the destination pool — but only once the migration
    // was verified on-chain and its destination is supported for accounting.
    const dest = p?.migration?.verified && p?.migration?.supported ? (p.migration.destinationPool as string) : null;
    const decimals = p && p.quoteMint === s.payoutAssetMint && typeof p.quoteDecimals === "number" ? p.quoteDecimals : null;
    return { pool, pools: pool ? (dest ? [pool, dest] : [pool]) : [], mint: s.payoutAssetMint, status: p?.status ?? "unknown", decimals };
  }

  /** Match for swaps in the current (not yet snapshotted) reward period. */
  private async currentPeriodMatch(): Promise<Record<string, unknown> | null> {
    const period = await this.currentPeriod();
    return period ? periodMatch(period) : null;
  }

  private async currentPeriod() {
    const { pools } = await this.pool();
    if (!pools.length) return null;
    const last = await this.lastSnapshot();
    const pool = pools.length === 1 ? pools[0]! : pools;
    if (last) return { pool, afterSlot: last.slot, periodStartAt: null, snapshotSlot: Number.MAX_SAFE_INTEGER };
    const g = boundsOf(await this.genesisIndex(), this.params);
    return { pool, afterSlot: null, periodStartAt: new Date(g.startsAt), snapshotSlot: Number.MAX_SAFE_INTEGER };
  }

  async currentRound(): Promise<CurrentRoundDTO> {
    return this.cached("round", 500, async () => {
      const now = this.now();
      const s = await this.settings.get();
      const genesis = await this.genesisIndex();
      const index = Math.max(genesis, roundIndexAt(now, this.params));
      const b = boundsOf(index, this.params);
      const doc: any = await this.db.Round.findOne({ roundIndex: index }, "state roundNumber").lean();
      const match = await this.currentPeriodMatch();
      let qualifying = 0;
      if (match) {
        const rows = await this.db.Swap.aggregate([{ $match: { ...match, side: "buy", quoteAmount: { $gte: dec(s.minBuyQuote) } } }, { $group: { _id: "$trader" } }, { $count: "n" }]);
        qualifying = rows[0]?.n ?? 0;
      }
      const phase = phaseOf(doc, now, b.windowStartsAt);
      return {
        roundNumber: index - genesis + 1,
        startsAt: new Date(b.startsAt).toISOString(),
        endsAt: new Date(b.endsAt).toISOString(),
        finalWindowStartsAt: new Date(b.windowStartsAt).toISOString(),
        serverTime: new Date(now).toISOString(),
        phase,
        durationSeconds: this.params.roundDurationMs / 1000,
        finalWindowSeconds: this.params.windowDurationMs / 1000,
        buyerCount: s.buyerCount,
        minBuy: s.minBuyQuote.toString(),
        rewardBps: s.rewardBps,
        qualifyingBuyers: qualifying,
        settledRoundNumber: EXECUTED_STATES.includes(doc?.state) ? doc.roundNumber : null,
      };
    });
  }

  /** Payout asset descriptor. SPL payouts must equal the pool's quote mint, whose decimals were read on-chain. */
  private asset(mint: string, decimals: number | null) {
    return mint === WSOL_MINT ? { symbol: "SOL", mint, decimals: 9 } : { symbol: "TOKEN", mint, decimals: decimals ?? 0 };
  }

  async rewardPool(): Promise<RewardPoolDTO> {
    return this.cached("pool", 1000, async () => {
      const s = await this.settings.get();
      const { mint, decimals } = await this.pool();
      const period = await this.currentPeriod();
      const last = await this.lastSnapshot();
      // Only payout-eligible, creator-allocated fees (never gross pool fees).
      const fees = period ? (await periodFees(this.db, period, mint)).payout : 0n;
      const rolloverIn = last?.rolloverOut ?? 0n;
      const share = (fees * BigInt(s.rewardBps)) / 10_000n;
      const sum = async (m: Record<string, unknown>) => {
        const r: any[] = await this.db.Payout.aggregate([{ $match: { mode: "live", ...m } }, { $group: { _id: null, t: { $sum: "$amount" } } }]);
        return big(r[0]?.t ?? 0);
      };
      const [pending, total, day] = await Promise.all([sum({ state: { $in: ["pending", "signing", "submitted"] } }), sum({ state: "confirmed" }), sum({ state: "confirmed", confirmedAt: { $gte: new Date(this.now() - 86_400_000) } })]);
      return {
        asset: this.asset(mint, decimals),
        periodFees: fees.toString(),
        periodReward: (share + rolloverIn).toString(),
        periodRetained: (fees - share).toString(),
        rolloverIn: rolloverIn.toString(),
        pendingPayouts: pending.toString(),
        totalDistributed: total.toString(),
        distributed24h: day.toString(),
        rewardBps: s.rewardBps,
      };
    });
  }

  async recentBuys(limit = 30): Promise<BuyDTO[]> {
    limit = clampInt(limit, 30, 100); // also bounds the number of cache keys
    return this.cached(`buys:${limit}`, 750, async () => {
      const s = await this.settings.get();
      const { pools } = await this.pool();
      if (!pools.length) return [];
      const rows: any[] = await this.db.Swap.find({ pool: { $in: pools }, side: "buy", status: "active" }, "signature trader quoteAmount baseAmount slot blockTime commitment").sort({ slot: -1, orderInSlot: -1 }).limit(limit).lean();
      return rows.map((r) => ({
        signature: r.signature,
        wallet: r.trader,
        quoteAmount: big(r.quoteAmount).toString(),
        baseAmount: big(r.baseAmount).toString(),
        slot: r.slot,
        blockTime: r.blockTime ? new Date(r.blockTime).toISOString() : null,
        qualifies: big(r.quoteAmount) >= s.minBuyQuote,
        commitment: r.commitment,
      }));
    });
  }

  private roundSummary(r: any): RoundSummaryDTO {
    return {
      roundNumber: r.roundNumber,
      startsAt: new Date(r.startsAt).toISOString(),
      endsAt: new Date(r.endsAt).toISOString(),
      settledAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
      phase: phaseOf(r, this.now(), Infinity),
      fees: big(r.fees).toString(),
      reward: big(r.reward).toString(),
      retained: big(r.retained).toString(),
      rolloverIn: big(r.rolloverIn).toString(),
      rolloverOut: big(r.rolloverOut).toString(),
      dust: big(r.dust).toString(),
      perRecipient: big(r.perRecipient).toString(),
      recipientCount: r.recipientCount ?? 0,
      paid: big(r.paid).toString(),
      dryRun: !!r.dryRun,
    };
  }

  private payoutDTO(p: any): PayoutDTO {
    const state = p.state === "signing" ? "pending" : p.state;
    return {
      roundNumber: p.roundNumber,
      recipient: p.recipient,
      amount: big(p.amount).toString(),
      state,
      // Only expose a signature once it is final; in-flight signatures are public on-chain anyway
      // but we avoid presenting an unconfirmed transaction as a payout.
      signature: p.state === "confirmed" ? p.confirmedSignature : null,
      confirmedAt: p.confirmedAt ? new Date(p.confirmedAt).toISOString() : null,
    };
  }

  async rounds(o: { before?: number; limit?: number } = {}): Promise<{ items: RoundSummaryDTO[]; nextCursor: string | null }> {
    const limit = Math.min(o.limit ?? 20, 100);
    const q: Record<string, unknown> = { state: { $in: [...EXECUTED_STATES.filter((s) => s !== "snapshotting"), "missed"] } };
    if (o.before) q.roundNumber = { $lt: o.before };
    const rows: any[] = await this.db.Round.find(q, PUBLIC_ROUND_FIELDS).sort({ roundNumber: -1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit).map((r) => this.roundSummary(r));
    return { items, nextCursor: rows.length > limit ? String(items[items.length - 1]!.roundNumber) : null };
  }

  async round(n: number): Promise<RoundDetailDTO | null> {
    const r: any = await this.db.Round.findOne({ roundNumber: n }, PUBLIC_ROUND_FIELDS).lean();
    if (!r || !EXECUTED_STATES.concat("missed").includes(r.state) || r.state === "snapshotting") return null;
    const payouts: any[] = await this.db.Payout.find({ roundNumber: n }, "roundNumber recipient amount state confirmedSignature confirmedAt position").sort({ position: 1 }).lean();
    return {
      ...this.roundSummary(r),
      snapshotSlot: r.snapshotSlot ?? null,
      buyerCount: r.config?.buyerCount ?? 0,
      minBuy: big(r.config?.minBuyQuote).toString(),
      rewardBps: r.config?.rewardBps ?? 0,
      payouts: payouts.map((p) => this.payoutDTO(p)),
    };
  }

  async payouts(o: { before?: string; limit?: number } = {}): Promise<{ items: PayoutDTO[]; nextCursor: string | null }> {
    const limit = Math.min(o.limit ?? 50, 200);
    const q: Record<string, unknown> = { state: { $in: ["confirmed", "simulated"] } };
    if (o.before) q.confirmedAt = { $lt: new Date(o.before) };
    const rows: any[] = await this.db.Payout.find(q, "roundNumber recipient amount state confirmedSignature confirmedAt").sort({ confirmedAt: -1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit).map((p) => this.payoutDTO(p));
    return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.confirmedAt : null };
  }

  async stats(): Promise<StatsDTO> {
    return this.cached("stats", 2000, async () => {
      const { mint, decimals } = await this.pool();
      const ledgerSum = async (types: string[]) => {
        const r: any[] = await this.db.LedgerEntry.aggregate([{ $match: { type: { $in: types }, mint } }, { $group: { _id: null, t: { $sum: "$amount" } } }]);
        return big(r[0]?.t ?? 0);
      };
      const [fees, paid, retained, pendingRows, payoutCount, settledRounds, recipients, buyers, pool] = await Promise.all([
        ledgerSum(["FEE_ACCRUED"]),
        ledgerSum(["PAYOUT_CONFIRMED"]),
        ledgerSum(["RETAINED", "DUST_RETAINED"]),
        this.db.Payout.aggregate([{ $match: { mode: "live", state: { $in: ["pending", "signing", "submitted"] } } }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
        this.db.Payout.countDocuments({ state: "confirmed" }),
        this.db.Round.countDocuments({ state: { $in: ["completed", "rolled_over"] } }),
        this.db.Payout.distinct("recipient", { state: "confirmed" }),
        this.db.BuyerActivity.countDocuments({}),
        this.rewardPool(),
      ]);
      return {
        asset: this.asset(mint, decimals),
        totalFeesAccrued: fees.toString(),
        totalPaid: paid.toString(),
        totalPending: big(pendingRows[0]?.t ?? 0).toString(),
        totalRetained: retained.toString(),
        currentReward: pool.periodReward,
        payoutCount,
        settledRounds,
        uniqueRecipients: recipients.length,
        uniqueBuyers: buyers,
      };
    });
  }

  async chart(limit = 24): Promise<FeeChartPointDTO[]> {
    limit = clampInt(limit, 24, 200);
    return this.cached(`chart:${limit}`, 5000, async () => {
      const rows: any[] = await this.db.Round.find({ state: { $in: ["paying", "awaiting_funds", "completed", "rolled_over", "attention"] } }, "roundNumber fees reward recipientCount").sort({ roundNumber: -1 }).limit(limit).lean();
      return rows.reverse().map((r) => ({ roundNumber: r.roundNumber, fees: big(r.fees).toString(), reward: big(r.reward).toString(), recipients: r.recipientCount ?? 0 }));
    });
  }

  async terminal(o: { before?: number; after?: number; limit?: number } = {}) {
    const limit = Math.min(o.limit ?? 50, 200);
    const q: Record<string, unknown> = {};
    if (o.before) q.seq = { $lt: o.before };
    if (o.after) q.seq = { $gt: o.after };
    const rows: any[] = await this.db.TerminalEvent.find(q, "seq ts type message roundNumber signature details").sort({ seq: o.after ? 1 : -1 }).limit(limit).lean();
    const items = rows.map(toTerminalDTO);
    return { items, nextCursor: !o.after && rows.length === limit ? String(rows[rows.length - 1].seq) : null };
  }

  async dashboard(): Promise<DashboardSnapshotDTO> {
    const s = await this.settings.get();
    const p = await this.pool();
    const [round, pool, stats, recentBuys, recentRounds, chart] = await Promise.all([this.currentRound(), this.rewardPool(), this.stats(), this.recentBuys(25), this.rounds({ limit: 12 }), this.chart(24)]);
    return {
      round,
      pool,
      stats,
      recentBuys,
      recentRounds: recentRounds.items,
      chart,
      meta: {
        appName: this.cfg.public.appName,
        cluster: this.cfg.solana.cluster,
        provider: s.launchProvider,
        tokenMint: s.tokenMint ?? "",
        poolAddress: p.pool ?? "",
        payoutMode: s.payoutMode,
        explorer: this.cfg.public.explorer,
        poolStatus: (p.status as any) ?? "unknown",
      },
    };
  }
}
