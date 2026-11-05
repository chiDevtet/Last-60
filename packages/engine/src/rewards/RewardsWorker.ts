/**
 * The rewards process: scheduler + payout executor + fee collector + reconciler, under a single
 * leader lease. It never depends on the API or the frontend being up.
 */
import type { Keypair } from "@solana/web3.js";
import type { AppConfig } from "../config/env";
import type { EffectiveSettings, SettingsStore } from "../config/runtime";
import { RpcClient, type ChainRpc } from "../chain/rpc";
import type { Models } from "../db/models";
import { createProvider, type LaunchProvider } from "../providers";
import { TerminalWriter } from "../terminal/terminal";
import { heartbeat, Lease } from "../util/lease";
import { rootLogger, type Logger } from "../util/logger";
import { systemClock, type Clock } from "../util/time";
import { backoffDelay } from "../util/backoff";
import { RoundScheduler } from "./scheduler";
import { PayoutExecutor } from "./payouts";
import { FeeCollector } from "./feeCollector";
import { Reconciler } from "./reconciliation";
import { readMint } from "../providers/mint";

export interface RewardsWorkerDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  payer: Keypair | null;
  claimer: Keypair | null;
  rpc?: ChainRpc;
  provider?: LaunchProvider;
  clock?: Clock;
  log?: Logger;
  random?: (min: number, max: number) => number;
}

export class RewardsWorker {
  readonly log: Logger;
  readonly clock: Clock;
  readonly terminal: TerminalWriter;
  readonly lease: Lease;
  rpc: ChainRpc;
  private provider: LaunchProvider | null;
  private providerKey = "";
  readonly scheduler: RoundScheduler;
  readonly payouts: PayoutExecutor;
  readonly fees: FeeCollector;
  readonly reconciler: Reconciler;
  private plannedSinceClaim = false;
  private stopped = false;
  /**
   * Fee claims (which wait for confirmation) and reconciliation (which can ingest thousands of
   * transactions and scan hundreds of rounds) run in the background, one of each at a time. Awaited
   * inline they blocked the scheduler loop: a round whose private execution instant fell inside a
   * slow claim/reconciliation was executed late or, past the grace period, recorded as missed.
   */
  private background: { claim: Promise<unknown> | null; recon: Promise<unknown> | null } = { claim: null, recon: null };

  constructor(private readonly d: RewardsWorkerDeps) {
    this.log = (d.log ?? rootLogger()).child({ component: "rewards" });
    this.clock = d.clock ?? systemClock;
    this.terminal = new TerminalWriter(d.db, d.cfg.terminal.retentionDays);
    this.lease = new Lease(d.db, "rewards", d.cfg.instanceId);
    this.rpc = d.rpc ?? new RpcClient({ urls: d.cfg.solana.rpcUrls, timeoutMs: d.cfg.solana.timeoutMs, maxRps: d.cfg.solana.maxRps, maxTxVersion: d.cfg.solana.maxTxVersion, logger: this.log });
    this.provider = d.provider ?? null;
    const providerFn = () => {
      if (!this.provider) throw new Error("provider not loaded");
      return this.provider;
    };
    const payoutWallet = d.payer?.publicKey ?? null;
    this.scheduler = new RoundScheduler({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, provider: providerFn, payer: d.payer, terminal: this.terminal, clock: this.clock, random: d.random, log: this.log, onRoundPlanned: () => (this.plannedSinceClaim = true) });
    this.payouts = new PayoutExecutor({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, payer: d.payer, terminal: this.terminal, clock: this.clock, log: this.log, tokenInfo: (mint) => readMint(this.rpc, mint) });
    this.fees = new FeeCollector({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, provider: providerFn, claimer: d.claimer, payoutWallet, terminal: this.terminal, clock: this.clock, log: this.log });
    this.reconciler = new Reconciler({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, provider: providerFn, payoutWallet: payoutWallet?.toBase58() ?? null, terminal: this.terminal, log: this.log });
  }

  async ensureProvider(s: EffectiveSettings) {
    const key = JSON.stringify([s.launchProvider, s.poolAddress, s.tokenMint, s.feeBeneficiaryRole, s.payoutAssetMint, s.rpcUrls]);
    if (this.provider && (key === this.providerKey || this.d.provider)) return this.provider;
    if (this.rpc instanceof RpcClient) this.rpc.setUrls(s.rpcUrls);
    const p = createProvider({ id: s.launchProvider, poolAddress: s.poolAddress, tokenMint: s.tokenMint, role: s.feeBeneficiaryRole, payoutMint: s.payoutAssetMint }, this.rpc);
    await p.load();
    this.provider = p;
    this.providerKey = key;
    this.log.info({ provider: p.id, pool: p.info().poolAddress, beneficiary: p.info().beneficiary }, "rewards provider loaded");
    return p;
  }

  private leader = false;
  private status: { status: string; detail: string | null } = { status: "running", detail: null };

  /** Heartbeat + lease renewal on an independent timer (a long snapshot never looks like a crash). */
  private startHeartbeat() {
    const beat = async () => {
      try {
        if (this.leader && !(await this.lease.tryAcquire())) {
          this.leader = false;
          this.log.warn("lost rewards leadership");
        }
        if (this.leader) {
          const s = await this.d.settings.get();
          const halted = await this.payouts.isHalted();
          const paused = s.pauseScheduler || s.pausePayouts;
          await heartbeat(this.d.db, "rewards", {
            status: this.status.status === "degraded" ? "degraded" : paused ? "paused" : halted ? "degraded" : "running",
            detail: this.status.detail ?? (halted ? `payouts halted: ${halted}` : s.pausePayouts ? "payouts paused by admin" : s.pauseScheduler ? "scheduler paused by admin" : null),
            instance: this.d.cfg.instanceId,
            metrics: { payoutMode: s.payoutMode, payer: this.d.payer?.publicKey.toBase58() ?? null },
          });
        } else {
          await heartbeat(this.d.db, `rewards:standby:${this.d.cfg.instanceId}`, { status: "standby", instance: this.d.cfg.instanceId });
        }
      } catch {
        /* next beat retries */
      }
    };
    return setInterval(beat, 5000);
  }

  async run(signal: AbortSignal) {
    let failures = 0;
    const t = { payouts: 0, recon: 0, claim: 0 };
    const hb = this.startHeartbeat();
    while (!signal.aborted && !this.stopped) {
      const now = this.clock.now();
      try {
        if (!this.leader) {
          this.leader = await this.lease.tryAcquire(now);
          if (this.leader) {
            this.log.info("acquired rewards leadership");
            await this.terminal.system("Reward engine online.", `online:${this.d.cfg.instanceId}:${Math.floor(now / 60_000)}`);
          }
        }
        if (!this.leader) {
          await this.clock.sleep(2000, signal);
          continue;
        }
        const s = await this.d.settings.get();
        await this.ensureProvider(s);
        const wake = await this.scheduler.tick(now);
        if (now - t.payouts >= 1000) {
          await this.payouts.processDue();
          t.payouts = now;
        }
        if (!this.background.claim && (this.plannedSinceClaim || now - t.claim > 300_000)) {
          this.plannedSinceClaim = false;
          t.claim = now;
          this.background.claim = Promise.resolve()
            .then(() => this.fees.maybeClaim())
            .catch((err) => this.log.warn({ err: String(err) }, "fee claim failed"))
            .finally(() => (this.background.claim = null));
        }
        if (!this.background.recon && now - t.recon >= this.d.cfg.reconciliation.intervalMs) {
          t.recon = now;
          this.background.recon = Promise.resolve()
            .then(() => this.reconciler.run())
            .catch((err) => this.log.warn({ err: String(err) }, "reconciliation failed"))
            .finally(() => (this.background.recon = null));
        }
        this.status = { status: "running", detail: null };
        failures = 0;
        const sleepFor = Math.max(0, Math.min(wake - this.clock.now(), 500));
        await this.clock.sleep(sleepFor, signal);
      } catch (err: any) {
        failures++;
        const delay = backoffDelay(failures, { baseMs: 500, maxMs: 15_000 });
        this.log.error({ err: String(err?.message ?? err), delay }, "rewards loop error");
        this.status = { status: "degraded", detail: String(err?.message ?? err).slice(0, 300) };
        await this.clock.sleep(delay, signal);
      }
    }
    // Let in-flight background work settle (bounded) before giving up the lease.
    const pending = [this.background.claim, this.background.recon].filter((x): x is Promise<unknown> => !!x);
    if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 10_000))]);
    clearInterval(hb);
    if (this.leader) await heartbeat(this.d.db, "rewards", { status: "stopped" }).catch(() => undefined);
    await this.lease.release().catch(() => undefined);
  }

  stop() {
    this.stopped = true;
  }
}
