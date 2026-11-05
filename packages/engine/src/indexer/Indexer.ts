/**
 * The indexer process: keeps the `swaps` and `fee_claims` collections a complete, de-duplicated
 * mirror of every trade and claim on the configured pool.
 *
 *   websocket  → low latency (optional)
 *   poll       → completeness backstop from a persisted cursor (gap-free, survives restarts)
 *   backfill   → full history on first start
 *   finality   → confirmed → finalized, or dropped (forked out) and excluded
 *   refresh    → re-reads pool state (fee params, migration status)
 */
import type { AppConfig } from "../config/env";
import type { EffectiveSettings, SettingsStore } from "../config/runtime";
import type { ChainRpc } from "../chain/rpc";
import { RpcClient } from "../chain/rpc";
import { LogsSubscriber } from "../chain/ws";
import type { Models } from "../db/models";
import { big } from "../db/decimal";
import { attachStoredMigration, createProvider, resolveAndAttachMigration, type LaunchProvider, type PoolInfo } from "../providers";
import { roleChangeBlockReason } from "../accounting/attribution";
import { TerminalWriter } from "../terminal/terminal";
import { heartbeat, Lease } from "../util/lease";
import { rootLogger, type Logger } from "../util/logger";
import { sleep } from "../util/time";
import { backoffDelay } from "../util/backoff";
import { cursorId, ingestSignature, readCursor, syncAddress } from "./signatureSync";
import { boundsOf, roundIndexAt } from "../rewards/roundMath";

export interface IndexerDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  /** Injected for tests; production builds an RpcClient from settings. */
  rpc?: ChainRpc;
  wsFactory?: ((url: string, addresses: string[], onLog: (sig: string) => void) => { start(): void; stop(): void; connected: boolean }) | null;
  log?: Logger;
}

export class Indexer {
  private readonly log: Logger;
  private readonly terminal: TerminalWriter;
  private readonly lease: Lease;
  private provider: LaunchProvider | null = null;
  private pool: PoolInfo | null = null;
  private rpc: ChainRpc | null = null;
  private ws: { start(): void; stop(): void; connected: boolean } | null = null;
  private settingsVersion = -1;
  private settings: EffectiveSettings | null = null;
  private wsQueue = new Set<string>();
  private recent = new Map<string, number>();
  private stopped = false;
  private backlog = false;
  private leader = false;
  private status: { status: string; detail: string | null } = { status: "running", detail: null };
  metrics = { polls: 0, lastPollAt: 0, lastSlot: 0, swapsIngested: 0, claimsIngested: 0, errors: 0, wsNotifications: 0, finalized: 0, dropped: 0 };

  constructor(private readonly deps: IndexerDeps) {
    this.log = (deps.log ?? rootLogger()).child({ component: "indexer" });
    this.terminal = new TerminalWriter(deps.db, deps.cfg.terminal.retentionDays);
    this.lease = new Lease(deps.db, "indexer", deps.cfg.instanceId);
  }

  get poolInfo() {
    return this.pool;
  }

  private ctx() {
    return { db: this.deps.db, provider: this.provider!, terminal: this.terminal, minBuyQuote: this.settings!.minBuyQuote, rpc: this.rpc!, log: this.log };
  }

  /** Load settings and provider once (used by tests and by `run`). */
  async init() {
    const s = await this.deps.settings.get(true);
    await this.configure(s);
    this.settingsVersion = s.version;
    return this.pool!;
  }

  /** (Re)initialise provider + RPC when relevant settings change. */
  private async configure(s: EffectiveSettings) {
    const relevant = JSON.stringify([s.launchProvider, s.poolAddress, s.tokenMint, s.feeBeneficiaryRole, s.rpcUrls, s.wsUrl, s.indexerUseWebsocket, s.payoutAssetMint]);
    const prev = this.settings ? JSON.stringify([this.settings.launchProvider, this.settings.poolAddress, this.settings.tokenMint, this.settings.feeBeneficiaryRole, this.settings.rpcUrls, this.settings.wsUrl, this.settings.indexerUseWebsocket, this.settings.payoutAssetMint]) : null;
    this.settings = s;
    if (relevant === prev && this.provider) return;
    this.ws?.stop();
    this.ws = null;
    this.rpc = this.deps.rpc ?? new RpcClient({ urls: s.rpcUrls, timeoutMs: this.deps.cfg.solana.timeoutMs, maxRps: this.deps.cfg.solana.maxRps, maxTxVersion: this.deps.cfg.solana.maxTxVersion, logger: this.log });
    const provider = createProvider({ id: s.launchProvider, poolAddress: s.poolAddress, tokenMint: s.tokenMint, role: s.feeBeneficiaryRole, payoutMint: s.payoutAssetMint, expected: this.deps.cfg.provider.expected }, this.rpc);
    const loaded = await provider.load();
    // U1: never index a pool under a different beneficiary role than its existing records (an
    // environment change bypasses the settings-store check, so it is enforced here too).
    const blocked = await roleChangeBlockReason(this.deps.db, loaded.poolAddress, loaded.feeBeneficiaryRole);
    if (blocked) {
      await this.terminal.error(`Indexer refused to attach: fee beneficiary role conflicts with existing records for this pool.`, `role-conflict:${loaded.poolAddress}:${loaded.feeBeneficiaryRole}`).catch(() => undefined);
      throw new Error(blocked);
    }
    this.provider = provider;
    await attachStoredMigration(this.deps.db, this.provider);
    this.pool = this.provider.info();
    await this.savePool(this.pool);
    this.log.info({ provider: this.pool.provider, pool: this.pool.poolAddress, mint: this.pool.tokenMint, beneficiary: this.pool.beneficiary, status: this.pool.status, feeParams: this.pool.feeParams }, "provider loaded");
    await this.terminal.system(`Indexer attached to ${this.pool.provider} pool ${this.pool.poolAddress.slice(0, 4)}…${this.pool.poolAddress.slice(-4)}.`, `attach:${this.pool.provider}:${this.pool.poolAddress}:${s.version}`);
    for (const w of this.pool.warnings ?? []) await this.terminal.warn(`Pool configuration: ${w}.`, `pool-warning:${this.pool.poolAddress}:${s.version}:${w.slice(0, 40)}`);
    if (this.pool.status !== "bonding") {
      await this.migrationWarning(this.pool);
      await this.recordMigration(this.pool);
    }
    const wsUrl = s.wsUrl;
    if (s.indexerUseWebsocket && wsUrl && this.deps.wsFactory !== null) {
      const onLog = (sig: string) => {
        this.metrics.wsNotifications++;
        this.wsQueue.add(sig);
      };
      this.ws = this.deps.wsFactory
        ? this.deps.wsFactory(wsUrl, this.pool.watchAddresses, onLog)
        : new LogsSubscriber(wsUrl, this.pool.watchAddresses, (n) => !n.err && onLog(n.signature), this.log);
      this.ws.start();
    }
  }

  private async savePool(p: PoolInfo) {
    await this.deps.db.Pool.updateOne(
      { key: `${p.provider}:${p.poolAddress}` },
      {
        $set: {
          provider: p.provider,
          poolAddress: p.poolAddress,
          tokenMint: p.tokenMint,
          quoteMint: p.quoteMint,
          baseDecimals: p.baseDecimals,
          quoteDecimals: p.quoteDecimals,
          baseTokenProgram: p.baseTokenProgram,
          quoteTokenProgram: p.quoteTokenProgram,
          creator: p.creator,
          feeBeneficiaryRole: p.feeBeneficiaryRole,
          beneficiary: p.beneficiary,
          status: p.status,
          feeParams: p.feeParams,
          accounts: p.accounts,
          warnings: p.warnings ?? [],
          allocation: p.allocation ?? null,
          accountingPools: p.accountingPools ?? [p.poolAddress],
          refreshedAt: new Date(),
        },
        $setOnInsert: { discoveredAt: new Date() },
      },
      { upsert: true },
    );
  }

  private async migrationWarning(p: PoolInfo) {
    await this.terminal.warn(
      `Pool status is "${p.status}": trading is moving to the post-graduation pool. Destination activity is accounted only after the migration is verified on-chain.`,
      `migration:${p.poolAddress}:${p.status}`,
    );
  }

  /** One synchronisation pass over every watched address. Returns new swaps ingested. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    if (!this.provider || !this.pool || !this.rpc || !this.settings) return 0;
    let total = 0;
    this.backlog = false;
    for (const address of this.pool.watchAddresses) {
      const key = cursorId(this.pool.provider, this.pool.poolAddress, address);
      const existing = await readCursor(this.deps.db, key);
      const isBackfill = !existing;
      const fromSlot = this.pool.watchFromSlot?.[address];
      if (isBackfill && fromSlot !== undefined) {
        // A verified destination pool: index its whole history from the migration slot (it cannot
        // have activity before it was created), independent of INDEXER_BACKFILL.
        const stats = await syncAddress(this.ctx(), address, { cursorKey: key, source: "backfill", cap: this.deps.cfg.indexer.backfillMaxSignatures, concurrency: this.deps.cfg.indexer.fetchConcurrency, bounds: { afterSlot: fromSlot - 1 }, maxPerPass: 400, signal });
        this.backlog = this.backlog || stats.more;
        total += stats.newSwaps;
        this.metrics.swapsIngested += stats.newSwaps;
        if (!(await readCursor(this.deps.db, key))) {
          // No destination activity yet: anchor at the migration transaction itself.
          const migSig = this.pool.destination?.migrationSignature ?? null;
          await this.deps.db.WorkerState.updateOne({ _id: key }, { $set: { cursor: { lastSignature: migSig, lastSlot: fromSlot, backfillComplete: true } } }, { upsert: true });
        }
        continue;
      }
      if (isBackfill && this.deps.cfg.indexer.backfill === "none") {
        await this.startFromNow(address, key);
        continue;
      }
      const stats = await syncAddress(this.ctx(), address, {
        cursorKey: key,
        source: isBackfill ? "backfill" : "indexer",
        cap: isBackfill ? this.deps.cfg.indexer.backfillMaxSignatures : 50_000,
        concurrency: this.deps.cfg.indexer.fetchConcurrency,
        maxPerPass: 400,
        signal,
      });
      this.backlog = this.backlog || stats.more;
      if (isBackfill && stats.fetched) {
        this.log.info({ address, ...stats }, "backfill complete");
        await this.terminal.system(`Backfill complete: ${stats.ingested} historical transactions indexed.`, `backfill:${key}`);
      }
      total += stats.newSwaps;
      this.metrics.swapsIngested += stats.newSwaps;
      this.metrics.claimsIngested += stats.newClaims;
      this.metrics.lastSlot = Math.max(this.metrics.lastSlot, stats.lastSlot);
    }
    this.metrics.polls++;
    this.metrics.lastPollAt = Date.now();
    return total;
  }

  /**
   * INDEXER_BACKFILL=none: start from "now" with an exact reconciliation baseline. The fee state
   * is read first (slot S); the cursor is then placed on the newest signature at or below S, so
   * every transaction is either inside the baseline or indexed — never both, never neither.
   */
  private async startFromNow(address: string, key: string) {
    const pool = this.pool!;
    let baselineSlot: number | null = null;
    if (address === pool.poolAddress && this.provider!.id !== "mock") {
      const state = await this.provider!.getFeeSourceState();
      baselineSlot = state.slot;
      await this.deps.db.Pool.updateOne(
        { key: `${pool.provider}:${pool.poolAddress}`, baseline: { $exists: false } },
        { $set: { baseline: { slot: state.slot, quote: state.unclaimedQuote.toString(), base: state.unclaimedBase.toString(), at: new Date() } } },
      );
    }
    // "No backfill" still covers the CURRENT reward period: ingest back to the last snapshot slot
    // (or the start of the genesis round), so the next round's period is fully observed even when
    // the pool or provider changed mid-period. The reconciliation baseline above is independent
    // (it only counts swaps after its own slot), so nothing is double counted.
    const last: any = await this.deps.db.Round.findOne({ snapshotSlot: { $ne: null } }, { snapshotSlot: 1 }).sort({ snapshotSlot: -1 }).lean();
    const genesis: any = await this.deps.db.SystemState.findById("genesis").lean();
    const sched = this.deps.cfg.schedule;
    const params = { roundDurationMs: sched.roundDurationMs, windowStartMs: sched.windowStartMs, windowDurationMs: sched.windowDurationMs, anchorEpochMs: sched.anchorEpochMs };
    const startIndex = genesis?.value?.roundIndex ?? roundIndexAt(Date.now(), params);
    const bounds = last ? { afterSlot: last.snapshotSlot as number } : { sinceTime: Math.floor(boundsOf(startIndex, params).startsAt / 1000) };
    const stats = await syncAddress(this.ctx(), address, { cursorKey: key, untilSignature: null, source: "backfill", cap: this.deps.cfg.indexer.backfillMaxSignatures, concurrency: this.deps.cfg.indexer.fetchConcurrency, bounds });
    if (!(await readCursor(this.deps.db, key))) {
      // Nothing in the period yet: anchor at the newest signature at/below the baseline slot.
      const page = await this.rpc!.getSignaturesForAddress(address, { limit: 1000 });
      const anchor = baselineSlot === null ? page[0] : page.find((x) => x.slot <= baselineSlot!);
      await this.deps.db.WorkerState.updateOne({ _id: key }, { $set: { cursor: { lastSignature: anchor?.signature ?? null, lastSlot: anchor?.slot ?? 0, backfillComplete: true } } }, { upsert: true });
    }
    this.log.info({ address, baselineSlot, periodBounds: bounds, ingested: stats.ingested }, "attached without history backfill (current reward period ingested)");
  }

  /** Drain websocket notifications (fast path). Failures are left to the poll backstop. */
  async drainWsQueue() {
    if (!this.provider || !this.wsQueue.size) return;
    const batch = [...this.wsQueue];
    this.wsQueue.clear();
    for (const sig of batch) {
      if (this.recent.has(sig)) continue;
      try {
        const r = await ingestSignature(this.ctx(), sig, "indexer");
        if (r) {
          this.recent.set(sig, Date.now());
          this.metrics.swapsIngested += r.newSwaps;
        }
      } catch (err) {
        this.log.debug({ sig, err: String(err) }, "ws fast-path ingest failed; poll will retry");
      }
    }
    if (this.recent.size > 5000) for (const [k, t] of this.recent) if (Date.now() - t > 600_000) this.recent.delete(k);
  }

  /**
   * Promote confirmed → finalized; mark transactions that provably disappeared (forked out) as dropped.
   *
   * A null status alone proves nothing: a lagging or freshly restarted RPC backend may not have
   * processed the landing slot. A swap is dropped only when (a) the finalized slot (from one node,
   * `getEpochInfo`) is past the swap's slot by a safety margin, (b) the status answers came from
   * nodes whose context slot is at/after that finalized slot (`searchTransactionHistory` = true, so a
   * finalized transaction would be found), and (c) this was observed on TWO separate passes at
   * least `dropAfterSeconds` apart. Active rows are processed oldest first; dropped rows live in a
   * separate, bounded re-check window so they can never block promotion of newer swaps.
   */
  async finalityPass(now = Date.now()) {
    if (!this.rpc) return;
    const rpc = this.rpc;
    const candidates: any[] = await this.deps.db.Swap.find({ commitment: "confirmed", status: "active", ingestedAt: { $lt: new Date(now - 5_000) } }, { signature: 1, slot: 1, status: 1, ingestedAt: 1, dropCandidateAt: 1 }).sort({ slot: 1 }).limit(256).lean();
    const dropped: any[] = await this.deps.db.Swap.find({ commitment: "confirmed", status: "dropped" }, { signature: 1, slot: 1, status: 1, ingestedAt: 1, dropCandidateAt: 1 }).sort({ slot: -1 }).limit(64).lean();
    const all = [...candidates, ...dropped];
    const sigs = [...new Set(all.map((c) => c.signature as string))];
    if (!sigs.length) return;
    const fin = await rpc.getEpochInfo("finalized");
    for (let i = 0; i < sigs.length; i += 128) {
      const chunk = sigs.slice(i, i + 128);
      const res = await rpc.getSignatureStatusesWithContext(chunk, true);
      const authoritative = res.contextSlot >= fin.absoluteSlot;
      for (let j = 0; j < chunk.length; j++) {
        const st = res.value[j];
        const sig = chunk[j]!;
        const row = all.find((c) => c.signature === sig)!;
        if (st && st.confirmationStatus === "finalized" && !st.err) {
          await this.deps.db.Swap.updateMany({ signature: sig }, { $set: { commitment: "finalized", status: "active", dropCandidateAt: null } });
          this.metrics.finalized++;
          continue;
        }
        if (st) {
          // Known to the cluster (confirmed, not yet finalized): active, not a drop candidate.
          if (row.status === "dropped" || row.dropCandidateAt) await this.deps.db.Swap.updateMany({ signature: sig }, { $set: { status: "active", dropCandidateAt: null } });
          continue;
        }
        if (row.status === "dropped") continue; // still unknown; stays excluded and re-checked later
        const pastFinality = fin.absoluteSlot > (row.slot as number) + 150; // > 32 confirmations + margin
        const oldEnough = now - new Date(row.ingestedAt).getTime() > this.deps.cfg.indexer.dropAfterSeconds * 1000;
        if (!authoritative || !pastFinality || !oldEnough) continue; // not proven — re-check later
        if (!row.dropCandidateAt) {
          await this.deps.db.Swap.updateMany({ signature: sig, status: "active" }, { $set: { dropCandidateAt: new Date(now) } });
          continue;
        }
        if (now - new Date(row.dropCandidateAt).getTime() < this.deps.cfg.indexer.dropAfterSeconds * 1000) continue;
        await this.deps.db.Swap.updateMany({ signature: sig, status: "active" }, { $set: { status: "dropped" } });
        this.metrics.dropped++;
        await this.terminal.warn(`Transaction ${sig.slice(0, 8)}… is no longer visible on-chain (fork); excluded from rewards.`, `dropped:${sig}`);
      }
    }
  }

  /** Public FEES line every 30s bucket when new eligible fees arrived (real data only). */
  async feeSummary(now = Date.now()) {
    if (!this.pool || !this.settings) return;
    const bucketMs = 30_000;
    const bucketEnd = Math.floor(now / bucketMs) * bucketMs;
    const bucketStart = bucketEnd - bucketMs;
    const mint = this.settings.payoutAssetMint;
    const sum = async (match: Record<string, unknown>) => {
      const r = await this.deps.db.Swap.aggregate([{ $match: { pool: this.pool!.poolAddress, status: "active", eligibleFeeMint: mint, ...match } }, { $group: { _id: null, t: { $sum: "$eligibleFee" } } }]);
      return big(r[0]?.t ?? 0);
    };
    // Only fees of the CURRENT period count, so the line always agrees with the live pool.
    const last: any = await this.deps.db.Round.findOne({ snapshotSlot: { $ne: null } }, { snapshotSlot: 1 }).sort({ snapshotSlot: -1 }).lean();
    const period = last?.snapshotSlot ? { slot: { $gt: last.snapshotSlot } } : {};
    const delta = await sum({ ...period, ingestedAt: { $gte: new Date(bucketStart), $lt: new Date(bucketEnd) } });
    if (delta <= 0n) return;
    const periodTotal = await sum(period);
    await this.terminal.feesAccrued({ delta, periodTotal, bucket: `${this.pool.poolAddress}:${bucketEnd}` });
  }

  async refreshPool() {
    if (!this.provider) return;
    const prev = this.pool?.status;
    this.pool = await this.provider.load();
    await this.savePool(this.pool);
    if (prev && prev !== this.pool.status) await this.migrationWarning(this.pool);
    await this.recordMigration(this.pool);
  }

  private migrationRecorded = new Set<string>();
  /**
   * On graduation, find the migration transaction, verify it strictly, persist the outcome on the
   * pool document and — only if verified and supported — attach the destination adapter so its
   * swaps (buyers) and the creator's destination entitlement are indexed from the migration slot.
   */
  private async recordMigration(p: PoolInfo) {
    if (p.status !== "migrated" || p.provider === "mock" || !this.rpc || !this.provider || this.migrationRecorded.has(p.poolAddress)) return;
    try {
      const before = this.provider.info().destination?.pool ?? null;
      const r = await resolveAndAttachMigration(this.deps.db, this.rpc, this.provider);
      if (r.status === "not_found") {
        this.log.warn({ pool: p.poolAddress }, "pool is migrated but its migration transaction was not found in recent history");
        return;
      }
      this.migrationRecorded.add(p.poolAddress);
      const m = r.verified!;
      const dest = `${m.destinationPool.slice(0, 4)}…${m.destinationPool.slice(-4)}`;
      if (r.status === "verified") {
        await this.terminal.warn(`Pool graduated (${m.kind.replace("_", " → ")}) to ${dest} — destination verified on-chain; post-migration activity is now tracked.`, `migration-dest:${p.poolAddress}`);
      } else {
        await this.terminal.warn(`Pool graduated (${m.kind.replace("_", " → ")}) to ${dest} — destination ${r.status === "unsupported" ? "type is not supported" : "NOT verified"} (${m.failed.join(", ") || m.notes.join("; ")}). Post-migration fees are not accounted.`, `migration-dest:${p.poolAddress}`);
      }
      this.pool = this.provider.info();
      await this.savePool(this.pool);
      if ((this.pool.destination?.pool ?? null) !== before) this.restartWebsocket();
    } catch (err) {
      this.log.warn({ pool: p.poolAddress, err: String(err) }, "migration resolution failed; will retry on next refresh");
    }
  }

  private restartWebsocket() {
    if (!this.ws || !this.settings || !this.pool) return;
    this.ws.stop();
    this.ws = null;
    const wsUrl = this.settings.wsUrl;
    if (!wsUrl || this.deps.wsFactory === null) return;
    const onLog = (sig: string) => {
      this.metrics.wsNotifications++;
      this.wsQueue.add(sig);
    };
    this.ws = this.deps.wsFactory ? this.deps.wsFactory(wsUrl, this.pool.watchAddresses, onLog) : new LogsSubscriber(wsUrl, this.pool.watchAddresses, (n) => !n.err && onLog(n.signature), this.log);
    this.ws.start();
  }

  /**
   * Heartbeat + lease renewal run on their own timer so that long synchronisation passes can
   * never make a healthy leader look dead or let its lease lapse.
   */
  private startHeartbeat() {
    const beat = async () => {
      try {
        if (this.leader && !(await this.lease.tryAcquire())) {
          this.leader = false;
          this.log.warn("lost indexer leadership");
        }
        if (this.leader) {
          await heartbeat(this.deps.db, "indexer", {
            status: this.status.status,
            detail: this.status.detail ?? (this.backlog ? "catching up on backlog" : null),
            instance: this.deps.cfg.instanceId,
            metrics: { ...this.metrics, wsConnected: this.ws?.connected ?? false, pool: this.pool?.poolAddress ?? null, poolStatus: this.pool?.status ?? null, backlog: this.backlog },
          });
        } else {
          await heartbeat(this.deps.db, "indexer:standby:" + this.deps.cfg.instanceId, { status: "standby", instance: this.deps.cfg.instanceId });
        }
      } catch {
        /* database hiccup: next beat retries */
      }
    };
    void beat();
    return setInterval(beat, 5000);
  }

  async run(signal: AbortSignal) {
    const timers = { poll: 0, finality: 0, fees: 0, refresh: 0 };
    let failures = 0;
    const hb = this.startHeartbeat();
    while (!signal.aborted && !this.stopped) {
      const now = Date.now();
      try {
        if (!this.leader) this.leader = await this.lease.tryAcquire(now);
        if (!this.leader) {
          this.ws?.stop();
          this.ws = null;
          this.provider = null;
          await sleep(2000, signal);
          continue;
        }
        const s = await this.deps.settings.get();
        if (s.pauseIndexer) {
          this.status = { status: "paused", detail: "paused by admin" };
          await sleep(2000, signal);
          continue;
        }
        if (s.version !== this.settingsVersion || !this.provider) {
          await this.configure(s);
          this.settingsVersion = s.version;
        }
        await this.drainWsQueue();
        if (this.backlog || now - timers.poll >= s.indexerPollIntervalMs) {
          await this.pollOnce(signal);
          timers.poll = now;
        }
        if (now - timers.finality >= this.deps.cfg.indexer.finalityCheckMs) {
          await this.finalityPass(now);
          timers.finality = now;
        }
        if (now - timers.fees >= 30_000) {
          await this.feeSummary(now);
          timers.fees = now;
        }
        if (now - timers.refresh >= 60_000) {
          if (timers.refresh) await this.refreshPool();
          timers.refresh = now;
        }
        this.status = { status: "running", detail: null };
        failures = 0;
        if (!this.backlog) await sleep(Math.min(250, s.indexerPollIntervalMs), signal);
      } catch (err: any) {
        failures++;
        this.metrics.errors++;
        const delay = backoffDelay(failures, { baseMs: 500, maxMs: 30_000 });
        this.log.error({ err: String(err?.message ?? err), delay }, "indexer loop error");
        this.status = { status: "degraded", detail: String(err?.message ?? err).slice(0, 300) };
        if (failures === 3) await this.terminal.warn("Indexer is retrying after repeated RPC/database errors.", `indexer-retry:${Math.floor(now / 600_000)}`).catch(() => undefined);
        await sleep(delay, signal);
      }
    }
    clearInterval(hb);
    this.ws?.stop();
    if (this.leader) await heartbeat(this.deps.db, "indexer", { status: "stopped" }).catch(() => undefined);
    await this.lease.release().catch(() => undefined);
  }

  stop() {
    this.stopped = true;
  }
}
