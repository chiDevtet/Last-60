/**
 * Runtime settings: environment defaults overlaid with admin overrides stored in MongoDB.
 * Every change is validated with the same rules as startup, applied with an optimistic version
 * check, and recorded in `config_audit` with a field-level diff. Secrets are NEVER runtime-settable.
 */
import { z } from "zod";
import { WSOL_MINT } from "@last60/shared";
import type { AppConfig } from "./env";
import { isValidPubkey } from "./env";
import type { Models } from "../db/models";
import { roleChangeBlockReason } from "../accounting/attribution";
import { deriveLaunchLabPool } from "../providers/raydium/pda";

const pubkey = z.string().trim().refine(isValidPubkey, "must be a Solana public key");
const httpUrl = z.string().trim().refine((v) => /^https?:\/\//.test(v), "must be an http(s) URL");
const wsUrl = z.string().trim().refine((v) => /^wss?:\/\//.test(v), "must be a ws(s) URL");
const intStr = z.string().regex(/^\d+$/, "must be an integer amount of base units");

export const RuntimeOverridesSchema = z
  .object({
    launchProvider: z.enum(["meteora_dbc", "raydium_launchlab", "mock"]),
    tokenMint: pubkey,
    poolAddress: pubkey,
    feeBeneficiaryRole: z.enum(["creator", "partner", "platform"]),
    buyerCount: z.number().int().min(1).max(50),
    minBuyQuote: intStr,
    rewardBps: z.number().int().min(1).max(10_000),
    payoutAsset: z.string().trim().refine((v) => v.toUpperCase() === "SOL" || isValidPubkey(v), 'must be "SOL" or a mint address'),
    payoutMode: z.enum(["dry_run", "live"]),
    expectedPayoutPublicKey: pubkey,
    rpcUrls: z.array(httpUrl).min(1).max(5),
    wsUrl,
    indexerPollIntervalMs: z.number().int().min(250).max(60_000),
    indexerUseWebsocket: z.boolean(),
    excludedWallets: z.array(pubkey).max(500),
    minPayoutLamports: intStr,
    skippedRoundPolicy: z.enum(["rollover", "retain"]),
    feeCollectionMode: z.enum(["manual", "auto_claim"]),
    pauseIndexer: z.boolean(),
    pausePayouts: z.boolean(),
    pauseScheduler: z.boolean(),
  })
  .partial()
  .strict();

export type RuntimeOverrides = z.infer<typeof RuntimeOverridesSchema>;

/**
 * Keys that redirect money or the data money decisions are based on. `rpcUrls`/`wsUrl` are
 * critical: the rewards worker decides payout expiry, balances and fee attribution from what the
 * RPC tells it, so a malicious endpoint could fabricate swaps or "expired" statuses.
 */
export const CRITICAL_KEYS: (keyof RuntimeOverrides)[] = ["launchProvider", "tokenMint", "poolAddress", "feeBeneficiaryRole", "rewardBps", "payoutAsset", "payoutMode", "expectedPayoutPublicKey", "rpcUrls", "wsUrl", "feeCollectionMode"];

export interface EffectiveSettings {
  version: number;
  launchProvider: AppConfig["provider"]["id"];
  tokenMint: string | null;
  poolAddress: string | null;
  /** `configured` (override / environment) or `derived` (Raydium LaunchLab PDA of the token mint, SOL quote). */
  poolAddressSource: "configured" | "derived" | null;
  feeBeneficiaryRole: AppConfig["provider"]["feeBeneficiaryRole"];
  buyerCount: number;
  minBuyQuote: bigint;
  rewardBps: number;
  payoutAssetMint: string;
  payoutMode: "dry_run" | "live";
  expectedPayoutPublicKey: string | null;
  rpcUrls: string[];
  wsUrl: string | null;
  indexerPollIntervalMs: number;
  indexerUseWebsocket: boolean;
  excludedWallets: string[];
  minPayoutLamports: bigint;
  skippedRoundPolicy: "rollover" | "retain";
  feeCollectionMode: "manual" | "auto_claim";
  pauseIndexer: boolean;
  pausePayouts: boolean;
  pauseScheduler: boolean;
}

/**
 * The pool to index. An explicit pool override wins. Otherwise, for Raydium LaunchLab, a token mint set
 * in the admin console is followed by its derived pool (never by an environment pool of another
 * token); without a token override the environment pool (itself derived when only TOKEN_MINT is set).
 */
function resolvePool(cfg: AppConfig, o: RuntimeOverrides, launchProvider: EffectiveSettings["launchProvider"], tokenMint: string | null): Pick<EffectiveSettings, "poolAddress" | "poolAddressSource"> {
  if (o.poolAddress) return { poolAddress: o.poolAddress, poolAddressSource: "configured" };
  const launchLab = launchProvider === "raydium_launchlab";
  const derive = (mint: string) => ({ poolAddress: deriveLaunchLabPool(mint), poolAddressSource: "derived" as const });
  if (launchLab && o.tokenMint) return derive(o.tokenMint);
  if (cfg.provider.poolAddress && launchProvider === cfg.provider.id) return { poolAddress: cfg.provider.poolAddress, poolAddressSource: cfg.provider.poolAddressSource ?? "configured" };
  if (launchLab && tokenMint) return derive(tokenMint);
  return { poolAddress: null, poolAddressSource: null };
}

export function resolveSettings(cfg: AppConfig, overrides: RuntimeOverrides, version: number): EffectiveSettings {
  const o = overrides;
  const launchProvider = o.launchProvider ?? cfg.provider.id;
  const tokenMint = o.tokenMint ?? cfg.provider.tokenMint;
  return {
    version,
    launchProvider,
    tokenMint,
    ...resolvePool(cfg, o, launchProvider, tokenMint),
    feeBeneficiaryRole: o.feeBeneficiaryRole ?? cfg.provider.feeBeneficiaryRole,
    buyerCount: o.buyerCount ?? cfg.rewards.buyerCount,
    minBuyQuote: o.minBuyQuote !== undefined ? BigInt(o.minBuyQuote) : cfg.rewards.minBuyQuote,
    rewardBps: o.rewardBps ?? cfg.rewards.rewardBps,
    payoutAssetMint: o.payoutAsset ? (o.payoutAsset.toUpperCase() === "SOL" ? WSOL_MINT : o.payoutAsset) : cfg.payout.assetMint,
    payoutMode: o.payoutMode ?? cfg.payout.mode,
    expectedPayoutPublicKey: o.expectedPayoutPublicKey ?? cfg.payout.walletPublicKey,
    rpcUrls: o.rpcUrls ?? cfg.solana.rpcUrls,
    wsUrl: o.wsUrl ?? cfg.solana.wsUrl,
    indexerPollIntervalMs: o.indexerPollIntervalMs ?? cfg.indexer.pollIntervalMs,
    indexerUseWebsocket: o.indexerUseWebsocket ?? cfg.indexer.useWebsocket,
    excludedWallets: o.excludedWallets ?? cfg.rewards.excludedWallets,
    minPayoutLamports: o.minPayoutLamports !== undefined ? BigInt(o.minPayoutLamports) : cfg.rewards.minPayoutLamports,
    skippedRoundPolicy: o.skippedRoundPolicy ?? cfg.rewards.skippedRoundPolicy,
    feeCollectionMode: o.feeCollectionMode ?? cfg.feeCollection.mode,
    pauseIndexer: o.pauseIndexer ?? false,
    pausePayouts: o.pausePayouts ?? false,
    pauseScheduler: o.pauseScheduler ?? false,
  };
}

/** Cross-field rules that a patch must satisfy in combination with the environment. */
export function validateEffective(cfg: AppConfig, s: EffectiveSettings): string[] {
  const p: string[] = [];
  if (s.launchProvider !== "mock" && !s.tokenMint) p.push("tokenMint is required for this provider");
  else if (s.launchProvider !== "mock" && !s.poolAddress) p.push("poolAddress is required for this provider (only a Raydium LaunchLab pool is derived from the token mint)");
  if (s.launchProvider === "mock" && cfg.solana.cluster === "mainnet-beta") p.push("the mock provider (synthetic data) is refused on mainnet-beta");
  if (s.launchProvider === "meteora_dbc" && s.feeBeneficiaryRole === "platform") p.push('Meteora DBC supports roles "creator" or "partner"');
  if (s.launchProvider === "raydium_launchlab" && s.feeBeneficiaryRole === "partner") p.push('Raydium LaunchLab supports roles "creator" or "platform"');
  if (s.payoutMode === "live" && cfg.solana.cluster === "mainnet-beta" && !cfg.payout.allowMainnet) p.push("live payouts on mainnet-beta require ALLOW_MAINNET_PAYOUTS=true in the environment");
  if (s.payoutMode === "live" && !cfg.secrets.payoutWalletPrivateKey && !cfg.secrets.payoutWalletKeypairPath && cfg.wallets?.payout.source !== "vault") p.push("live payouts require a payout wallet: generate one in the admin console (Wallets) or set a payout signing key in the environment");
  if (s.payoutAssetMint === WSOL_MINT && s.minPayoutLamports < 890_880n) p.push("minPayoutLamports must be >= 890880 (rent-exempt minimum)");
  if (s.minBuyQuote <= 0n) p.push("minBuyQuote must be positive");
  return p;
}

/**
 * Why THIS process must not sign live (fund-moving) transactions right now, or null if it may.
 *
 * The runtime `payoutMode` override is validated by whichever process wrote it (normally the API,
 * against the API's own environment) — or not at all if the settings document was written
 * directly. The signing process therefore re-checks the mainnet switch against its OWN
 * environment immediately before every signature, and honours the current effective mode, so
 * that neither an admin override nor a database write can bypass ALLOW_MAINNET_PAYOUTS.
 */
export function liveSigningBlockReason(cfg: AppConfig, s: Pick<EffectiveSettings, "payoutMode">): string | null {
  if (s.payoutMode !== "live") return "payout mode is dry_run; queued live payouts wait until live mode is re-enabled";
  if (cfg.solana.cluster === "mainnet-beta" && !cfg.payout.allowMainnet) return "live payouts on mainnet-beta require ALLOW_MAINNET_PAYOUTS=true in the rewards worker's own environment";
  return null;
}

export class SettingsStore {
  private cache: { at: number; value: EffectiveSettings } | null = null;
  constructor(
    private readonly db: Models,
    private readonly cfg: AppConfig,
    private readonly ttlMs = 3000,
  ) {}

  async raw(): Promise<{ version: number; overrides: RuntimeOverrides; updatedAt: Date | null; updatedBy: string | null }> {
    const doc: any = await this.db.Settings.findById("active").lean();
    return { version: doc?.version ?? 0, overrides: (doc?.overrides ?? {}) as RuntimeOverrides, updatedAt: doc?.updatedAt ?? null, updatedBy: doc?.updatedBy ?? null };
  }

  async get(force = false): Promise<EffectiveSettings> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    const r = await this.raw();
    const parsed = RuntimeOverridesSchema.safeParse(r.overrides);
    const value = resolveSettings(this.cfg, parsed.success ? parsed.data : {}, r.version);
    this.cache = { at: Date.now(), value };
    return value;
  }

  /**
   * Apply a validated patch. `null` values remove an override (revert to the environment default).
   * Fails if `expectedVersion` is stale (concurrent admin edit).
   */
  async update(patch: Record<string, unknown>, ctx: { actor: string; reason?: string; ip?: string; expectedVersion: number }) {
    const current = await this.raw();
    if (current.version !== ctx.expectedVersion) throw new SettingsConflictError(current.version);
    const next: Record<string, unknown> = { ...current.overrides };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const parsed = RuntimeOverridesSchema.safeParse(next);
    if (!parsed.success) throw new SettingsValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    const effective = resolveSettings(this.cfg, parsed.data, current.version + 1);
    const problems = validateEffective(this.cfg, effective);
    const before = resolveSettings(this.cfg, RuntimeOverridesSchema.safeParse(current.overrides).data ?? {}, current.version);
    // U1: any change of who/what fees are attributed to — role, pool or provider — is checked against
    // the target pool's history in BOTH collections (swaps and non-swap fee attributions).
    if (effective.feeBeneficiaryRole !== before.feeBeneficiaryRole || effective.poolAddress !== before.poolAddress || effective.launchProvider !== before.launchProvider) {
      const blocked = await roleChangeBlockReason(this.db, effective.poolAddress, effective.feeBeneficiaryRole, { provider: effective.launchProvider });
      if (blocked) problems.push(`feeBeneficiaryRole: ${blocked}`);
    }
    if (problems.length) throw new SettingsValidationError(problems);
    const changes = Object.keys({ ...current.overrides, ...parsed.data })
      .filter((k) => JSON.stringify((current.overrides as any)[k]) !== JSON.stringify((parsed.data as any)[k]))
      .map((k) => ({ key: k, from: (current.overrides as any)[k] ?? null, to: (parsed.data as any)[k] ?? null }));
    if (!changes.length) return { version: current.version, changes };
    const res = await this.db.Settings.updateOne(
      { _id: "active", version: current.version },
      { $set: { overrides: parsed.data, version: current.version + 1, updatedAt: new Date(), updatedBy: ctx.actor } },
      { upsert: current.version === 0 },
    ).catch((err: any) => {
      if (err?.code === 11000) return { matchedCount: 0, upsertedCount: 0 };
      throw err;
    });
    if ((res as any).matchedCount === 0 && (res as any).upsertedCount === 0) throw new SettingsConflictError(current.version);
    await this.db.ConfigAudit.create({ version: current.version + 1, actor: ctx.actor, action: "update", changes, reason: ctx.reason ?? null, ip: ctx.ip ?? null });
    this.cache = null;
    return { version: current.version + 1, changes };
  }
}

export class SettingsValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid settings: ${problems.join("; ")}`);
  }
}
export class SettingsConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`Settings were changed concurrently (current version ${currentVersion}); reload and retry`);
  }
}
