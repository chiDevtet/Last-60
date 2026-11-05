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
import { createProvider, type LaunchProvider, type PoolInfo } from "../providers";
import { TerminalWriter } from "../terminal/terminal";
import { heartbeat, Lease } from "../util/lease";
import { rootLogger, type Logger } from "../util/logger";
import { sleep } from "../util/time";
import { backoffDelay } from "../util/backoff";
import { cursorId, ingestSignature, readCursor, syncAddress } from "./signatureSync";

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
    this.provider = createProvider({ id: s.launchProvider, poolAddress: s.poolAddress, tokenMint: s.tokenMint, role: s.feeBeneficiaryRole, payoutMint: s.payoutAssetMint }, this.rpc);
    this.pool = await this.provider.load();
    await this.savePool(this.pool);
    this.log.info({ provider: this.pool.provider, pool: this.pool.poolAddress, mint: this.pool.tokenMint, beneficiary: this.pool.beneficiary, status: this.pool.status, feeParams: this.pool.feeParams }, "provider loaded");
    await this.terminal.system(`Indexer attached to ${this.pool.provider} pool ${this.pool.poolAddress.slice(0, 4)}…${this.pool.poolAddress.slice(-4)}.`, `attach:${this.pool.provider}:${this.pool.poolAddress}:${s.version}`);
    if (this.pool.status !== "bonding") await this.migrationWarning(this.pool);
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
          refreshedAt: new Date(),
        },
        $setOnInsert: { discoveredAt: new Date() },
      },
      { upsert: true },
    );
  }

  private async migrationWarning(p: PoolInfo) {
    await this.terminal.warn(
      `Pool status is "${p.status}": trading is moving to the post-graduation AMM. Fees from the migrated pool are not attributed until a post-migration adapter is configured.`,
      `migration:${p.poolAddress}:${p.status}`,
    );
  }

  /** One full synchronisation pass over every watched address. Returns new swaps ingested. */
  async pollOnce(): Promise<number> {
    if (!this.provider || !this.pool || !this.rpc || !this.settings) return 0;
    let total = 0;
    for (const address of this.pool.watchAddresses) {
      const key = cursorId(this.pool.provider, this.pool.poolAddress, address);
      const existing = await readCursor(this.deps.db, key);
      const isBackfill = !existing;
      if (isBackfill && this.deps.cfg.indexer.backfill === "none") {
        // Start from "now": record the newest signature without ingesting history.
        const latest = await this.rpc.getSignaturesForAddress(address, { limit: 1 });
        await this.deps.db.WorkerState.updateOne({ _id: key }, { $set: { cursor: { lastSignature: latest[0]?.signature ?? null, lastSlot: latest[0]?.slot ?? 0, backfillComplete: true } } }, { upsert: true });
        continue;
      }
      const stats = await syncAddress(this.ctx(), address, {
        cursorKey: key,
        source: isBackfill ? "backfill" : "indexer",
        cap: isBackfill ? this.deps.cfg.indexer.backfillMaxSignatures : 50_000,
        concurrency: this.deps.cfg.indexer.fetchConcurrency,
      });
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

  /** Promote confirmed → finalized; mark transactions that disappeared (forked out) as dropped. */
  async finalityPass(now = Date.now()) {
    if (!this.rpc) return;
    const candidates: any[] = await this.deps.db.Swap.find({ commitment: "confirmed", ingestedAt: { $lt: new Date(now - 5_000) } }, { signature: 1, status: 1, ingestedAt: 1 }).sort({ slot: 1 }).limit(256).lean();
    const sigs = [...new Set(candidates.map((c) => c.signature as string))];
    for (let i = 0; i < sigs.length; i += 128) {
      const chunk = sigs.slice(i, i + 128);
      const statuses = await this.rpc.getSignatureStatuses(chunk, true);
      for (let j = 0; j < chunk.length; j++) {
        const st = statuses[j];
        const sig = chunk[j]!;
        if (st?.confirmationStatus === "finalized" && !st.err) {
          await this.deps.db.Swap.updateMany({ signature: sig }, { $set: { commitment: "finalized", status: "active" } });
          this.metrics.finalized++;
        } else if (!st) {
          const first = candidates.find((c) => c.signature === sig);
          if (first && now - new Date(first.ingestedAt).getTime() > this.deps.cfg.indexer.dropAfterSeconds * 1000 && first.status !== "dropped") {
            await this.deps.db.Swap.updateMany({ signature: sig }, { $set: { status: "dropped" } });
            this.metrics.dropped++;
            await this.terminal.warn(`Transaction ${sig.slice(0, 8)}… is no longer visible on-chain (fork); excluded from rewards.`, `dropped:${sig}`);
          }
        } else if (st && st.confirmationStatus !== "finalized") {
          // Still confirmed-but-not-finalized; make sure it is active.
          if (candidates.some((c) => c.signature === sig && c.status === "dropped")) await this.deps.db.Swap.updateMany({ signature: sig }, { $set: { status: "active" } });
        }
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
    const delta = await sum({ ingestedAt: { $gte: new Date(bucketStart), $lt: new Date(bucketEnd) } });
    if (delta <= 0n) return;
    const last: any = await this.deps.db.Round.findOne({ snapshotSlot: { $ne: null } }, { snapshotSlot: 1 }).sort({ snapshotSlot: -1 }).lean();
    const periodTotal = await sum(last?.snapshotSlot ? { slot: { $gt: last.snapshotSlot } } : {});
    await this.terminal.feesAccrued({ delta, periodTotal, bucket: `${this.pool.poolAddress}:${bucketEnd}` });
  }

  async refreshPool() {
    if (!this.provider) return;
    const prev = this.pool?.status;
    this.pool = await this.provider.load();
    await this.savePool(this.pool);
    if (prev && prev !== this.pool.status) await this.migrationWarning(this.pool);
  }

  async run(signal: AbortSignal) {
    const timers = { poll: 0, finality: 0, fees: 0, refresh: 0, heartbeat: 0 };
    let failures = 0;
    while (!signal.aborted && !this.stopped) {
      const now = Date.now();
      try {
        if (!(await this.lease.tryAcquire(now))) {
          if (now - timers.heartbeat > 5000) {
            await heartbeat(this.deps.db, "indexer:standby:" + this.deps.cfg.instanceId, { status: "standby", instance: this.deps.cfg.instanceId });
            timers.heartbeat = now;
          }
          this.ws?.stop();
          this.ws = null;
          this.provider = null;
          await sleep(2000, signal);
          continue;
        }
        const s = await this.deps.settings.get();
        if (s.pauseIndexer) {
          await heartbeat(this.deps.db, "indexer", { status: "paused", instance: this.deps.cfg.instanceId, detail: "paused by admin" });
          await sleep(2000, signal);
          continue;
        }
        if (s.version !== this.settingsVersion || !this.provider) {
          await this.configure(s);
          this.settingsVersion = s.version;
        }
        await this.drainWsQueue();
        if (now - timers.poll >= s.indexerPollIntervalMs) {
          await this.pollOnce();
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
        if (now - timers.heartbeat >= 5000) {
          await heartbeat(this.deps.db, "indexer", { status: "running", instance: this.deps.cfg.instanceId, detail: null, metrics: { ...this.metrics, wsConnected: this.ws?.connected ?? false, pool: this.pool?.poolAddress ?? null, poolStatus: this.pool?.status ?? null } });
          timers.heartbeat = now;
        }
        failures = 0;
        await sleep(Math.min(250, s.indexerPollIntervalMs), signal);
      } catch (err: any) {
        failures++;
        this.metrics.errors++;
        const delay = backoffDelay(failures, { baseMs: 500, maxMs: 30_000 });
        this.log.error({ err: String(err?.message ?? err), delay }, "indexer loop error");
        await heartbeat(this.deps.db, "indexer", { status: "degraded", detail: String(err?.message ?? err).slice(0, 300), instance: this.deps.cfg.instanceId }).catch(() => undefined);
        if (failures === 3) await this.terminal.warn("Indexer is retrying after repeated RPC/database errors.", `indexer-retry:${Math.floor(now / 600_000)}`).catch(() => undefined);
        await sleep(delay, signal);
      }
    }
    this.ws?.stop();
    await this.lease.release().catch(() => undefined);
    await heartbeat(this.deps.db, "indexer", { status: "stopped" }).catch(() => undefined);
  }

  stop() {
    this.stopped = true;
  }
}
