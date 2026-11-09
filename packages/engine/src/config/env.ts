/**
 * Environment configuration. Validated once at process start; any error is fatal with a clear
 * message listing every problem. Secrets are never logged and never exposed via NEXT_PUBLIC_*.
 */
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { parseUnits, WSOL_MINT } from "@last60/shared";
import { jsonSafe } from "../util/json";
import { PayoutSigner } from "../signer/payoutSigner";
import { APPROVED_SHARES, makeFundingPolicy, type FundingCorrelationMode, type FundingPolicy } from "../accounting/revenueStreams";
import { loadKeypair } from "../chain/keys";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { deriveLaunchLabPool } from "../providers/raydium/pda";

/** Forgepad's PlatformConfig `platform_nft_wallet` (owner of Forge's platform LP Fee Key) on mainnet-beta. */
export const FORGEPAD_PLATFORM_NFT_WALLET = "8KXqQwtrgtKxNfTWYsN34XNKXVQQR78JZfgbLorNL2n1";
/**
 * Placeholder activation slot of a forge_phase_aware_v2 policy whose slot is pinned at boot
 * (`resolveFundingActivation`). Nothing is after it, and `revenueRuntimeOf` refuses to record revenue
 * while it is pending, so an unresolved policy can never write a credit or fund a round.
 */
export const PENDING_ACTIVATION_SLOT = Number.MAX_SAFE_INTEGER;

export type ProcessRole = "indexer" | "rewards" | "api" | "cli" | "test";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      if (/^(1|true|yes|on)$/i.test(v)) return true;
      if (/^(0|false|no|off)$/i.test(v)) return false;
      ctx.addIssue({ code: "custom", message: `expected boolean, got "${v}"` });
      return z.NEVER;
    });

/** Like `bool` but `undefined` when unset, so a default can depend on other settings. */
const optBool = () =>
  z
    .string()
    .optional()
    .transform((v, ctx): boolean | undefined => {
      if (v === undefined || v === "") return undefined;
      if (/^(1|true|yes|on)$/i.test(v)) return true;
      if (/^(0|false|no|off)$/i.test(v)) return false;
      ctx.addIssue({ code: "custom", message: `expected boolean, got "${v}"` });
      return z.NEVER;
    });

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      if (!/^-?\d+$/.test(v.trim())) {
        ctx.addIssue({ code: "custom", message: `expected integer, got "${v}"` });
        return z.NEVER;
      }
      const n = Number(v);
      if (n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `must be between ${min} and ${max}, got ${n}` });
        return z.NEVER;
      }
      return n;
    });

const bigintStr = (def: bigint, min = 0n) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      if (!/^\d+$/.test(v.trim())) {
        ctx.addIssue({ code: "custom", message: `expected a non-negative integer, got "${v}"` });
        return z.NEVER;
      }
      const n = BigInt(v.trim());
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `must be >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

export function isValidPubkey(v: string): boolean {
  try {
    return new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
}

const pubkey = z.string().trim().refine(isValidPubkey, { message: "must be a base58 Solana public key" });
const optionalPubkey = z
  .string()
  .optional()
  .transform((v) => (v ? v.trim() : undefined))
  .refine((v) => v === undefined || isValidPubkey(v), { message: "must be a base58 Solana public key" });

const csv = (item: z.ZodType<string, string>) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []))
    .pipe(z.array(item));

const url = (protocols: string[]) =>
  z
    .string()
    .trim()
    .refine((v) => {
      try {
        return protocols.includes(new URL(v).protocol);
      } catch {
        return false;
      }
    }, { message: `must be a URL (${protocols.join(" ")})` });

/** "75" → 7500 bps, "75.5" → 7550. At most 2 decimal places. */
export function percentToBps(v: string): number {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v.trim())) throw new Error(`invalid percentage "${v}"`);
  const bps = Number(parseUnits(v.trim(), 2));
  if (bps <= 0 || bps > 10_000) throw new Error(`percentage must be in (0, 100], got ${v}`);
  return bps;
}

const RawEnv = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  INSTANCE_ID: z.string().optional(),

  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet", "localnet"]),
  SOLANA_RPC_URL: z.string().optional(),
  SOLANA_RPC_FALLBACK_URLS: csv(url(["http:", "https:"])),
  SOLANA_WS_URL: z.string().optional(),
  SOLANA_MAX_TX_VERSION: int(1, 0, 255),
  SOLANA_RPC_TIMEOUT_MS: int(15_000, 1000, 120_000),
  SOLANA_RPC_MAX_RPS: int(20, 1, 1000),
  HELIUS_API_KEY: z.string().optional(),

  LAUNCH_PROVIDER: z.enum(["meteora_dbc", "raydium_launchlab", "mock"]).default("meteora_dbc"),
  TOKEN_MINT: optionalPubkey,
  POOL_ADDRESS: optionalPubkey,
  FEE_BENEFICIARY_ROLE: z.enum(["creator", "partner", "platform"]).default("creator"),
  // Operator-declared EXPECTED creator allocation. Used only to VERIFY what the chain says; the
  // accounting always uses the on-chain value. A mismatch flags the pool and makes the affected fees
  // ineligible for payout. Unset = not declared (warned).
  EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE: z.string().optional(),
  EXPECTED_DBC_CREATOR_LP_PERCENTAGE: z.string().optional(),
  EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE: z.string().optional(),
  EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE: z.string().optional(),
  EXPECTED_LAUNCHLAB_PLATFORM_CONFIG: z.string().optional(),
  /** CPMM AmmConfig.creator_fee_rate the migrated pool must use (millionths of swap value; Forgepad 500 = 0.05 %). */
  EXPECTED_CPMM_CREATOR_FEE_RATE: z.string().optional(),

  // Phase-aware reward funding (docs/REWARD_FUNDING.md). Default: forge_phase_aware_v2, the approved model.
  // legacy_creator_fee_v1 stays selectable; forge_phase_aware_v1 (PR #6) is retired and rejected.
  REWARD_FUNDING_POLICY: z.enum(["legacy_creator_fee_v1", "forge_phase_aware_v1", "forge_phase_aware_v2"]).default("forge_phase_aware_v2"),
  /**
   * Phase-aware policy governs slots strictly after this slot. Unset (or "auto") under forge_phase_aware_v2:
   * pinned ONCE to the finalized slot at the first start of any process and persisted in
   * system_state.funding_policy_activation, so every process uses the same slot across restarts.
   */
  REWARD_FUNDING_POLICY_ACTIVATION_SLOT: z.string().optional(),
  /** Wallets that receive Last-60 funding (native SOL to the wallet, SPL to token accounts it owns). */
  LAST60_FUNDING_DESTINATIONS: csv(pubkey),
  /** Expected owner of Forge's platform LP Fee Key (must equal the PlatformConfig platform_nft_wallet). */
  FORGE_PLATFORM_LP_BENEFICIARY: optionalPubkey,
  /** Approved model, fixed: 75 % of each COLLECTED bonding-curve creator fee funds Last-60 (any other value is rejected). */
  BONDING_CREATOR_FEE_LAST60_PERCENTAGE: z.string().default("75"),
  /** Approved model, fixed: the creator's 50 % allocation of each CLAIMED Forge platform LP fee funds Last-60 (any other value is rejected). */
  FORGE_PLATFORM_LP_LAST60_PERCENTAGE: z.string().default("50"),
  /** strict: same-transaction or memo correlation only. exclusive_window: also the unambiguous latest claim (recorded, never payable). */
  FUNDING_CORRELATION_MODE: z.enum(["strict", "exclusive_window"]).default("strict"),

  BUYER_COUNT: int(5, 1, 50),
  MIN_BUY_SOL: z.string().default("0.05"),
  MIN_BUY_QUOTE_AMOUNT: z.string().optional(),
  EXCLUDED_WALLETS: csv(pubkey),

  ROUND_DURATION_SECONDS: int(300, 30, 86_400),
  RANDOM_WINDOW_START_SECONDS: int(240, 0, 86_400),
  RANDOM_WINDOW_DURATION_SECONDS: int(60, 1, 86_400),
  ROUND_ANCHOR_EPOCH_SECONDS: int(0, 0),
  ROUND_GENESIS_AT: z.string().optional(),
  LATE_EXECUTION_GRACE_SECONDS: int(5, 0, 600),
  SNAPSHOT_SETTLE_MS: int(1500, 0, 30_000),

  REWARD_PERCENTAGE: z.string().default("75"),
  SKIPPED_ROUND_POLICY: z.enum(["rollover", "retain"]).default("rollover"),
  MIN_PAYOUT_LAMPORTS: bigintStr(1_000_000n),

  PAYOUT_ASSET: z.string().default("SOL"),
  PAYOUT_MODE: z.enum(["dry_run", "live"]).default("dry_run"),
  ALLOW_MAINNET_PAYOUTS: bool(false),
  /**
   * Dedicated Last-60 payout wallet (docs/PAYOUT_WALLET.md). The address is the payout destination of
   * every custody transfer and the only wallet payouts are signed from. The private key is loaded ONLY
   * by the rewards worker's payout signer and must derive exactly this address (fail closed otherwise).
   */
  LAST60_PAYOUT_WALLET_ADDRESS: optionalPubkey,
  LAST60_PAYOUT_WALLET_PRIVATE_KEY: z.string().optional(),
  LAST60_PAYOUT_WALLET_KEYPAIR_PATH: z.string().optional(),
  /** Legacy names (PR #1–#8) of the three variables above; accepted as aliases, never with a different value. */
  PAYOUT_WALLET_PUBLIC_KEY: optionalPubkey,
  PAYOUT_WALLET_PRIVATE_KEY: z.string().optional(),
  PAYOUT_WALLET_KEYPAIR_PATH: z.string().optional(),
  /** Custody workflow (sweep requests and their verification). Default: on under forge_phase_aware_v2 with a payout wallet. */
  LAST60_CUSTODY_ENABLED: optBool(),
  /** Hours an open custody (sweep) request stays bindable before it expires. */
  LAST60_CUSTODY_REQUEST_TTL_HOURS: int(168, 1, 8_760),
  /** Operator re-evaluation of unresolved Forge attributions. Disabled by default. */
  LAST60_ATTRIBUTION_RECOVERY_ENABLED: bool(false),
  PAYOUT_COMMITMENT: z.enum(["confirmed", "finalized"]).default("finalized"),
  PAYOUT_PRIORITY_FEE_MICROLAMPORTS: int(10_000, 0, 100_000_000),
  PAYOUT_COMPUTE_UNIT_LIMIT: int(40_000, 1_000, 1_400_000),
  PAYOUT_MAX_ATTEMPTS: int(5, 1, 50),
  PAYOUT_WALLET_MIN_RESERVE_LAMPORTS: bigintStr(10_000_000n),
  PAYOUT_CONCURRENCY: int(3, 1, 20),
  PAYOUT_MEMO: bool(true),

  /** Default: auto_claim when the creator wallet is configured (LAST60_CREATOR_WALLET_*), else manual. */
  FEE_COLLECTION_MODE: z.enum(["manual", "auto_claim"]).optional(),
  FEE_CLAIM_AUTHORITY_PRIVATE_KEY: z.string().optional(),
  FEE_CLAIM_AUTHORITY_KEYPAIR_PATH: z.string().optional(),
  FEE_CLAIM_MIN_LAMPORTS: bigintStr(10_000_000n),

  /**
   * Launch creator wallet automation (docs/CREATOR_WALLET.md). With the creator's key loaded in the
   * rewards worker, Last-60 claims the bonding-curve creator fees, sends the 75 % Last-60 share to the
   * payout wallet (memo-correlated to its claim) and sweeps Forge's post-migration creator payouts into
   * the payout wallet (custody transfers) — no manual step. The key is loaded ONLY by the rewards worker.
   */
  LAST60_CREATOR_WALLET_ADDRESS: optionalPubkey,
  LAST60_CREATOR_WALLET_PRIVATE_KEY: z.string().optional(),
  LAST60_CREATOR_WALLET_KEYPAIR_PATH: z.string().optional(),
  /** Default: on whenever the creator key is configured (requires forge_phase_aware_v2). */
  LAST60_CREATOR_AUTOMATION_ENABLED: optBool(),
  LAST60_CREATOR_AUTOMATION_INTERVAL_SECONDS: int(30, 5, 3_600),
  /** Smaller outstanding amounts are left (a transfer would cost more in fees than it moves). */
  LAST60_CREATOR_MIN_TRANSFER_LAMPORTS: bigintStr(10_000n),
  /** SOL always left in the creator wallet for network fees. */
  LAST60_CREATOR_FEE_RESERVE_LAMPORTS: bigintStr(2_000_000n),

  /**
   * Wallet vault (docs/WALLETS.md): wallets generated from the admin console are encrypted by the rewards
   * worker with this 32-byte key. Default: a key FILE created on first use (chmod 600, outside the
   * repository) at LAST60_WALLET_VAULT_KEY_PATH; LAST60_WALLET_VAULT_KEY (base64) overrides it.
   */
  LAST60_WALLET_VAULT_KEY: z.string().optional(),
  LAST60_WALLET_VAULT_KEY_PATH: z.string().optional(),

  SCHEDULE_ENCRYPTION_KEY: z.string().optional(),

  MONGODB_URI: z.string().min(1, "is required"),
  MONGODB_DB_NAME: z.string().default("last60"),

  INDEXER_POLL_INTERVAL_MS: int(2000, 250, 60_000),
  INDEXER_USE_WEBSOCKET: bool(true),
  INDEXER_BACKFILL: z.enum(["full", "none"]).default("full"),
  INDEXER_BACKFILL_MAX_SIGNATURES: int(100_000, 0),
  INDEXER_FINALITY_CHECK_MS: int(10_000, 1000),
  INDEXER_DROP_AFTER_SECONDS: int(180, 30),
  INDEXER_FETCH_CONCURRENCY: int(4, 1, 32),

  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: int(4000, 1, 65_535),
  CORS_ORIGINS: csv(z.string()),
  PUBLIC_SITE_URL: z.string().optional(),
  ADMIN_WALLETS: csv(pubkey),
  ADMIN_SESSION_SECRET: z.string().optional(),
  ADMIN_SESSION_TTL_SECONDS: int(3600, 60, 86_400),
  STREAM_SNAPSHOT_INTERVAL_MS: int(2000, 500, 60_000),
  /** Number of trusted reverse proxies in front of the API (0 = use the socket peer address). */
  API_TRUST_PROXY_HOPS: int(0, 0, 10),

  RECONCILIATION_INTERVAL_SECONDS: int(300, 30),
  RECONCILIATION_HALT_ON_OVER_ATTRIBUTION: bool(true),
  RECONCILIATION_TOLERANCE_LAMPORTS: bigintStr(0n),
  TERMINAL_RETENTION_DAYS: int(30, 1, 3650),

  NEXT_PUBLIC_APP_NAME: z.string().default("LAST60"),
  NEXT_PUBLIC_SOLANA_EXPLORER: z.string().default("https://solscan.io"),
});

/**
 * Declared creator allocation for Forgepad-style launches (all optional, integers):
 *   dbcCreatorTradingFeePercentage — DBC `creator_trading_fee_percentage` (0-100, share of the LP trading fee while bonding)
 *   dbcCreatorLpPercentage         — DBC creator liquidity + permanently locked + vesting LP percentages (0-100)
 *   launchlabCreatorFeeRate        — LaunchLab `creator_fee_rate`, a FEE RATE on trade value in millionths (5000 = 0.5% of the trade)
 *   launchlabPlatformConfig        — LaunchLab PlatformConfig address the pool must be bound to (Forgepad: 5zZFa8Ki…)
 *   launchlabCreatorLpScale        — LaunchLab PlatformConfig `creator_scale` VALUE in millionths of migrated LP. A config
 *                                    fact only: it is NOT a creator entitlement (since the 2026-08-17 upgrade it is
 *                                    added to the platform's Fee Key); creator LP entitlement needs a creator Fee Key
 *                                    minted by the migration transaction
 */
export interface ExpectedAllocation {
  dbcCreatorTradingFeePercentage: number | null;
  dbcCreatorLpPercentage: number | null;
  launchlabCreatorFeeRate: number | null;
  launchlabCreatorLpScale: number | null;
  launchlabPlatformConfig?: string | null;
  /** CPMM AmmConfig.creator_fee_rate (millionths of swap value). */
  cpmmCreatorFeeRate?: number | null;
}

export interface CustodyConfig {
  /** Custody sweep requests / verification are enabled (LAST60_CUSTODY_ENABLED). */
  enabled: boolean;
  /** The dedicated payout wallet every custody transfer must reach (null: not configured — nothing is custodied). */
  payoutWallet: string | null;
  requestTtlMs: number;
}

export interface RevenueConfig {
  policy: FundingPolicy;
  /** Configured Last-60 funding destination wallets (owners). */
  fundingDestinations: string[];
  /** Expected Forge platform LP Fee Key owner; null = not declared (Forge LP contributions unresolved). */
  forgePlatformLpBeneficiary: string | null;
  correlationMode: FundingCorrelationMode;
  /** Physical custody of credited contributions (docs/REWARD_FUNDING.md §14). */
  custody: CustodyConfig;
  /** Operator recovery of unresolved Forge attributions (docs/REWARD_FUNDING.md §15). */
  recoveryEnabled: boolean;
  /**
   * Where the activation slot comes from: `configured` (REWARD_FUNDING_POLICY_ACTIVATION_SLOT), `auto`
   * (pinned at first boot and persisted; `pending` until `resolveFundingActivation` ran) or
   * `not_applicable` (legacy policy).
   */
  activation: { source: "configured" | "auto" | "not_applicable"; pending: boolean };
}

/** Where a wallet's address (and, in the rewards worker, its key) comes from. */
export interface WalletSourceConfig {
  address: string | null;
  /** `env`: LAST60_*_ADDRESS / key variables; `vault`: generated from the admin console; null: none yet. */
  source: "env" | "vault" | null;
}
export interface WalletsConfig {
  payout: WalletSourceConfig;
  creator: WalletSourceConfig;
  /** File holding the vault key (unless LAST60_WALLET_VAULT_KEY is set). */
  vaultKeyPath: string;
}
/** Addresses of active vault wallets, read from the database at boot (`readVaultWallets`). */
export interface VaultAddresses {
  payout?: string | null;
  creator?: string | null;
}

export interface CreatorWalletConfig {
  /** Declared public address of the launch creator wallet (cross-checked against the key and the pool's on-chain creator). */
  address: string | null;
  /** The creator key is configured in this process (rewards worker only). */
  keyConfigured: boolean;
  /** Claim, 75 % settlement and post-migration sweeps run automatically (needs the key and forge_phase_aware_v2). */
  automationEnabled: boolean;
  intervalMs: number;
  minTransferLamports: bigint;
  feeReserveLamports: bigint;
}

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  logLevel: string;
  instanceId: string;
  solana: {
    cluster: "mainnet-beta" | "devnet" | "testnet" | "localnet";
    rpcUrls: string[];
    wsUrl: string | null;
    maxTxVersion: number;
    timeoutMs: number;
    maxRps: number;
  };
  provider: {
    id: "meteora_dbc" | "raydium_launchlab" | "mock";
    tokenMint: string | null;
    poolAddress: string | null;
    /** `derived`: POOL_ADDRESS was unset and the LaunchLab pool was derived from TOKEN_MINT. */
    poolAddressSource: "configured" | "derived" | null;
    feeBeneficiaryRole: "creator" | "partner" | "platform";
    expected: ExpectedAllocation;
  };
  rewards: {
    buyerCount: number;
    /** Minimum qualifying buy in quote base units (lamports for SOL). */
    minBuyQuote: bigint;
    minBuySolInput: string;
    rewardBps: number;
    skippedRoundPolicy: "rollover" | "retain";
    minPayoutLamports: bigint;
    excludedWallets: string[];
  };
  schedule: {
    roundDurationMs: number;
    windowStartMs: number;
    windowDurationMs: number;
    anchorEpochMs: number;
    genesisAt: Date | null;
    lateGraceMs: number;
    snapshotSettleMs: number;
    encryptionKey: Buffer | null;
  };
  payout: {
    asset: "SOL" | string;
    assetMint: string;
    mode: "dry_run" | "live";
    allowMainnet: boolean;
    walletPublicKey: string | null;
    commitment: "confirmed" | "finalized";
    priorityFeeMicroLamports: number;
    computeUnitLimit: number;
    maxAttempts: number;
    minReserveLamports: bigint;
    concurrency: number;
    memo: boolean;
  };
  feeCollection: { mode: "manual" | "auto_claim"; minClaimLamports: bigint };
  creatorWallet: CreatorWalletConfig;
  wallets: WalletsConfig;
  mongo: { uri: string; dbName: string };
  indexer: {
    pollIntervalMs: number;
    useWebsocket: boolean;
    backfill: "full" | "none";
    backfillMaxSignatures: number;
    finalityCheckMs: number;
    dropAfterSeconds: number;
    fetchConcurrency: number;
  };
  api: {
    host: string;
    port: number;
    corsOrigins: string[];
    publicSiteUrl: string | null;
    adminWallets: string[];
    adminSessionSecret: string | null;
    adminSessionTtlSeconds: number;
    streamSnapshotIntervalMs: number;
    /** X-Forwarded-For entries appended by trusted proxies; the client is the Nth from the right. */
    trustProxyHops: number;
  };
  reconciliation: { intervalMs: number; haltOnOverAttribution: boolean; toleranceLamports: bigint };
  revenue: RevenueConfig;
  terminal: { retentionDays: number };
  public: { appName: string; explorer: string };
  /** Secrets are kept out of the main object so it can be logged/inspected safely. */
  secrets: SecretSources;
}

export interface SecretSources {
  payoutWalletPrivateKey?: string;
  payoutWalletKeypairPath?: string;
  feeClaimAuthorityPrivateKey?: string;
  feeClaimAuthorityKeypairPath?: string;
  creatorWalletPrivateKey?: string;
  creatorWalletKeypairPath?: string;
  walletVaultKey?: string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const SECRET_KEYS = [
  "LAST60_PAYOUT_WALLET_PRIVATE_KEY",
  "PAYOUT_WALLET_PRIVATE_KEY",
  "FEE_CLAIM_AUTHORITY_PRIVATE_KEY",
  "LAST60_CREATOR_WALLET_PRIVATE_KEY",
  "LAST60_WALLET_VAULT_KEY",
  "SCHEDULE_ENCRYPTION_KEY",
  "ADMIN_SESSION_SECRET",
  "HELIUS_API_KEY",
  "MONGODB_URI",
];

/** Rejects any NEXT_PUBLIC_* variable that looks like or contains a secret. */
export function assertNoPublicSecrets(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const secretValues = SECRET_KEYS.map((k) => env[k]).filter((v): v is string => !!v && v.length >= 8);
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("NEXT_PUBLIC_") || !value) continue;
    if (/PRIVATE|SECRET|PASSWORD|MNEMONIC|SEED|API_KEY|MONGO/i.test(key)) {
      problems.push(`${key}: secrets must never use the NEXT_PUBLIC_ prefix (it is shipped to browsers)`);
    }
    for (const s of secretValues) {
      if (value.includes(s)) problems.push(`${key}: contains the value of a server secret`);
    }
  }
  return problems;
}

function deriveRpcUrl(raw: z.infer<typeof RawEnv>): string | undefined {
  if (raw.SOLANA_RPC_URL) return raw.SOLANA_RPC_URL;
  if (raw.HELIUS_API_KEY) {
    const host = raw.SOLANA_CLUSTER === "devnet" ? "devnet.helius-rpc.com" : "mainnet.helius-rpc.com";
    return `https://${host}/?api-key=${raw.HELIUS_API_KEY}`;
  }
  return undefined;
}

export function deriveWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  // Public Solana RPC serves websockets on port+1 for localnet only.
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") u.port = String(Number(u.port || "8899") + 1);
  return u.toString();
}

/**
 * `opts.vault`: addresses of wallets generated from the admin console (read from the database at boot).
 * They are used when the corresponding LAST60_*_ADDRESS is not set in the environment.
 */
export function loadConfig(role: ProcessRole, env: Record<string, string | undefined> = process.env, opts: { vault?: VaultAddresses } = {}): AppConfig {
  const parsed = RawEnv.safeParse(env);
  const problems: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ConfigError(problems);
  }
  const raw = parsed.data;
  problems.push(...assertNoPublicSecrets(env));
  // Dedicated payout wallet: canonical LAST60_* names, legacy PAYOUT_WALLET_* names as aliases.
  const alias = (name: string, v: string | undefined, legacy: string, l: string | undefined): string | undefined => {
    const a = v?.trim() ? v : undefined;
    const b = l?.trim() ? l : undefined;
    // Never echo the values (one of them may be a private key).
    if (a !== undefined && b !== undefined && a.trim() !== b.trim()) problems.push(`${name}: also set under the legacy name ${legacy} with a different value; set only ${name}`);
    return a ?? b;
  };
  const envPayoutAddress = alias("LAST60_PAYOUT_WALLET_ADDRESS", raw.LAST60_PAYOUT_WALLET_ADDRESS, "PAYOUT_WALLET_PUBLIC_KEY", raw.PAYOUT_WALLET_PUBLIC_KEY);
  const vaultPayout = opts.vault?.payout ?? null;
  const vaultCreator = opts.vault?.creator ?? null;
  if (envPayoutAddress && vaultPayout && envPayoutAddress !== vaultPayout) problems.push(`LAST60_PAYOUT_WALLET_ADDRESS: differs from the payout wallet generated in the admin console (${vaultPayout}); remove the environment value to use the generated wallet`);
  const payoutWalletAddress = envPayoutAddress ?? vaultPayout ?? undefined;
  const payoutFromVault = !envPayoutAddress && !!vaultPayout;
  const payoutKey = alias("LAST60_PAYOUT_WALLET_PRIVATE_KEY", raw.LAST60_PAYOUT_WALLET_PRIVATE_KEY, "PAYOUT_WALLET_PRIVATE_KEY", raw.PAYOUT_WALLET_PRIVATE_KEY);
  const payoutKeyPath = alias("LAST60_PAYOUT_WALLET_KEYPAIR_PATH", raw.LAST60_PAYOUT_WALLET_KEYPAIR_PATH, "PAYOUT_WALLET_KEYPAIR_PATH", raw.PAYOUT_WALLET_KEYPAIR_PATH);
  const creatorKey = raw.LAST60_CREATOR_WALLET_PRIVATE_KEY?.trim() ? raw.LAST60_CREATOR_WALLET_PRIVATE_KEY : undefined;
  const creatorKeyPath = raw.LAST60_CREATOR_WALLET_KEYPAIR_PATH?.trim() ? raw.LAST60_CREATOR_WALLET_KEYPAIR_PATH : undefined;
  const envCreatorKeySet = !!(creatorKey || creatorKeyPath);
  if (raw.LAST60_CREATOR_WALLET_ADDRESS && vaultCreator && raw.LAST60_CREATOR_WALLET_ADDRESS !== vaultCreator) problems.push(`LAST60_CREATOR_WALLET_ADDRESS: differs from the creator wallet generated in the admin console (${vaultCreator}); remove the environment value to use the generated wallet`);
  const creatorFromVault = !raw.LAST60_CREATOR_WALLET_ADDRESS && !envCreatorKeySet && !!vaultCreator;
  /** A creator key is available: in the environment, or generated (decrypted by the rewards worker). */
  const creatorKeySet = envCreatorKeySet || creatorFromVault;

  const rpcUrl = deriveRpcUrl(raw);
  if (!rpcUrl) problems.push("SOLANA_RPC_URL: is required (or set HELIUS_API_KEY)");
  else if (!url(["http:", "https:"]).safeParse(rpcUrl).success) problems.push("SOLANA_RPC_URL: must be an http(s) URL");
  let wsUrl: string | null = raw.SOLANA_WS_URL?.trim() || null;
  if (wsUrl && !url(["ws:", "wss:"]).safeParse(wsUrl).success) problems.push("SOLANA_WS_URL: must be a ws(s) URL");
  if (!wsUrl && rpcUrl) {
    try {
      wsUrl = deriveWsUrl(rpcUrl);
    } catch {
      /* reported above */
    }
  }

  // Reward parameters
  let rewardBps = 7500;
  try {
    rewardBps = percentToBps(raw.REWARD_PERCENTAGE);
  } catch (e) {
    problems.push(`REWARD_PERCENTAGE: ${(e as Error).message}`);
  }

  const payoutAssetMint = raw.PAYOUT_ASSET.toUpperCase() === "SOL" ? WSOL_MINT : raw.PAYOUT_ASSET.trim();
  if (raw.PAYOUT_ASSET.toUpperCase() !== "SOL" && !isValidPubkey(payoutAssetMint)) {
    problems.push(`PAYOUT_ASSET: must be "SOL" or an SPL mint address`);
  }

  let minBuyQuote = 0n;
  if (raw.MIN_BUY_QUOTE_AMOUNT) {
    if (!/^\d+$/.test(raw.MIN_BUY_QUOTE_AMOUNT)) problems.push("MIN_BUY_QUOTE_AMOUNT: must be an integer amount of quote base units");
    else minBuyQuote = BigInt(raw.MIN_BUY_QUOTE_AMOUNT);
  } else {
    try {
      minBuyQuote = parseUnits(raw.MIN_BUY_SOL, 9);
    } catch (e) {
      problems.push(`MIN_BUY_SOL: ${(e as Error).message}`);
    }
  }

  // Schedule
  if (raw.RANDOM_WINDOW_START_SECONDS + raw.RANDOM_WINDOW_DURATION_SECONDS > raw.ROUND_DURATION_SECONDS) {
    problems.push("RANDOM_WINDOW_START_SECONDS + RANDOM_WINDOW_DURATION_SECONDS must not exceed ROUND_DURATION_SECONDS");
  }
  let genesisAt: Date | null = null;
  if (raw.ROUND_GENESIS_AT) {
    const d = new Date(raw.ROUND_GENESIS_AT);
    if (Number.isNaN(d.getTime())) problems.push("ROUND_GENESIS_AT: must be an ISO-8601 timestamp");
    else genesisAt = d;
  }
  let encryptionKey: Buffer | null = null;
  if (raw.SCHEDULE_ENCRYPTION_KEY) {
    const k = Buffer.from(raw.SCHEDULE_ENCRYPTION_KEY, "base64");
    if (k.length !== 32) problems.push("SCHEDULE_ENCRYPTION_KEY: must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    else encryptionKey = k;
  }

  if (raw.MIN_PAYOUT_LAMPORTS < 890_880n && payoutAssetMint === WSOL_MINT) {
    problems.push("MIN_PAYOUT_LAMPORTS: must be >= 890880 (rent-exempt minimum) so payouts to empty wallets cannot fail");
  }

  // Role-specific requirements
  // The token and pool may be set later from the admin console: until then the indexer and rewards
  // worker wait ("waiting for launch"). A Raydium LaunchLab pool is derived from the token mint
  // (PDA ["pool", mint, WSOL]); a Meteora DBC pool also depends on its config and must be given.
  const needsChainTarget = role === "indexer" || role === "rewards";
  if (needsChainTarget && raw.LAUNCH_PROVIDER === "meteora_dbc" && raw.TOKEN_MINT && !raw.POOL_ADDRESS) problems.push("POOL_ADDRESS: is required for meteora_dbc (it cannot be derived from the token mint)");
  let derivedPool: string | null = null;
  if (raw.LAUNCH_PROVIDER === "raydium_launchlab" && raw.TOKEN_MINT && !raw.POOL_ADDRESS) derivedPool = deriveLaunchLabPool(raw.TOKEN_MINT);
  if (raw.LAUNCH_PROVIDER === "mock" && raw.NODE_ENV === "production") {
    problems.push("LAUNCH_PROVIDER: mock is synthetic test data and is refused in production");
  }
  if (raw.LAUNCH_PROVIDER === "meteora_dbc" && raw.FEE_BENEFICIARY_ROLE === "platform") {
    problems.push('FEE_BENEFICIARY_ROLE: "platform" is a Raydium LaunchLab role; use "creator" or "partner" for Meteora DBC');
  }
  if (raw.LAUNCH_PROVIDER === "raydium_launchlab" && raw.FEE_BENEFICIARY_ROLE === "partner") {
    problems.push('FEE_BENEFICIARY_ROLE: "partner" is a Meteora DBC role; use "creator" or "platform" for Raydium LaunchLab');
  }
  if (role === "rewards") {
    if (!encryptionKey) problems.push("SCHEDULE_ENCRYPTION_KEY: is required for the rewards worker");
    // No payout wallet yet is not an error: generate one from the admin console. Until then live payouts
    // stay queued (no signer) and the creator wallet automation stays idle.
    if (raw.PAYOUT_MODE === "live" && !payoutKey && !payoutKeyPath && !payoutFromVault) {
      problems.push("LAST60_PAYOUT_WALLET_PRIVATE_KEY or LAST60_PAYOUT_WALLET_KEYPAIR_PATH: required when PAYOUT_MODE=live (legacy names PAYOUT_WALLET_PRIVATE_KEY / PAYOUT_WALLET_KEYPAIR_PATH)");
    }
    if (raw.PAYOUT_MODE === "live" && raw.SOLANA_CLUSTER === "mainnet-beta" && !raw.ALLOW_MAINNET_PAYOUTS) {
      problems.push("ALLOW_MAINNET_PAYOUTS: must be explicitly set to true to send live payouts on mainnet-beta");
    }
    if (raw.FEE_COLLECTION_MODE === "auto_claim" && raw.LAUNCH_PROVIDER !== "mock") {
      // The payout signer never signs fee claims (narrow scope): auto_claim needs its own key.
      const hasClaimKey = raw.FEE_CLAIM_AUTHORITY_PRIVATE_KEY || raw.FEE_CLAIM_AUTHORITY_KEYPAIR_PATH || (raw.FEE_BENEFICIARY_ROLE === "creator" && creatorKeySet);
      if (!hasClaimKey) problems.push("FEE_CLAIM_AUTHORITY_PRIVATE_KEY or FEE_CLAIM_AUTHORITY_KEYPAIR_PATH (or, for FEE_BENEFICIARY_ROLE=creator, LAST60_CREATOR_WALLET_*): auto_claim needs the fee beneficiary's own signing key (the payout wallet key never signs fee claims)");
    }
  }
  if (role === "api" && raw.ADMIN_WALLETS.length > 0) {
    if (!raw.ADMIN_SESSION_SECRET || raw.ADMIN_SESSION_SECRET.length < 32) {
      problems.push("ADMIN_SESSION_SECRET: must be at least 32 characters when ADMIN_WALLETS is set");
    }
  }
  if (payoutKey && payoutKeyPath) {
    problems.push("Set only one of LAST60_PAYOUT_WALLET_PRIVATE_KEY / LAST60_PAYOUT_WALLET_KEYPAIR_PATH");
  }
  if (payoutWalletAddress && raw.FORGE_PLATFORM_LP_BENEFICIARY && payoutWalletAddress === raw.FORGE_PLATFORM_LP_BENEFICIARY) {
    problems.push("LAST60_PAYOUT_WALLET_ADDRESS: must be a dedicated wallet, not FORGE_PLATFORM_LP_BENEFICIARY");
  }
  // Startup validation of the signing key (rewards worker only — the only process that may hold it):
  // missing address, malformed key or a key deriving another address is fatal. Messages are sanitized.
  if (role === "rewards" && (payoutKey || payoutKeyPath)) {
    const st = PayoutSigner.load({ privateKey: payoutKey, keypairPath: payoutKeyPath }, payoutWalletAddress ?? null).status;
    if (st.code !== "ok") problems.push(`LAST60_PAYOUT_WALLET_PRIVATE_KEY: ${st.message}`);
  }
  if (raw.LAST60_CUSTODY_ENABLED === true && !payoutWalletAddress) problems.push("LAST60_CUSTODY_ENABLED: requires LAST60_PAYOUT_WALLET_ADDRESS (custody transfers must reach the dedicated payout wallet)");

  const expectedInt = (name: string, v: string | undefined, max: number): number | null => {
    if (v === undefined || v.trim() === "") return null;
    if (!/^\d+$/.test(v.trim()) || Number(v) > max) {
      problems.push(`${name}: must be an integer between 0 and ${max}`);
      return null;
    }
    return Number(v);
  };
  const expectedPubkey = (name: string, v: string | undefined): string | null => {
    if (v === undefined || v.trim() === "") return null;
    try {
      return new PublicKey(v.trim()).toBase58();
    } catch {
      problems.push(`${name}: must be a base58 public key`);
      return null;
    }
  };
  const expected: ExpectedAllocation = {
    dbcCreatorTradingFeePercentage: expectedInt("EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE", raw.EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE, 100),
    dbcCreatorLpPercentage: expectedInt("EXPECTED_DBC_CREATOR_LP_PERCENTAGE", raw.EXPECTED_DBC_CREATOR_LP_PERCENTAGE, 100),
    launchlabCreatorFeeRate: expectedInt("EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE", raw.EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE, 1_000_000),
    launchlabCreatorLpScale: expectedInt("EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE", raw.EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE, 1_000_000),
    launchlabPlatformConfig: expectedPubkey("EXPECTED_LAUNCHLAB_PLATFORM_CONFIG", raw.EXPECTED_LAUNCHLAB_PLATFORM_CONFIG),
    cpmmCreatorFeeRate: expectedInt("EXPECTED_CPMM_CREATOR_FEE_RATE", raw.EXPECTED_CPMM_CREATOR_FEE_RATE, 1_000_000),
  };
  const share = (name: string, v: string): number => {
    try {
      return percentToBps(v);
    } catch (e) {
      problems.push(`${name}: ${(e as Error).message}`);
      return 0;
    }
  };
  let activationSlot: number | null = null;
  if (raw.REWARD_FUNDING_POLICY_ACTIVATION_SLOT !== undefined && !["", "auto"].includes(raw.REWARD_FUNDING_POLICY_ACTIVATION_SLOT.trim().toLowerCase())) {
    if (!/^\d+$/.test(raw.REWARD_FUNDING_POLICY_ACTIVATION_SLOT.trim())) problems.push("REWARD_FUNDING_POLICY_ACTIVATION_SLOT: must be a non-negative integer slot");
    else activationSlot = Number(raw.REWARD_FUNDING_POLICY_ACTIVATION_SLOT.trim());
  }
  if (raw.REWARD_FUNDING_POLICY === "forge_phase_aware_v1") problems.push("REWARD_FUNDING_POLICY: forge_phase_aware_v1 is retired (it treated the creator's 50 % LP allocation as Forge-funded, allowed other percentages and payable exclusive_window links); use forge_phase_aware_v2 — see docs/REWARD_FUNDING.md");
  const phaseAware = raw.REWARD_FUNDING_POLICY === "forge_phase_aware_v2";
  // No slot under v2: pinned at the first boot and persisted (resolveFundingActivation), i.e. "at the
  // deployment that enables it" — never a historical slot, so legacy-distributed fees are never re-funded.
  const activationAuto = phaseAware && activationSlot === null;
  // Forgepad's platform Fee Key owner is a known mainnet fact; it is still verified against the
  // PlatformConfig `platform_nft_wallet` on chain (a mismatch leaves Forge LP claims unresolved).
  const forgeBeneficiary = raw.FORGE_PLATFORM_LP_BENEFICIARY ?? (phaseAware && raw.SOLANA_CLUSTER === "mainnet-beta" ? FORGEPAD_PLATFORM_NFT_WALLET : undefined);
  if (payoutWalletAddress && !raw.FORGE_PLATFORM_LP_BENEFICIARY && forgeBeneficiary && payoutWalletAddress === forgeBeneficiary) problems.push("LAST60_PAYOUT_WALLET_ADDRESS: must be a dedicated wallet, not Forge's platform wallet");
  const custodyEnabled = raw.LAST60_CUSTODY_ENABLED ?? (phaseAware && !!payoutWalletAddress);
  // Launch creator wallet automation.
  if (creatorKey && creatorKeyPath) problems.push("Set only one of LAST60_CREATOR_WALLET_PRIVATE_KEY / LAST60_CREATOR_WALLET_KEYPAIR_PATH");
  // Default: on when a creator wallet exists AND its prerequisites hold (so generating a wallet in the admin
  // console can never stop a process from starting). Explicitly enabled: every unmet prerequisite is an error.
  const creatorAutomation = raw.LAST60_CREATOR_AUTOMATION_ENABLED ?? (creatorKeySet && phaseAware && raw.LAST60_CUSTODY_ENABLED !== false && raw.FEE_BENEFICIARY_ROLE === "creator");
  if (creatorAutomation && role === "rewards") {
    if (!creatorKeySet) problems.push("LAST60_CREATOR_AUTOMATION_ENABLED: requires a creator wallet (generate one from the admin console, or set LAST60_CREATOR_WALLET_KEYPAIR_PATH / LAST60_CREATOR_WALLET_PRIVATE_KEY in the rewards worker)");
    if (!phaseAware) problems.push("LAST60_CREATOR_AUTOMATION_ENABLED: requires REWARD_FUNDING_POLICY=forge_phase_aware_v2 (the 75 % / custody flows only fund rounds under the approved model)");
    if (raw.LAST60_CUSTODY_ENABLED === false) problems.push("LAST60_CREATOR_AUTOMATION_ENABLED: requires the custody workflow (unset LAST60_CUSTODY_ENABLED or set it to true)");
    if (raw.FEE_BENEFICIARY_ROLE !== "creator") problems.push('LAST60_CREATOR_AUTOMATION_ENABLED: requires FEE_BENEFICIARY_ROLE=creator');
  }
  const creatorAddress = raw.LAST60_CREATOR_WALLET_ADDRESS ?? (creatorFromVault ? vaultCreator : null);
  for (const [name, a] of [["LAST60_PAYOUT_WALLET_ADDRESS", payoutWalletAddress], ["FORGE_PLATFORM_LP_BENEFICIARY", forgeBeneficiary]] as const) {
    if (creatorAddress && a && creatorAddress === a) problems.push(`LAST60_CREATOR_WALLET_ADDRESS: must not be ${name} (the creator wallet sends TO the payout wallet)`);
  }
  // Startup validation of the creator key (rewards worker only). Messages never quote the key.
  if (role === "rewards" && envCreatorKeySet && !(creatorKey && creatorKeyPath)) {
    const keyVar = creatorKeyPath ? "LAST60_CREATOR_WALLET_KEYPAIR_PATH" : "LAST60_CREATOR_WALLET_PRIVATE_KEY";
    try {
      const kp = loadKeypair({ privateKey: creatorKey, keypairPath: creatorKeyPath }, null, "creator wallet");
      const derived = kp.publicKey.toBase58();
      if (creatorAddress && derived !== creatorAddress) problems.push(`${keyVar}: the key derives a different address than LAST60_CREATOR_WALLET_ADDRESS`);
      if (payoutWalletAddress && derived === payoutWalletAddress) problems.push(`${keyVar}: is the payout wallet key; the creator wallet must be the launch creator's own wallet`);
    } catch (e) {
      const m = String((e as Error)?.message ?? "");
      problems.push(`${keyVar}: ${/readable by group|ENOENT|EACCES/.test(m) ? (m.includes("readable by group") ? "keypair file is group/other readable (chmod 600)" : "keypair file cannot be read") : "not a valid 64-byte secret key (base58 or JSON array)"}`);
    }
  }
  // Under the approved policy the dedicated payout wallet is itself a funding destination (a bonding-curve
  // contribution sent straight to it needs no custody transfer); it is added once, never duplicated.
  const fundingDestinations = [...new Set([...raw.LAST60_FUNDING_DESTINATIONS, ...(phaseAware && payoutWalletAddress ? [payoutWalletAddress] : [])])];
  // Required where funding is recorded / consumed (indexer, rewards); the API and CLI only report.
  const fundingRole = role === "indexer" || role === "rewards" || role === "test";
  // forge_phase_aware_v2 with no destination yet (no payout wallet generated): nothing can fund a round
  // until there is one; reported at boot, not fatal (the payout wallet is generated from the admin console).
  if (phaseAware && fundingRole && !forgeBeneficiary) problems.push("FORGE_PLATFORM_LP_BENEFICIARY: is required with REWARD_FUNDING_POLICY=forge_phase_aware_v2 outside mainnet-beta (the creator's 50 % LP allocation is only verifiable against Forge's platform Fee Key owner; on mainnet-beta it defaults to Forgepad's)");
  if (forgeBeneficiary && raw.LAST60_FUNDING_DESTINATIONS.includes(forgeBeneficiary)) problems.push("LAST60_FUNDING_DESTINATIONS: must not include FORGE_PLATFORM_LP_BENEFICIARY (a self-transfer is not a contribution)");
  const bondingBps = raw.BONDING_CREATOR_FEE_LAST60_PERCENTAGE.trim() === "0" ? 0 : share("BONDING_CREATOR_FEE_LAST60_PERCENTAGE", raw.BONDING_CREATOR_FEE_LAST60_PERCENTAGE);
  const lpBps = raw.FORGE_PLATFORM_LP_LAST60_PERCENTAGE.trim() === "0" ? 0 : share("FORGE_PLATFORM_LP_LAST60_PERCENTAGE", raw.FORGE_PLATFORM_LP_LAST60_PERCENTAGE);
  // The approved economic model is fixed; the variables exist only to make the values explicit.
  if (bondingBps !== APPROVED_SHARES.bondingCreatorFeeLast60Bps) problems.push(`BONDING_CREATOR_FEE_LAST60_PERCENTAGE: the approved model is 75 (of each collected bonding-curve creator fee); got ${raw.BONDING_CREATOR_FEE_LAST60_PERCENTAGE}`);
  if (lpBps !== APPROVED_SHARES.forgeLpLast60Bps) problems.push(`FORGE_PLATFORM_LP_LAST60_PERCENTAGE: the approved model is 50 (the creator's allocation of each claimed Forge LP fee); got ${raw.FORGE_PLATFORM_LP_LAST60_PERCENTAGE}`);
  let policy: FundingPolicy | null = null;
  try {
    policy = makeFundingPolicy({ version: raw.REWARD_FUNDING_POLICY, activationSlot: phaseAware ? (activationSlot ?? PENDING_ACTIVATION_SLOT) : null, bondingCreatorFeeLast60Bps: bondingBps, forgeLpLast60Bps: lpBps });
  } catch (e) {
    if (!problems.length) problems.push(`REWARD_FUNDING_POLICY: ${(e as Error).message}`);
  }
  if (role === "api" && raw.NODE_ENV === "production") {
    // Never fall back to request headers for the sign-in domain, and never reflect arbitrary origins.
    if (raw.ADMIN_WALLETS.length > 0 && !raw.PUBLIC_SITE_URL) problems.push("PUBLIC_SITE_URL: is required in production when ADMIN_WALLETS is set (admin sign-in messages are bound to it)");
    if (raw.CORS_ORIGINS.length === 0) problems.push("CORS_ORIGINS: is required in production (cross-origin requests are otherwise refused)");
  }
  if (raw.PUBLIC_SITE_URL) {
    try {
      const u = new URL(raw.PUBLIC_SITE_URL);
      if (raw.NODE_ENV === "production" && u.protocol !== "https:") problems.push("PUBLIC_SITE_URL: must be https in production");
    } catch {
      problems.push("PUBLIC_SITE_URL: must be an absolute URL");
    }
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    nodeEnv: raw.NODE_ENV,
    logLevel: raw.LOG_LEVEL,
    instanceId: raw.INSTANCE_ID ?? `${role}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    solana: {
      cluster: raw.SOLANA_CLUSTER,
      rpcUrls: [rpcUrl!, ...raw.SOLANA_RPC_FALLBACK_URLS],
      wsUrl,
      maxTxVersion: raw.SOLANA_MAX_TX_VERSION,
      timeoutMs: raw.SOLANA_RPC_TIMEOUT_MS,
      maxRps: raw.SOLANA_RPC_MAX_RPS,
    },
    provider: {
      id: raw.LAUNCH_PROVIDER,
      tokenMint: raw.TOKEN_MINT ?? null,
      poolAddress: raw.POOL_ADDRESS ?? derivedPool,
      poolAddressSource: raw.POOL_ADDRESS ? "configured" : derivedPool ? "derived" : null,
      feeBeneficiaryRole: raw.FEE_BENEFICIARY_ROLE,
      expected,
    },
    rewards: {
      buyerCount: raw.BUYER_COUNT,
      minBuyQuote,
      minBuySolInput: raw.MIN_BUY_SOL,
      rewardBps,
      skippedRoundPolicy: raw.SKIPPED_ROUND_POLICY,
      minPayoutLamports: raw.MIN_PAYOUT_LAMPORTS,
      excludedWallets: raw.EXCLUDED_WALLETS,
    },
    schedule: {
      roundDurationMs: raw.ROUND_DURATION_SECONDS * 1000,
      windowStartMs: raw.RANDOM_WINDOW_START_SECONDS * 1000,
      windowDurationMs: raw.RANDOM_WINDOW_DURATION_SECONDS * 1000,
      anchorEpochMs: raw.ROUND_ANCHOR_EPOCH_SECONDS * 1000,
      genesisAt,
      lateGraceMs: raw.LATE_EXECUTION_GRACE_SECONDS * 1000,
      snapshotSettleMs: raw.SNAPSHOT_SETTLE_MS,
      encryptionKey,
    },
    payout: {
      asset: raw.PAYOUT_ASSET.toUpperCase() === "SOL" ? "SOL" : payoutAssetMint,
      assetMint: payoutAssetMint,
      mode: raw.PAYOUT_MODE,
      allowMainnet: raw.ALLOW_MAINNET_PAYOUTS,
      walletPublicKey: payoutWalletAddress ?? null,
      commitment: raw.PAYOUT_COMMITMENT,
      priorityFeeMicroLamports: raw.PAYOUT_PRIORITY_FEE_MICROLAMPORTS,
      computeUnitLimit: raw.PAYOUT_COMPUTE_UNIT_LIMIT,
      maxAttempts: raw.PAYOUT_MAX_ATTEMPTS,
      minReserveLamports: raw.PAYOUT_WALLET_MIN_RESERVE_LAMPORTS,
      concurrency: raw.PAYOUT_CONCURRENCY,
      memo: raw.PAYOUT_MEMO,
    },
    feeCollection: { mode: raw.FEE_COLLECTION_MODE ?? (creatorAutomation || (creatorAddress && phaseAware) ? "auto_claim" : "manual"), minClaimLamports: raw.FEE_CLAIM_MIN_LAMPORTS },
    creatorWallet: {
      address: creatorAddress,
      keyConfigured: creatorKeySet,
      automationEnabled: creatorAutomation && creatorKeySet && phaseAware,
      intervalMs: raw.LAST60_CREATOR_AUTOMATION_INTERVAL_SECONDS * 1000,
      minTransferLamports: raw.LAST60_CREATOR_MIN_TRANSFER_LAMPORTS,
      feeReserveLamports: raw.LAST60_CREATOR_FEE_RESERVE_LAMPORTS,
    },
    wallets: {
      payout: { address: payoutWalletAddress ?? null, source: envPayoutAddress || payoutKey || payoutKeyPath ? "env" : payoutFromVault ? "vault" : null },
      creator: { address: creatorAddress, source: raw.LAST60_CREATOR_WALLET_ADDRESS || envCreatorKeySet ? "env" : creatorFromVault ? "vault" : null },
      vaultKeyPath: raw.LAST60_WALLET_VAULT_KEY_PATH?.trim() || joinPath(homedir(), ".last60", "wallet-vault.key"),
    },
    mongo: { uri: raw.MONGODB_URI, dbName: raw.MONGODB_DB_NAME },
    indexer: {
      pollIntervalMs: raw.INDEXER_POLL_INTERVAL_MS,
      useWebsocket: raw.INDEXER_USE_WEBSOCKET,
      backfill: raw.INDEXER_BACKFILL,
      backfillMaxSignatures: raw.INDEXER_BACKFILL_MAX_SIGNATURES,
      finalityCheckMs: raw.INDEXER_FINALITY_CHECK_MS,
      dropAfterSeconds: raw.INDEXER_DROP_AFTER_SECONDS,
      fetchConcurrency: raw.INDEXER_FETCH_CONCURRENCY,
    },
    api: {
      host: raw.API_HOST,
      port: raw.API_PORT,
      corsOrigins: raw.CORS_ORIGINS,
      publicSiteUrl: raw.PUBLIC_SITE_URL ?? null,
      adminWallets: raw.ADMIN_WALLETS,
      adminSessionSecret: raw.ADMIN_SESSION_SECRET ?? null,
      adminSessionTtlSeconds: raw.ADMIN_SESSION_TTL_SECONDS,
      streamSnapshotIntervalMs: raw.STREAM_SNAPSHOT_INTERVAL_MS,
      trustProxyHops: raw.API_TRUST_PROXY_HOPS,
    },
    reconciliation: {
      intervalMs: raw.RECONCILIATION_INTERVAL_SECONDS * 1000,
      haltOnOverAttribution: raw.RECONCILIATION_HALT_ON_OVER_ATTRIBUTION,
      toleranceLamports: raw.RECONCILIATION_TOLERANCE_LAMPORTS,
    },
    revenue: {
      policy: policy!,
      fundingDestinations,
      forgePlatformLpBeneficiary: forgeBeneficiary ?? null,
      correlationMode: raw.FUNDING_CORRELATION_MODE,
      custody: { enabled: custodyEnabled, payoutWallet: payoutWalletAddress ?? null, requestTtlMs: raw.LAST60_CUSTODY_REQUEST_TTL_HOURS * 3_600_000 },
      recoveryEnabled: raw.LAST60_ATTRIBUTION_RECOVERY_ENABLED,
      activation: { source: !phaseAware ? "not_applicable" : activationAuto ? "auto" : "configured", pending: activationAuto },
    },
    terminal: { retentionDays: raw.TERMINAL_RETENTION_DAYS },
    public: { appName: raw.NEXT_PUBLIC_APP_NAME, explorer: raw.NEXT_PUBLIC_SOLANA_EXPLORER },
    secrets: {
      payoutWalletPrivateKey: payoutKey,
      payoutWalletKeypairPath: payoutKeyPath,
      feeClaimAuthorityPrivateKey: raw.FEE_CLAIM_AUTHORITY_PRIVATE_KEY,
      feeClaimAuthorityKeypairPath: raw.FEE_CLAIM_AUTHORITY_KEYPAIR_PATH,
      creatorWalletPrivateKey: creatorKey,
      creatorWalletKeypairPath: creatorKeyPath,
      walletVaultKey: raw.LAST60_WALLET_VAULT_KEY?.trim() || undefined,
    },
  };
}

/** Redacted view safe for logs and the admin UI. */
export function redactConfig(cfg: AppConfig) {
  const maskUrl = (u: string) => {
    try {
      const x = new URL(u);
      for (const k of [...x.searchParams.keys()]) if (/key|token|secret/i.test(k)) x.searchParams.set(k, "***");
      if (x.password) x.password = "***";
      return x.toString();
    } catch {
      return "***";
    }
  };
  const { secrets, ...rest } = cfg;
  return jsonSafe({
    ...rest,
    solana: { ...cfg.solana, rpcUrls: cfg.solana.rpcUrls.map(maskUrl), wsUrl: cfg.solana.wsUrl ? maskUrl(cfg.solana.wsUrl) : null },
    schedule: { ...cfg.schedule, encryptionKey: cfg.schedule.encryptionKey ? "[set]" : null },
    mongo: { uri: maskUrl(cfg.mongo.uri), dbName: cfg.mongo.dbName },
    api: { ...cfg.api, adminSessionSecret: cfg.api.adminSessionSecret ? "[set]" : null },
    secrets: {
      payoutWalletKey: secrets.payoutWalletPrivateKey ? "[env]" : secrets.payoutWalletKeypairPath ? "[file]" : null,
      feeClaimKey: secrets.feeClaimAuthorityPrivateKey ? "[env]" : secrets.feeClaimAuthorityKeypairPath ? "[file]" : null,
      creatorWalletKey: secrets.creatorWalletPrivateKey ? "[env]" : secrets.creatorWalletKeypairPath ? "[file]" : null,
      walletVaultKey: secrets.walletVaultKey ? "[env]" : "[file]",
    },
  });
}
