/**
 * RoundScheduler — clock-anchored five-minute rounds with a private, CSPRNG-chosen execution
 * instant inside the final window.
 *
 * Safety properties (all covered by tests):
 *   - The execute time is drawn once per round (compare-and-set) and sealed with AES-GCM; a
 *     restart decrypts and reuses it, never re-draws it.
 *   - Execution is a CAS from open/scheduled → snapshotting with a fencing token, so two workers
 *     can never execute the same round; a crashed execution is resumed after its lock expires,
 *     reusing the persisted snapshot slot (deterministic).
 *   - Allocation, payouts and ledger entries are committed in ONE MongoDB transaction.
 */
import type { Keypair } from "@solana/web3.js";
import type { AppConfig } from "../config/env";
import type { EffectiveSettings, SettingsStore } from "../config/runtime";
import type { ChainRpc } from "../chain/rpc";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import { inTransaction } from "../db/connection";
import type { LaunchProvider } from "../providers/LaunchProvider";
import type { TerminalWriter } from "../terminal/terminal";
import { randomToken, seal, secureRandomInt, unseal } from "../util/crypto";
import type { Clock } from "../util/time";
import { rootLogger, type Logger } from "../util/logger";
import { cursorId, readCursor, syncAddress } from "../indexer/signatureSync";
import { allocate } from "./allocation";
import { boundsOf, drawExecuteAt, roundIndexAt, type ScheduleParams } from "./roundMath";
import { periodFees, selectRecipients } from "./selection";
import { persistAttributions } from "../indexer/ingest";

export interface SchedulerDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  rpc: ChainRpc;
  provider: () => LaunchProvider;
  payer: Keypair | null;
  terminal: TerminalWriter;
  clock: Clock;
  random?: (min: number, max: number) => number;
  log?: Logger;
  onRoundPlanned?: (roundNumber: number) => void;
  /** Max signatures a pre-snapshot catch-up may ingest beyond the indexer cursor (default 20 000). */
  catchUpCap?: number;
}

const LOCK_MS = 90_000;
const MAX_MISSED_PLACEHOLDERS = 288;

export class RoundScheduler {
  private readonly log: Logger;
  private readonly params: ScheduleParams;
  private readonly key: Buffer;
  private genesisIndex: number | null = null;
  readonly owner: string;

  constructor(private readonly d: SchedulerDeps) {
    this.log = (d.log ?? rootLogger()).child({ component: "scheduler" });
    this.params = {
      roundDurationMs: d.cfg.schedule.roundDurationMs,
      windowStartMs: d.cfg.schedule.windowStartMs,
      windowDurationMs: d.cfg.schedule.windowDurationMs,
      anchorEpochMs: d.cfg.schedule.anchorEpochMs,
    };
    if (!d.cfg.schedule.encryptionKey) throw new Error("SCHEDULE_ENCRYPTION_KEY is required by the scheduler");
    this.key = d.cfg.schedule.encryptionKey;
    this.owner = d.cfg.instanceId;
  }

  get schedule() {
    return this.params;
  }

  /** Genesis is persisted on first boot so round numbers are stable forever. */
  async ensureGenesis(now: number): Promise<number> {
    if (this.genesisIndex !== null) return this.genesisIndex;
    const desired = this.d.cfg.schedule.genesisAt ? roundIndexAt(this.d.cfg.schedule.genesisAt.getTime(), this.params) : roundIndexAt(now, this.params);
    await this.d.db.SystemState.updateOne({ _id: "genesis" }, { $setOnInsert: { value: { roundIndex: desired, params: this.params } } }, { upsert: true });
    const doc: any = await this.d.db.SystemState.findById("genesis").lean();
    const stored = doc.value;
    if (stored.params && (stored.params.roundDurationMs !== this.params.roundDurationMs || stored.params.anchorEpochMs !== this.params.anchorEpochMs)) {
      throw new Error("ROUND_DURATION_SECONDS / ROUND_ANCHOR_EPOCH_SECONDS differ from the values this database was started with; changing them would renumber history");
    }
    this.genesisIndex = stored.roundIndex as number;
    return this.genesisIndex;
  }

  roundNumberOf(index: number) {
    return index - this.genesisIndex! + 1;
  }

  private aad(roundNumber: number) {
    return `last60:round:${roundNumber}:executeAt`;
  }

  /** Create the round document for `index` if missing (idempotent). */
  async ensureRound(index: number) {
    const b = boundsOf(index, this.params);
    const roundNumber = this.roundNumberOf(index);
    const r = await this.d.db.Round.updateOne(
      { roundIndex: index },
      { $setOnInsert: { roundIndex: index, roundNumber, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt), windowStartsAt: new Date(b.windowStartsAt), state: "open" } },
      { upsert: true },
    );
    if (r.upsertedCount) {
      const s = await this.d.settings.get();
      await this.d.terminal.roundInitialized(roundNumber);
      await this.d.terminal.monitoring(roundNumber, s.minBuyQuote);
    }
    return roundNumber;
  }

  /**
   * Draw (once) and seal the private execute time. Returns the decrypted instant.
   * The CAS on `executeAtCipher: null` guarantees a single draw even with concurrent workers.
   */
  async ensureExecuteAt(index: number, now: number): Promise<number | null> {
    const b = boundsOf(index, this.params);
    if (now < b.windowStartsAt) return null; // drawn at the window start, not before
    const roundNumber = this.roundNumberOf(index);
    const existing: any = await this.d.db.Round.findOne({ roundIndex: index }).select("+executeAtCipher state").lean();
    if (!existing) return null;
    if (!existing.executeAtCipher) {
      const { executeAt } = drawExecuteAt(b, now, this.d.random ?? secureRandomInt);
      const cipher = seal(this.key, String(executeAt), this.aad(roundNumber));
      await this.d.db.Round.updateOne({ roundIndex: index, executeAtCipher: null, state: { $in: ["open", "scheduled"] } }, { $set: { executeAtCipher: cipher, scheduleGeneratedAt: new Date(now), state: "scheduled" } });
      this.log.info({ roundNumber }, "execution scheduled"); // the instant itself is never logged
    }
    const doc: any = await this.d.db.Round.findOne({ roundIndex: index }).select("+executeAtCipher").lean();
    if (!doc?.executeAtCipher) return null;
    return Number(unseal(this.key, doc.executeAtCipher, this.aad(roundNumber)));
  }

  /** Mark rounds whose whole window passed without a snapshot as missed (and fill gaps). */
  async markMissed(currentIndex: number, now: number) {
    const graceMs = this.d.cfg.schedule.lateGraceMs;
    const stale: any[] = await this.d.db.Round.find({ state: { $in: ["open", "scheduled"] }, roundIndex: { $lt: currentIndex + 1 } }).lean();
    for (const r of stale) {
      if (new Date(r.endsAt).getTime() + graceMs >= now) continue;
      const res = await this.d.db.Round.updateOne({ _id: r._id, state: { $in: ["open", "scheduled"] } }, { $set: { state: "missed", outcome: "engine unavailable during the final window; buys and fees carry into the next executed round", completedAt: new Date(now) } });
      if (res.modifiedCount) await this.d.terminal.missed(r.roundNumber);
    }
    // Placeholders for rounds that elapsed while the engine was entirely down.
    const last: any = await this.d.db.Round.findOne({ roundIndex: { $lt: currentIndex } }, { roundIndex: 1 }).sort({ roundIndex: -1 }).lean();
    if (last && currentIndex - last.roundIndex > 1) {
      const from = Math.max(last.roundIndex + 1, currentIndex - MAX_MISSED_PLACEHOLDERS);
      for (let i = from; i < currentIndex; i++) {
        const b = boundsOf(i, this.params);
        await this.d.db.Round.updateOne(
          { roundIndex: i },
          { $setOnInsert: { roundIndex: i, roundNumber: this.roundNumberOf(i), startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt), windowStartsAt: new Date(b.windowStartsAt), state: "missed", outcome: "engine offline", completedAt: new Date(now) } },
          { upsert: true },
        );
      }
      await this.d.terminal.warn(`Engine was offline for ${currentIndex - last.roundIndex - 1} round(s); their buys and fees carry into the next executed round.`, `offline:${last.roundIndex}:${currentIndex}`);
    }
  }

  /**
   * One scheduling step. Returns the time (ms) at which it next needs to run, so the caller can
   * sleep precisely until the execute instant instead of polling.
   */
  async tick(now = this.d.clock.now()): Promise<number> {
    const s = await this.d.settings.get();
    const genesis = await this.ensureGenesis(now);
    const index = roundIndexAt(now, this.params);
    const b = boundsOf(index, this.params);
    if (index < genesis) return boundsOf(genesis, this.params).startsAt;
    if (s.pauseScheduler) return now + 1000;

    await this.ensureRound(index);
    await this.markMissed(index, now);
    await this.recoverStuck(now);

    // Candidates: the current round and, within grace, the previous one (tick may straddle).
    let wake = b.endsAt;
    for (const i of [index - 1, index]) {
      if (i < genesis) continue;
      const bi = boundsOf(i, this.params);
      if (now > bi.endsAt + this.d.cfg.schedule.lateGraceMs) continue;
      const executeAt = await this.ensureExecuteAt(i, now);
      if (executeAt === null) {
        wake = Math.min(wake, bi.windowStartsAt);
        continue;
      }
      if (now >= executeAt) {
        const r: any = await this.d.db.Round.findOne({ roundIndex: i }).lean();
        if (r && (r.state === "open" || r.state === "scheduled")) await this.execute(r._id, now);
      } else {
        wake = Math.min(wake, executeAt);
      }
    }
    return Math.max(now + 5, Math.min(wake, now + 1000));
  }

  /** Resume executions whose worker died mid-snapshot (lock expired). */
  async recoverStuck(now: number) {
    const stuck: any[] = await this.d.db.Round.find({ state: "snapshotting", "lock.expiresAt": { $lt: new Date(now) } }).sort({ roundNumber: 1 }).lean();
    for (const r of stuck) {
      this.log.warn({ roundNumber: r.roundNumber }, "resuming interrupted snapshot");
      await this.execute(r._id, now, true);
    }
  }

  /** Snapshot + allocation for one round. Idempotent and crash-safe. */
  async execute(roundId: unknown, now: number, recovering = false) {
    // Periods must tile the chain: never snapshot while an earlier round is unfinished.
    const target: any = await this.d.db.Round.findById(roundId, { roundNumber: 1 }).lean();
    if (!target) return;
    if (await this.d.db.Round.exists({ roundNumber: { $lt: target.roundNumber }, state: "snapshotting" })) {
      this.log.warn({ roundNumber: target.roundNumber }, "waiting for an earlier round's snapshot to complete");
      return;
    }
    const token = randomToken(12);
    const lockFilter = recovering
      ? { _id: roundId, state: "snapshotting", "lock.expiresAt": { $lt: new Date(now) } }
      : { _id: roundId, state: { $in: ["open", "scheduled"] } };
    const locked: any = await this.d.db.Round.findOneAndUpdate(
      lockFilter,
      { $set: { state: "snapshotting", lock: { owner: this.owner, token, expiresAt: new Date(now + LOCK_MS) } }, $inc: { attempts: 1 } },
      { returnDocument: "after" },
    ).lean();
    if (!locked) return; // another worker owns it, or it is already done
    const roundNumber: number = locked.roundNumber;
    const fence = { _id: roundId, state: "snapshotting", "lock.token": token };
    try {
      // 1. Fix the snapshot slot (persist before anything else; reused on recovery).
      let snapshotSlot: number | null = locked.snapshotSlot;
      let executedAt: Date = locked.executedAt ?? new Date(now);
      // Periods tile the chain only if snapshot slots strictly increase. A lagging RPC node (load
      // balancer, failover) can report a slot at or below the previous snapshot; accepting it would
      // re-open an already-paid period and re-use its rollover — i.e. pay the same fees twice.
      const floor: any = await this.d.db.Round.findOne({ roundNumber: { $lt: locked.roundNumber }, snapshotSlot: { $ne: null } }, { snapshotSlot: 1, roundNumber: 1 }).sort({ snapshotSlot: -1 }).lean();
      if (snapshotSlot === null) {
        const observed = await this.d.rpc.getSlot("confirmed");
        if (floor && observed <= floor.snapshotSlot) {
          throw new Error(`RPC reported slot ${observed}, not after round #${floor.roundNumber}'s snapshot slot ${floor.snapshotSlot} (lagging node); refusing to snapshot`);
        }
        snapshotSlot = observed;
        const r = await this.d.db.Round.updateOne({ ...fence, snapshotSlot: null }, { $set: { snapshotSlot, executedAt } });
        if (!r.modifiedCount) throw new LostLockError();
      } else if (floor && snapshotSlot <= floor.snapshotSlot) {
        throw new Error(`persisted snapshot slot ${snapshotSlot} is not after round #${floor.roundNumber}'s snapshot slot ${floor.snapshotSlot}; operator review required`);
      }
      await this.d.terminal.processingStarted(roundNumber);

      // 2. Reward period: (previous snapshot slot, this snapshot slot]. With no earlier snapshot
      //    the period starts at genesis, so buys/fees of missed initial rounds are not lost.
      const settings = await this.d.settings.get(true);
      const provider = this.d.provider();
      const pool = provider.info();
      const prev: any = await this.d.db.Round.findOne({ snapshotSlot: { $ne: null, $lt: snapshotSlot }, roundNumber: { $lt: roundNumber }, state: { $nin: ["snapshotting"] } }).sort({ snapshotSlot: -1 }).lean();
      const genesisStart = boundsOf(await this.ensureGenesis(now), this.params).startsAt;
      // Provider/pool switch: the first period after a switch also covers the previous pool's
      // already-indexed activity between the previous snapshot and the switch (e.g. the last
      // bonding-curve trades before graduation). Without this those fees and buyers would belong to
      // no round at all — silently.
      const previousPool: string | null = prev?.config?.pool && prev.config.pool !== pool.poolAddress ? prev.config.pool : null;
      // Accounting pools: the bonding pool plus, once VERIFIED, the graduation destination — so the
      // final bonding-curve trades and the first destination trades fall into consecutive periods
      // by slot, never both and never neither.
      const current = pool.accountingPools?.length ? pool.accountingPools : [pool.poolAddress];
      const carried: string[] = previousPool ? [previousPool, ...((prev?.config?.pools as string[] | undefined) ?? []).filter((x) => x !== pool.poolAddress)] : [];
      const pools = [...new Set([...carried, ...current])];
      const period = { pool: pools.length === 1 ? pools[0]! : pools, afterSlot: prev?.snapshotSlot ?? null, periodStartAt: prev ? null : new Date(genesisStart), snapshotSlot };

      // 3. Make sure every transaction of the period up to the snapshot slot is ingested.
      const settleUntil = executedAt.getTime() + this.d.cfg.schedule.snapshotSettleMs;
      const wait = settleUntil - this.d.clock.now();
      if (wait > 0) await this.d.clock.sleep(wait);
      await this.catchUp(snapshotSlot, { afterSlot: period.afterSlot, sinceTime: period.periodStartAt ? Math.floor(period.periodStartAt.getTime() / 1000) : null });
      if (previousPool) {
        await this.d.terminal.warn(`Pool changed since round #${prev.roundNumber}: this period also includes the previous pool's indexed activity up to the switch.`, `pool-switch:${roundNumber}`, roundNumber);
      }
      // 3b. Checkpointed entitlements (e.g. DAMM v2 LP position fee growth) up to the snapshot slot.
      //     Idempotent: records are keyed by snapshot slot, so a resumed execution reuses them.
      if (provider.checkpoint) {
        const records = await provider.checkpoint(snapshotSlot, async (key) => {
          const last: any = await this.d.db.FeeAttribution.findOne({ checkpointKey: key, slot: { $lt: snapshotSlot }, cumulative: { $ne: null } }, { cumulative: 1, slot: 1 }).sort({ slot: -1 }).lean();
          return last ? { cumulative: BigInt(last.cumulative), slot: last.slot } : null;
        });
        if (records.length) await persistAttributions(this.d.db, records);
      }
      const excluded = new Set([...settings.excludedWallets, pool.beneficiary, pool.creator, ...(this.d.payer ? [this.d.payer.publicKey.toBase58()] : []), ...(settings.expectedPayoutPublicKey ? [settings.expectedPayoutPublicKey] : [])]);
      const selection = await selectRecipients(this.d.db, this.d.rpc, { ...period, minBuyQuote: settings.minBuyQuote, buyerCount: settings.buyerCount, excluded });
      const fees = await periodFees(this.d.db, period, settings.payoutAssetMint);
      const rolloverIn = prev ? big(prev.rolloverOut) : 0n;
      const a = allocate({ fees: fees.payout, rolloverIn, rewardBps: settings.rewardBps, recipients: selection.recipients.map((r) => r.wallet), minPayout: settings.minPayoutLamports, skippedRoundPolicy: settings.skippedRoundPolicy });
      const dryRun = settings.payoutMode !== "live";
      const mint = settings.payoutAssetMint;

      // 4. Commit everything atomically.
      await inTransaction(this.d.db, async (session) => {
        const nextState = a.payouts.length ? "paying" : "rolled_over";
        const res = await this.d.db.Round.updateOne(
          fence,
          {
            $set: {
              state: nextState,
              prevSnapshotSlot: prev?.snapshotSlot ?? null,
              prevRoundNumber: prev?.roundNumber ?? null,
              periodStartAt: period.periodStartAt,
              config: {
                buyerCount: settings.buyerCount,
                minBuyQuote: dec(settings.minBuyQuote),
                rewardBps: settings.rewardBps,
                payoutMint: mint,
                payoutMode: settings.payoutMode,
                provider: pool.provider,
                pool: pool.poolAddress,
                previousPool,
                pools,
                tokenMint: pool.tokenMint,
                skippedRoundPolicy: settings.skippedRoundPolicy,
                minPayoutLamports: dec(settings.minPayoutLamports),
                settingsVersion: settings.version,
              },
              fees: dec(a.fees),
              nonPayoutAssetFees: fees.other.map((o) => ({ mint: o.mint, amount: dec(o.amount) })),
              ineligibleFees: fees.ineligible.map((o) => ({ mint: o.mint, amount: dec(o.amount), reason: o.reason.slice(0, 300) })),
              feeBreakdown: { byPhase: fees.byPhase, swaps: fees.swaps, attributions: fees.attributions },
              reward: dec(a.pool),
              retained: dec(a.retained + a.retainedPool),
              rolloverIn: dec(a.rolloverIn),
              rolloverOut: dec(a.rolloverOut),
              dust: dec(a.dust),
              perRecipient: dec(a.perRecipient),
              recipientCount: a.payouts.length,
              eligibleBuyerCount: selection.eligibleBuyerCount,
              paid: dec(0n),
              pending: dec(a.payouts.reduce((s, p) => s + p.amount, 0n)),
              failed: dec(0n),
              dryRun,
              outcome: a.outcome === "paid" ? (selection.tieBreak !== "none" ? `paid (intra-slot tie broken by ${selection.tieBreak})` : "paid") : a.outcome,
              lock: null,
              lastError: null,
              ...(nextState === "rolled_over" ? { completedAt: new Date(this.d.clock.now()) } : {}),
            },
          },
          { session },
        );
        if (!res.modifiedCount) throw new LostLockError();
        if (a.payouts.length) {
          await this.d.db.Payout.insertMany(
            a.payouts.map((p) => ({ roundNumber, recipient: p.recipient, position: p.position, amount: dec(p.amount), mint, mode: dryRun ? "dry_run" : "live", state: "pending" })),
            { session },
          );
        }
        const L = (type: string, amount: bigint, extra: Record<string, unknown> = {}) => ({ key: `${type}:r${roundNumber}${extra.k ? ":" + extra.k : ""}`, type, roundNumber, amount: dec(amount), mint: (extra.mint as string) ?? mint, memo: (extra.memo as string) ?? null });
        const entries = [
          L("FEE_ACCRUED", a.fees, { memo: `${fees.swaps} swaps + ${fees.attributions} attributions in slots (${period.afterSlot ?? "start"}, ${snapshotSlot}]; payout-eligible creator allocation only` }),
          L("REWARD_ALLOCATED", a.rewardShare),
          L("RETAINED", a.retained + a.retainedPool, { memo: a.retainedPool > 0n ? "includes skipped-round pool (retain policy)" : null }),
          ...(a.rolloverIn > 0n ? [L("ROLLOVER_IN", a.rolloverIn, { memo: `from round #${prev?.roundNumber}` })] : []),
          ...(a.rolloverOut > 0n ? [L("ROLLOVER_OUT", a.rolloverOut, { memo: a.outcome })] : []),
          ...(a.dust > 0n ? [L("DUST_RETAINED", a.dust)] : []),
          ...fees.other.map((o) => L("FEE_NON_PAYOUT_ASSET", o.amount, { mint: o.mint, k: o.mint, memo: "recorded only; never converted" })),
          ...fees.ineligible.map((o, i) => L("FEE_EXCLUDED", o.amount, { mint: o.mint, k: `${o.mint}:${i}`, memo: `not payout-eligible: ${o.reason.slice(0, 200)}` })),
          ...a.payouts.map((p) => L("PAYOUT_SCHEDULED", p.amount, { k: p.recipient, memo: `position ${p.position}` })),
        ];
        await this.d.db.LedgerEntry.insertMany(entries, { session });
      });

      // 5. Non-critical bookkeeping (after commit).
      const slotRange = { $lte: snapshotSlot, ...(period.afterSlot !== null ? { $gt: period.afterSlot } : {}) };
      await this.d.db.Swap.updateMany({ pool: { $in: pools }, slot: slotRange, roundNumber: null }, { $set: { roundNumber } });
      await this.d.db.FeeAttribution.updateMany({ pool: { $in: pools }, slot: slotRange, roundNumber: null }, { $set: { roundNumber } });
      if (fees.ineligible.length) await this.d.terminal.warn(`Round #${roundNumber}: some creator fees in this period are recorded but not eligible for payout (unverified or mismatching allocation); operators notified.`, `ineligible:${roundNumber}`, roundNumber);
      if (a.payouts.length) {
        await this.d.terminal.accounting(roundNumber, { fees: a.fees, reward: a.pool, retained: a.retained, recipients: a.payouts.length, perRecipient: a.perRecipient, rolloverIn: a.rolloverIn });
      } else {
        const reason = a.outcome === "no_buyers" ? "no qualifying buyers" : a.outcome === "no_fees" ? "no eligible fees accrued" : "reward per wallet below the minimum payout";
        await this.d.terminal.skipped(roundNumber, reason, a.rolloverOut);
      }
      this.log.info({ roundNumber, snapshotSlot, outcome: a.outcome, recipients: a.payouts.length, fees: a.fees.toString(), reward: a.pool.toString() }, "round planned");
      this.d.onRoundPlanned?.(roundNumber);
    } catch (err: any) {
      if (err instanceof LostLockError) {
        this.log.warn({ roundNumber }, "lost round lock during execution; another worker continues");
        return;
      }
      // Release the lock early so recovery retries soon; snapshotSlot stays persisted.
      await this.d.db.Round.updateOne(fence, { $set: { "lock.expiresAt": new Date(this.d.clock.now() + 2000), lastError: String(err?.message ?? err).slice(0, 500) } });
      this.log.error({ roundNumber, err: String(err?.message ?? err) }, "round execution failed; will retry");
      throw err;
    }
  }

  /**
   * Ingest everything up to the snapshot slot. Read-only w.r.t. the indexer's cursor; idempotent.
   * Throws (round retried) rather than snapshotting incomplete data.
   */
  async catchUp(snapshotSlot: number, bounds: { afterSlot: number | null; sinceTime: number | null }) {
    const provider = this.d.provider();
    const pool = provider.info();
    const settings = await this.d.settings.get();
    for (const address of pool.watchAddresses) {
      const key = cursorId(pool.provider, pool.poolAddress, address);
      const cursor = await readCursor(this.d.db, key);
      // Bounded: from the indexer's cursor if it has one, never further back than the period.
      // `minContextSlot`: the node must have processed the snapshot slot before answering, so a
      // lagging backend cannot silently omit transactions at or below it.
      const r = await syncAddress(
        { db: this.d.db, provider, terminal: this.d.terminal, minBuyQuote: settings.minBuyQuote, rpc: this.d.rpc, log: this.log },
        address,
        { untilSignature: cursor?.lastSignature ?? null, source: "catchup", cap: this.d.catchUpCap ?? 20_000, concurrency: 4, bounds, minContextSlot: snapshotSlot },
      );
      if (r.truncated) throw new Error(`catch-up for ${address} exceeds ${this.d.catchUpCap ?? 20_000} signatures beyond the indexer cursor; refusing to snapshot incomplete data (round retried)`);
    }
    // Every signature returned by a node at or past the snapshot slot is ingested.
  }
}

class LostLockError extends Error {
  constructor() {
    super("lost round lock");
  }
}
