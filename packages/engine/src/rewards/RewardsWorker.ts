/**
 * The rewards process: scheduler + payout executor + fee collector + creator wallet automation +
 * reconciler, under a single leader lease. It never depends on the API or the frontend being up.
 */
import type { Keypair } from "@solana/web3.js";
import { PayoutSigner, type PayoutSignerStatus } from "../signer/payoutSigner";
import type { AppConfig } from "../config/env";
import type { EffectiveSettings, SettingsStore } from "../config/runtime";
import { RpcClient, type ChainRpc } from "../chain/rpc";
import type { Models } from "../db/models";
import { AwaitingLaunchError, attachStoredMigration, createProvider, providerTargetFor, type LaunchProvider } from "../providers";
import { basesOf, roleChangeBlockReason } from "../accounting/attribution";
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
import { CreatorWalletAutomation } from "../creator/creatorWallet";
import { fulfilExportRequests, fulfilWalletRequests } from "../wallets/vault";

export interface RewardsWorkerDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  /** The dedicated payout signer (a raw Keypair is accepted for tests and wrapped). */
  payer: PayoutSigner | Keypair | null;
  /** Sanitized signer status published for operators (wallet verification). */
  signerStatus?: PayoutSignerStatus | null;
  claimer: Keypair | null;
  /** The launch creator's keypair for the creator wallet automation (docs/CREATOR_WALLET.md); null: idle. */
  creator?: Keypair | null;
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
  readonly creatorWallet: CreatorWalletAutomation;
  readonly signer: PayoutSigner | null;
  private plannedSinceClaim = false;
  private claimedSinceCreatorPass = false;
  private stopped = false;
  /**
   * Fee claims (which wait for confirmation) and reconciliation (which can ingest thousands of
   * transactions and scan hundreds of rounds) run in the background, one of each at a time. Awaited
   * inline they blocked the scheduler loop: a round whose private execution instant fell inside a
   * slow claim/reconciliation was executed late or, past the grace period, recorded as missed.
   */
  private background: { claim: Promise<unknown> | null; recon: Promise<unknown> | null; creator: Promise<unknown> | null } = { claim: null, recon: null, creator: null };

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
    const signer = d.payer instanceof PayoutSigner ? d.payer : d.payer ? PayoutSigner.fromKeypair(d.payer) : null;
    this.signer = signer;
    const payoutWallet = signer?.publicKey ?? null;
    this.scheduler = new RoundScheduler({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, provider: providerFn, payer: signer, terminal: this.terminal, clock: this.clock, random: d.random, log: this.log, onRoundPlanned: () => (this.plannedSinceClaim = true) });
    this.payouts = new PayoutExecutor({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, signer, terminal: this.terminal, clock: this.clock, log: this.log, tokenInfo: (mint) => readMint(this.rpc, mint) });
    this.fees = new FeeCollector({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, provider: providerFn, claimer: d.claimer, payoutWallet, terminal: this.terminal, clock: this.clock, log: this.log });
    this.creatorWallet = new CreatorWalletAutomation({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, provider: providerFn, creator: d.creator ?? null, terminal: this.terminal, clock: this.clock, log: this.log });
    this.reconciler = new Reconciler({ db: d.db, cfg: d.cfg, settings: d.settings, rpc: this.rpc, provider: providerFn, payoutWallet: payoutWallet?.toBase58() ?? null, terminal: this.terminal, log: this.log });
  }

  private lastAttachCheck = 0;
  async ensureProvider(s: EffectiveSettings) {
    const key = JSON.stringify([s.launchProvider, s.poolAddress, s.tokenMint, s.feeBeneficiaryRole, s.payoutAssetMint, s.rpcUrls]);
    if (this.provider && (key === this.providerKey || this.d.provider)) {
      // Pick up a destination the indexer verified since (cheap DB read, throttled).
      if (this.clock.now() - this.lastAttachCheck > 10_000) {
        this.lastAttachCheck = this.clock.now();
        if (await attachStoredMigration(this.d.db, this.provider)) this.log.info({ destination: this.provider.info().destination }, "verified graduation destination attached");
      }
      return this.provider;
    }
    if (this.rpc instanceof RpcClient) this.rpc.setUrls(s.rpcUrls);
    const p = createProvider(providerTargetFor(s, this.d.cfg), this.rpc);
    await p.load();
    await attachStoredMigration(this.d.db, p);
    const info = p.info();
    const blocked = await roleChangeBlockReason(this.d.db, info.poolAddress, info.feeBeneficiaryRole, { provider: info.provider, beneficiary: info.beneficiary, currentBasisIds: new Set(basesOf(info).keys()) });
    if (blocked) throw new Error(blocked);
    this.lastAttachCheck = this.clock.now();
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
            status: this.status.status === "degraded" ? "degraded" : this.status.status === "waiting" ? "waiting" : paused ? "paused" : halted ? "degraded" : "running",
            detail: this.status.detail ?? (halted ? `payouts halted: ${halted}` : s.pausePayouts ? "payouts paused by admin" : s.pauseScheduler ? "scheduler paused by admin" : null),
            instance: this.d.cfg.instanceId,
            metrics: { payoutMode: s.payoutMode, payer: this.signer?.address ?? null },
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
    const t = { payouts: 0, recon: 0, claim: 0, creator: 0 };
    const hb = this.startHeartbeat();
    while (!signal.aborted && !this.stopped) {
      const now = this.clock.now();
      try {
        if (!this.leader) {
          this.leader = await this.lease.tryAcquire(now);
          if (this.leader) {
            this.log.info("acquired rewards leadership");
            await this.publishSignerStatus().catch(() => undefined);
            await this.terminal.system("Reward engine online.", `online:${this.d.cfg.instanceId}:${Math.floor(now / 60_000)}`);
          }
        }
        if (!this.leader) {
          await this.clock.sleep(2000, signal);
          continue;
        }
        // Wallet generation / export requests from the admin console: served before the provider is
        // loaded, so they work before launch (no token / pool yet).
        await this.walletPass(now);
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
            .then((sig) => {
              if (sig) this.claimedSinceCreatorPass = true; // settle the new claim's Last-60 share promptly
            })
            .catch((err) => this.log.warn({ err: String(err) }, "fee claim failed"))
            .finally(() => (this.background.claim = null));
        }
        if (this.d.cfg.creatorWallet?.automationEnabled && !this.background.creator && (this.claimedSinceCreatorPass || now - t.creator >= this.d.cfg.creatorWallet.intervalMs)) {
          this.claimedSinceCreatorPass = false;
          t.creator = now;
          this.background.creator = Promise.resolve()
            .then(() => this.creatorWallet.run())
            .catch((err) => this.log.warn({ err: String(err?.message ?? err) }, "creator wallet pass failed"))
            .finally(() => (this.background.creator = null));
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
        if (err instanceof AwaitingLaunchError) {
          // Before launch: nothing to schedule yet; wallet requests (above) are still served.
          this.status = { status: "waiting", detail: `waiting for launch: ${err.message}` };
          await this.terminal.system(`Reward engine waiting for launch: ${err.message}.`, `awaiting-launch:rewards:${err.message}`).catch(() => undefined);
          await this.clock.sleep(2_000, signal);
          continue;
        }
        failures++;
        const delay = backoffDelay(failures, { baseMs: 500, maxMs: 15_000 });
        this.log.error({ err: String(err?.message ?? err), delay }, "rewards loop error");
        this.status = { status: "degraded", detail: String(err?.message ?? err).slice(0, 300) };
        await this.clock.sleep(delay, signal);
      }
    }
    // Let in-flight background work settle (bounded) before giving up the lease.
    const pending = [this.background.claim, this.background.recon, this.background.creator].filter((x): x is Promise<unknown> => !!x);
    if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 10_000))]);
    clearInterval(hb);
    if (this.leader) await heartbeat(this.d.db, "rewards", { status: "stopped" }).catch(() => undefined);
    await this.lease.release().catch(() => undefined);
  }

  stop() {
    this.stopped = true;
  }

  private lastWalletPass = 0;
  /** Generate requested wallets and fulfil signed key exports (docs/WALLETS.md). Never throws. */
  async walletPass(now = this.clock.now()) {
    if (now - this.lastWalletPass < 2_000) return;
    this.lastWalletPass = now;
    try {
      const made = await fulfilWalletRequests(this.d.db, this.d.cfg, this.log);
      for (const role of made) await this.terminal.system(`New ${role} wallet generated and stored encrypted. Processes restart to load it; export a backup from the admin console.`, `wallet-generated:${role}`);
      await fulfilExportRequests(this.d.db, this.d.cfg, { now, log: this.log });
    } catch (err: any) {
      this.log.error({ err: String(err?.message ?? err) }, "wallet vault request failed");
      await this.terminal.error(`Wallet vault: ${String(err?.message ?? err).slice(0, 200)}`, `wallet-vault-error:${Math.floor(now / 600_000)}`).catch(() => undefined);
    }
  }

  /**
   * Publish the payout signer's sanitized status (configured / derived address matches / code) for
   * the read-only wallet verification. Never contains key material.
   */
  async publishSignerStatus() {
    const st: PayoutSignerStatus = this.d.signerStatus ?? {
      configured: !!this.signer && (!this.d.cfg.payout.walletPublicKey || this.signer.address === this.d.cfg.payout.walletPublicKey),
      address: this.d.cfg.payout.walletPublicKey,
      derivedMatches: this.signer ? !this.d.cfg.payout.walletPublicKey || this.signer.address === this.d.cfg.payout.walletPublicKey : null,
      code: this.signer ? "ok" : "not_configured",
      message: this.signer ? "payout signer loaded" : "no payout signing key is configured in this process",
      checkedAt: new Date(this.clock.now()).toISOString(),
    };
    await this.d.db.SystemState.updateOne({ _id: "payout_signer_status" }, { $set: { value: { ...st, instance: this.d.cfg.instanceId }, updatedAt: new Date() } }, { upsert: true });
  }
}
