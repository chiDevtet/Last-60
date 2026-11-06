/**
 * Raydium LaunchLab adapter.
 *
 * Verified against the official IDL (raydium-io/raydium-idl), the Raydium SDK v2 layouts and
 * mainnet transactions:
 *   - buy_exact_in / buy_exact_out / sell_exact_in / sell_exact_out emit TradeEvent via self-CPI.
 *   - TradeEvent carries explicit protocol_fee, platform_fee, creator_fee and share_fee, always in
 *     the quote mint. On buys `amount_in` is the gross quote spent (reserve delta = amount_in − fees).
 *   - Since the fee-vault upgrade, creator_fee is transferred on every trade into the PDA
 *     [creator, quote_mint] and platform_fee into [platform_config, quote_mint] (confirmed with
 *     token balance deltas equal to the event amounts).
 *   - The creator vault is shared by every pool that creator launched with that quote mint, and the
 *     platform vault by every pool on the platform — per-event attribution is authoritative.
 *   - claim_creator_fee / claim_platform_fee_from_vault emit no event; the claimed amount is the sum of
 *     the token transfers OUT OF the fee vault executed by that claim instruction (instruction-scoped,
 *     so a trade or a second claim in the same transaction is never mixed in).
 *   - `creator_fee_rate` (PlatformConfig, millionths) is a FEE RATE on the trade value that is added
 *     to the total fee rate — e.g. 5000 = 0.5% of the trade (the program's MAX_CREATOR_FEE_RATE) —
 *     not a percentage of the other fees. The program charges total_fee = ceil(amount × Σrates / 1e6)
 *     and splits it pro rata to the rates (protocol takes the rounding remainder); TradeEvent.creator_fee
 *     is that exact split — see `launchLabFeeSplit`, reproduced bit-exactly on a mainnet trade.
 *   - At migration the LP is distributed by `platform_scale` / `creator_scale` / `burn_scale`
 *     (millionths); the platform's and creator's parts are locked in the Raydium LP-lock program and
 *     their LP fees are paid to the holder of the corresponding fee-key NFT.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Idl } from "@coral-xyz/anchor";
import { WSOL_MINT } from "@last60/shared";
import idlJson from "./idl/raydium_launchpad.json";
import { AnchorEventDecoder, enumVariant, instructionDiscriminator, toAddr, toBig } from "../../chain/anchorEvents";
import { subtreeTransfers, type NormalizedTx } from "../../chain/tx";
import type { ExpectedAllocation } from "../../config/env";
import { basisPayable, EXCLUSION, makeBasis, type AllocationBasis, type AllocationVerification, type NormalizedAttribution } from "../../accounting/attribution";
import { verifyDeclared } from "../meteora/MeteoraDBCProvider";
import type { ChainRpc } from "../../chain/rpc";
import { readMint } from "../mint";
import {
  ProviderValidationError,
  resolveTrader,
  type ClaimPlan,
  type FeeBeneficiaryRole,
  type FeeSourceState,
  type LaunchProvider,
  type NormalizedSwap,
  type ParsedTransaction,
  type PoolInfo,
  type PoolStatus,
} from "../LaunchProvider";

export const LAUNCHLAB_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const PROGRAM = new PublicKey(LAUNCHLAB_PROGRAM_ID);
const idl = idlJson as unknown as Idl;

const TRADE_IX = new Map(
  (["buy_exact_in", "buy_exact_out", "sell_exact_in", "sell_exact_out"] as const).map((n) => [instructionDiscriminator(n).toString("hex"), n]),
);
const CLAIM_CREATOR_IX = instructionDiscriminator("claim_creator_fee");
const CLAIM_PLATFORM_VAULT_IX = instructionDiscriminator("claim_platform_fee_from_vault");
export const POOL_STATE_DISC = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
export const PLATFORM_CONFIG_DISC = Buffer.from([160, 78, 128, 0, 248, 83, 230, 160]);

/** LaunchLab fee-rate denominator (GlobalConfig / PlatformConfig rates are millionths of trade value). */
export const LAUNCHLAB_RATE_DENOMINATOR = 1_000_000n;

/**
 * The LaunchLab program's fee split, as published in the Raydium SDK (curve.ts `calculateFee` +
 * `splitFee`) and reproduced exactly by mainnet TradeEvents (test/attribution.test.ts):
 *
 *   Σ           = protocol_rate (GlobalConfig.trade_fee_rate) + platform_rate (PlatformConfig.fee_rate)
 *                 + creator_rate (PlatformConfig.creator_fee_rate) + share_rate (instruction argument)
 *   total_fee   = ceil(amount × Σ / 1 000 000)          (buy: quote in; sell: gross quote out)
 *   platform_fee = floor(total_fee × platform_rate / Σ)
 *   share_fee    = floor(total_fee × share_rate / Σ)
 *   creator_fee  = floor(total_fee × creator_rate / Σ)
 *   protocol_fee = total_fee − platform − share − creator   (receives the rounding remainder)
 *
 * So `creator_fee_rate = 5000` is ≈ 0.5% OF TRADE VALUE (the program maximum, MAX_CREATOR_FEE_RATE),
 * not 0.5% of the other fees. Accounting never uses this function: the per-trade TradeEvent.creator_fee
 * (cross-checked against the creator-vault transfer) is the source of truth. It exists to verify
 * the semantics.
 */
export function launchLabFeeSplit(amount: bigint, rates: { protocol: bigint; platform: bigint; creator: bigint; share?: bigint }) {
  const share = rates.share ?? 0n;
  const sum = rates.protocol + rates.platform + rates.creator + share;
  if (sum > LAUNCHLAB_RATE_DENOMINATOR) throw new Error("total fee rate exceeds 1 000 000");
  const total = (amount * sum + LAUNCHLAB_RATE_DENOMINATOR - 1n) / LAUNCHLAB_RATE_DENOMINATOR;
  const part = (r: bigint) => (sum === 0n ? 0n : (total * r) / sum);
  const platformFee = part(rates.platform);
  const shareFee = part(share);
  const creatorFee = part(rates.creator);
  return { total, platformFee, shareFee, creatorFee, protocolFee: total - platformFee - shareFee - creatorFee };
}

export function creatorFeeVault(creator: PublicKey, quoteMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([creator.toBuffer(), quoteMint.toBuffer()], PROGRAM)[0];
}
export function platformFeeVault(platformConfig: PublicKey, quoteMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([platformConfig.toBuffer(), quoteMint.toBuffer()], PROGRAM)[0];
}
export const CREATOR_FEE_VAULT_AUTH = PublicKey.findProgramAddressSync([Buffer.from("creator_fee_vault_auth_seed")], PROGRAM)[0];
export const PLATFORM_FEE_VAULT_AUTH = PublicKey.findProgramAddressSync([Buffer.from("platform_fee_vault_auth_seed")], PROGRAM)[0];

const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58();
const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);

export interface LaunchLabPoolState {
  status: number; // 0 Fund, 1 Migrate, 2 Trade
  baseDecimals: number;
  quoteDecimals: number;
  platformFeeAccrued: bigint; // legacy pre-vault accrual
  globalConfig: string;
  platformConfig: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  creator: string;
}

/** Byte offsets follow the Raydium SDK `LaunchpadPool` layout (borsh, packed). */
export function decodeLaunchLabPool(data: Buffer): LaunchLabPoolState {
  if (!data.subarray(0, 8).equals(POOL_STATE_DISC)) throw new ProviderValidationError("account is not a LaunchLab PoolState");
  if (data.length < 365) throw new ProviderValidationError("PoolState data too short");
  return {
    status: data[17]!,
    baseDecimals: data[18]!,
    quoteDecimals: data[19]!,
    platformFeeAccrued: u64(data, 85),
    globalConfig: pk(data, 141),
    platformConfig: pk(data, 173),
    baseMint: pk(data, 205),
    quoteMint: pk(data, 237),
    baseVault: pk(data, 269),
    quoteVault: pk(data, 301),
    creator: pk(data, 333),
  };
}

export interface LaunchLabPlatformConfig {
  platformFeeWallet: string;
  feeRate: bigint;
  creatorFeeRate: bigint;
  /** Migrated LP distribution, millionths (absent on hand-built test configs). */
  platformLockNftWallet?: string;
  platformScale?: bigint;
  creatorScale?: bigint;
  burnScale?: bigint;
  cpConfig?: string;
  /** When set, CPMM pools created at migration record this wallet as pool_creator instead of the token creator. */
  platformCpCreator?: string | null;
  /** Remaining fields of the 944-byte layout (present when decoded from a real account). */
  epoch?: bigint;
  name?: string;
  web?: string;
  img?: string;
  transferFeeExtensionAuth?: string;
  platformVestingWallet?: string;
  platformVestingScale?: bigint;
  restrictGlobalConfig?: number;
  restrictCurveParam?: number;
  curveRuleManager?: string | null;
}

/** Fixed PlatformConfig account size (unchanged by the 2026-08-17 and 2026-08-31 layout updates). */
export const PLATFORM_CONFIG_SIZE = 944;
/** PlatformConfig.creator_fee_rate ceiling (raydium-docs-v1 products/launchlab/platform-config: MAX_CREATOR_FEE_RATE). */
export const LAUNCHLAB_MAX_CREATOR_FEE_RATE = 5_000n;
/** PlatformConfig.fee_rate ceiling since the 2026-08-26 upgrade (previously 10 000). */
export const LAUNCHLAB_MAX_PLATFORM_FEE_RATE = 50_000n;
/** platform_scale + creator_scale + burn_scale must equal this. */
export const LAUNCHLAB_SCALE_DENOMINATOR = 1_000_000n;
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

const cstr = (b: Buffer, o: number, n: number) => {
  const raw = b.subarray(o, o + n);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? n : end).toString("utf8");
};

/**
 * Byte offsets follow the Raydium SDK `PlatformConfig` layout (0.2.82-alpha) and the deployed
 * program's 944-byte account (raydium-docs-v1 products/launchlab/platform-config):
 *   0 disc · 8 epoch · 16 platform_fee_wallet · 48 platform_nft_wallet · 80 platform_scale ·
 *   88 creator_scale · 96 burn_scale · 104 fee_rate · 112 name[64] · 176 web[256] · 432 img[256] ·
 *   688 cpswap_config · 720 creator_fee_rate · 728 transfer_fee_extension_auth ·
 *   760 platform_vesting_wallet · 792 platform_vesting_scale · 800 platform_cp_creator ·
 *   832 restrict_global_config (u8) · 833 restrict_curve_param (u8) · 834 curve_rule_manager ·
 *   866..944 padding.
 * The bundled IDL (v0.2.0) predates 2026-08-31 and still describes bytes 832..944 as
 * 108 bytes of padding + a `curve_params` vec length; for an account whose bytes 832..944 are all
 * zero the two readings agree (see `validateLaunchLabPlatformConfig`).
 * Verified on mainnet accounts:
 *   5zZFa8Ki… Forgepad (test/fixtures/mainnet/forgepad-platform-config.json): fee_rate 10000,
 *     creator_fee_rate 5000, platform_scale 500 000, creator_scale 500 000, burn_scale 0;
 *   EB2LqTh8… (fixtures/mainnet/migration-launchlab-cpmm.json): fee_rate 7500, creator_fee_rate 5000,
 *     platform_scale 1 000 000, creator_scale 0;
 *   4Bu96XjU… (fixtures/mainnet/launchlab-accounts.json): fee_rate 7500, creator_fee_rate 500,
 *     platform_scale 0, creator_scale 100 000, burn_scale 900 000.
 * Rates differ per platform — they are always read from the pool's own PlatformConfig, never assumed.
 */
export function decodeLaunchLabPlatformConfig(data: Buffer): LaunchLabPlatformConfig {
  if (!data.subarray(0, 8).equals(PLATFORM_CONFIG_DISC)) throw new ProviderValidationError("account is not a LaunchLab PlatformConfig");
  if (data.length < 832) throw new ProviderValidationError(`PlatformConfig data too short (${data.length} bytes)`);
  const cpCreator = pk(data, 800);
  const full = data.length >= 866;
  const manager = full ? pk(data, 834) : null;
  return {
    epoch: u64(data, 8),
    platformFeeWallet: pk(data, 16),
    platformLockNftWallet: pk(data, 48),
    platformScale: u64(data, 80),
    creatorScale: u64(data, 88),
    burnScale: u64(data, 96),
    feeRate: u64(data, 104),
    name: cstr(data, 112, 64),
    web: cstr(data, 176, 256),
    img: cstr(data, 432, 256),
    cpConfig: pk(data, 688),
    creatorFeeRate: u64(data, 720),
    transferFeeExtensionAuth: pk(data, 728),
    platformVestingWallet: pk(data, 760),
    platformVestingScale: u64(data, 792),
    platformCpCreator: cpCreator !== DEFAULT_PUBKEY ? cpCreator : null,
    ...(full ? { restrictGlobalConfig: data[832]!, restrictCurveParam: data[833]!, curveRuleManager: manager !== DEFAULT_PUBKEY ? manager : null } : {}),
  };
}

/**
 * Strict, read-only validation of a raw PlatformConfig account for accounting purposes. Returns the
 * decoded config and every reason it cannot be relied on (empty = decoded unambiguously):
 * owner, discriminator, exact size, scale sum, rate caps, flag ranges, and that the bytes the
 * deployed layout treats as padding are zero (otherwise the account carries fields this code does
 * not know — an unsupported layout, never guessed).
 */
export function validateLaunchLabPlatformConfig(account: { owner: string; data: Buffer } | null): { config: LaunchLabPlatformConfig | null; problems: string[]; code: "ok" | "missing" | "wrong_owner" | "unsupported_layout" | "invalid_values" } {
  if (!account) return { config: null, problems: ["account does not exist on this cluster"], code: "missing" };
  if (account.owner !== LAUNCHLAB_PROGRAM_ID) return { config: null, problems: [`account is owned by ${account.owner}, not Raydium LaunchLab ${LAUNCHLAB_PROGRAM_ID}`], code: "wrong_owner" };
  const d = account.data;
  if (!d.subarray(0, 8).equals(PLATFORM_CONFIG_DISC)) return { config: null, problems: [`discriminator ${[...d.subarray(0, 8)].join(",")} is not PlatformConfig`], code: "unsupported_layout" };
  if (d.length !== PLATFORM_CONFIG_SIZE) return { config: null, problems: [`account is ${d.length} bytes; the supported PlatformConfig layout is exactly ${PLATFORM_CONFIG_SIZE}`], code: "unsupported_layout" };
  const layout: string[] = [];
  if (d.subarray(866, PLATFORM_CONFIG_SIZE).some((b) => b !== 0)) layout.push("bytes 866..944 (padding in the deployed layout; the legacy IDL's curve_params vec length at 940..944) are not zero — the account carries data this decoder does not understand");
  if (layout.length) return { config: null, problems: layout, code: "unsupported_layout" };
  const c = decodeLaunchLabPlatformConfig(d);
  const values: string[] = [];
  const sum = c.platformScale! + c.creatorScale! + c.burnScale!;
  if (sum !== LAUNCHLAB_SCALE_DENOMINATOR) values.push(`platform_scale + creator_scale + burn_scale = ${sum}, the program requires ${LAUNCHLAB_SCALE_DENOMINATOR}`);
  if (c.creatorFeeRate > LAUNCHLAB_MAX_CREATOR_FEE_RATE) values.push(`creator_fee_rate ${c.creatorFeeRate} exceeds MAX_CREATOR_FEE_RATE ${LAUNCHLAB_MAX_CREATOR_FEE_RATE}`);
  if (c.feeRate > LAUNCHLAB_MAX_PLATFORM_FEE_RATE) values.push(`fee_rate ${c.feeRate} exceeds the platform fee cap ${LAUNCHLAB_MAX_PLATFORM_FEE_RATE}`);
  if (c.platformVestingScale! > LAUNCHLAB_SCALE_DENOMINATOR) values.push(`platform_vesting_scale ${c.platformVestingScale} exceeds ${LAUNCHLAB_SCALE_DENOMINATOR}`);
  if (c.restrictGlobalConfig! > 1 || c.restrictCurveParam! > 1) values.push(`restrict flags must be 0 or 1 (restrict_global_config ${c.restrictGlobalConfig}, restrict_curve_param ${c.restrictCurveParam})`);
  return { config: c, problems: values, code: values.length ? "invalid_values" : "ok" };
}

/**
 * Verification of the LaunchLab creator bonding-curve basis against the operator declaration:
 * the pool's PlatformConfig address AND its creator_fee_rate must both be declared and equal.
 * Either one missing → not_declared (never distributable); either one different → mismatch.
 */
export function verifyLaunchLabCreatorBasis(poolPlatformConfig: string, creatorFeeRate: bigint, expected: Pick<ExpectedAllocation, "launchlabPlatformConfig" | "launchlabCreatorFeeRate"> | undefined): { verification: AllocationVerification; problems: string[] } {
  const problems: string[] = [];
  const declaredPc = expected?.launchlabPlatformConfig ?? null;
  const rate = verifyDeclared("creator_fee_rate", Number(creatorFeeRate), expected?.launchlabCreatorFeeRate);
  if (declaredPc !== null && declaredPc !== poolPlatformConfig) problems.push(`pool is bound to PlatformConfig ${poolPlatformConfig} but ${declaredPc} was declared`);
  problems.push(...rate.problems);
  if (problems.length) return { verification: "mismatch", problems };
  if (declaredPc === null || rate.verification === "not_declared") return { verification: "not_declared", problems: [] };
  return { verification: rate.verification, problems: [] };
}

export class RaydiumLaunchLabProvider implements LaunchProvider {
  readonly id = "raydium_launchlab" as const;
  readonly programId = LAUNCHLAB_PROGRAM_ID;
  private readonly events = new AnchorEventDecoder(LAUNCHLAB_PROGRAM_ID, idl);
  private cached: PoolInfo | null = null;
  private platform: LaunchLabPlatformConfig | null = null;
  private poolState: LaunchLabPoolState | null = null;
  /** Result of checking the declared creator LP scale (applies to migrated LP fees). */
  lpCheck: { verification: AllocationVerification; problems: string[] } = { verification: "not_declared", problems: [] };

  constructor(
    private readonly rpc: ChainRpc | null,
    private readonly opts: { poolAddress: string; tokenMint: string; role: FeeBeneficiaryRole; payoutMint?: string; expected?: ExpectedAllocation },
  ) {
    if (opts.role === "partner") throw new ProviderValidationError('Raydium LaunchLab has no "partner" fee role (use creator or platform)');
  }

  hydrate(pool: LaunchLabPoolState, platform: LaunchLabPlatformConfig, mints: { baseTokenProgram: string; quoteTokenProgram: string }, slot = 0): PoolInfo {
    const status: PoolStatus = pool.status === 0 ? "bonding" : pool.status === 1 ? "migrating" : "migrated";
    const quote = new PublicKey(pool.quoteMint);
    const cVault = creatorFeeVault(new PublicKey(pool.creator), quote).toBase58();
    const pVault = platformFeeVault(new PublicKey(pool.platformConfig), quote).toBase58();
    const creatorRole = this.opts.role === "creator";
    this.platform = platform;
    this.poolState = pool;
    const beneficiary = creatorRole ? pool.creator : platform.platformFeeWallet;
    // The creator's bonding-curve allocation is verified only when BOTH the platform identity (which
    // PlatformConfig the pool is bound to) and its creator_fee_rate match the declaration. A rate
    // alone is not an identity: other platforms use the same rate (e.g. EB2LqTh8… also has 5000).
    const check = creatorRole ? verifyLaunchLabCreatorBasis(pool.platformConfig, platform.creatorFeeRate, this.opts.expected) : { verification: "not_declared" as const, problems: [] };
    const lpCheck = creatorRole ? verifyDeclared("creator_scale", platform.creatorScale === undefined ? null : Number(platform.creatorScale), this.opts.expected?.launchlabCreatorLpScale) : { verification: "not_declared" as const, problems: [] };
    this.lpCheck = lpCheck;
    const allocation: AllocationBasis = makeBasis({
      provider: this.id,
      pool: this.opts.poolAddress,
      phase: "bonding_curve",
      role: this.opts.role,
      beneficiary,
      params: creatorRole ? { creatorFeeRate: platform.creatorFeeRate.toString(), feeRateDenominator: "1000000", platformConfig: pool.platformConfig } : { platformFeeRate: platform.feeRate.toString(), feeRateDenominator: "1000000", platformConfig: pool.platformConfig },
      source: `PlatformConfig ${pool.platformConfig}; per-trade TradeEvent.${creatorRole ? "creator_fee" : "platform_fee"}`,
      verification: check.verification,
      problems: check.problems,
    });
    const warnings: string[] = creatorRole && platform.creatorFeeRate === 0n ? ["this LaunchLab platform's creator_fee_rate is 0: the creator earns no bonding-curve fees"] : !creatorRole && platform.feeRate === 0n ? ["this LaunchLab platform's fee_rate is 0: the platform earns no bonding-curve fees"] : [];
    for (const p of check.problems) warnings.push(`ALLOCATION MISMATCH: ${p}; bonding-curve fees are recorded but NOT eligible for payout`);
    for (const p of lpCheck.problems) warnings.push(`ALLOCATION MISMATCH: ${p}; migrated LP fees will NOT be eligible for payout`);
    if (creatorRole && check.verification === "not_declared") warnings.push("NOT DECLARED: LaunchLab platform config and creator fee rate (EXPECTED_LAUNCHLAB_PLATFORM_CONFIG and EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE) — fees are recorded with the on-chain value but are NOT distributed until both are declared and verified");
    if (creatorRole && (platform.creatorScale ?? 0n) > 0n) warnings.push(`creator_scale is ${platform.creatorScale} on this PlatformConfig. It is a migrated-LP scale, not a creator fee: since the 2026-08-17 LaunchLab upgrade migrations add it to the platform's ONE Fee Key (minted to platform_nft_wallet). A creator LP entitlement exists only if the migration transaction itself minted a creator Fee Key`);
    if (creatorRole && platform.platformLockNftWallet && platform.platformLockNftWallet === pool.creator) warnings.push("the pool creator IS the platform NFT wallet: any locked-LP Fee Key minted to this wallet is platform-owned and is never attributed to the creator");
    if (!creatorRole) warnings.push('the "platform" role has no declarable allocation: its fees are recorded but never distributed');
    if (creatorRole) warnings.push("the creator fee vault is shared by every pool of this creator and quote mint: other pools' deposits are tracked and excluded, never attributed to this pool");
    this.cached = {
      provider: this.id,
      programId: this.programId,
      poolAddress: this.opts.poolAddress,
      tokenMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      baseDecimals: pool.baseDecimals,
      quoteDecimals: pool.quoteDecimals,
      ...mints,
      creator: pool.creator,
      feeBeneficiaryRole: this.opts.role,
      beneficiary,
      status,
      feeParams: {
        platformFeeRate: platform.feeRate.toString(),
        creatorFeeRate: platform.creatorFeeRate.toString(),
        feeRateDenominator: "1000000",
        ...(platform.creatorScale !== undefined ? { platformScale: platform.platformScale!.toString(), creatorScale: platform.creatorScale.toString(), burnScale: platform.burnScale!.toString(), scaleDenominator: "1000000" } : {}),
        allocationVerification: allocation.verification,
        migratedLpAllocationVerification: lpCheck.verification,
      },
      accounts: {
        globalConfig: pool.globalConfig,
        platformConfig: pool.platformConfig,
        baseVault: pool.baseVault,
        quoteVault: pool.quoteVault,
        creatorFeeVault: cVault,
        platformFeeVault: pVault,
        feeVault: creatorRole ? cVault : pVault,
      },
      // Claims touch the fee vault, not the pool, so both must be watched.
      watchAddresses: [this.opts.poolAddress, creatorRole ? cVault : pVault],
      slot,
      warnings,
      allocation,
    };
    return this.cached;
  }

  platformConfigState(): LaunchLabPlatformConfig | null {
    return this.platform;
  }

  /** Operator declarations this provider verifies against (read-only). */
  expectedAllocation(): ExpectedAllocation | undefined {
    return this.opts.expected;
  }

  async load(): Promise<PoolInfo> {
    if (!this.rpc) throw new Error("RaydiumLaunchLabProvider.load requires an RPC client");
    const { slot, value } = await this.rpc.getAccountInfo(this.opts.poolAddress);
    if (!value) throw new ProviderValidationError(`Pool ${this.opts.poolAddress} does not exist on this cluster`);
    if (value.owner !== LAUNCHLAB_PROGRAM_ID) throw new ProviderValidationError(`Pool ${this.opts.poolAddress} is owned by ${value.owner}, not Raydium LaunchLab`);
    const pool = decodeLaunchLabPool(value.data);
    if (pool.baseMint !== this.opts.tokenMint) throw new ProviderValidationError(`Pool base mint ${pool.baseMint} does not match TOKEN_MINT ${this.opts.tokenMint}`);
    if (this.opts.payoutMint && this.opts.payoutMint !== pool.quoteMint) {
      throw new ProviderValidationError(`Payout asset ${this.opts.payoutMint} differs from the pool's quote mint ${pool.quoteMint}; LAST60 never converts between assets`);
    }
    const plat = await this.rpc.getAccountInfo(pool.platformConfig);
    if (!plat.value || plat.value.owner !== LAUNCHLAB_PROGRAM_ID) throw new ProviderValidationError(`Platform config ${pool.platformConfig} not found`);
    const platform = decodeLaunchLabPlatformConfig(plat.value.data);
    const [base, quote] = await Promise.all([readMint(this.rpc, pool.baseMint), readMint(this.rpc, pool.quoteMint)]);
    return this.hydrate(pool, platform, { baseTokenProgram: base.program, quoteTokenProgram: quote.program }, slot);
  }

  info(): PoolInfo {
    if (!this.cached) throw new Error("provider not loaded");
    return this.cached;
  }

  supportedQuoteAssets(): string[] {
    return [WSOL_MINT];
  }

  parseTransaction(tx: NormalizedTx): ParsedTransaction {
    const info = this.info();
    const out: ParsedTransaction = { swaps: [], claims: [], anomalies: [], attributions: [] };
    if (tx.err) return out;
    const events = this.events.decodeAll(tx);
    const tradeEventParents = new Set<number>();
    const basis = info.allocation!;
    const payable = basisPayable(basis);
    const vault = info.accounts.feeVault!;
    const creatorRole = info.feeBeneficiaryRole === "creator";

    for (const ev of events) {
      if (ev.name !== "TradeEvent") continue;
      const parent = ev.parent;
      const evPool = toAddr(ev.data.pool_state ?? (ev.data as any).poolState);
      if (evPool !== info.poolAddress) {
        // Another pool's trade can deposit into the SAME creator/platform fee vault (shared PDA).
        // Record the deposit so reconciliation can be exact, and exclude it from this pool.
        if (parent) {
          const inflow = subtreeTransfers(tx, parent).filter((t) => t.destination === vault).reduce((a, t) => a + t.amount, 0n);
          if (inflow > 0n) {
            out.attributions!.push({
              key: `vault-inflow:${tx.signature}:${ev.ordinal}`,
              kind: "shared_vault_inflow",
              phase: "bonding_curve",
              provider: this.id,
              sourcePool: info.poolAddress,
              destinationPool: null,
              beneficiary: info.beneficiary,
              feeMint: info.quoteMint,
              grossAmount: inflow,
              creatorAmount: 0n,
              excludedAmount: inflow,
              excludedReason: EXCLUSION.otherPoolSharedVault,
              signature: tx.signature,
              slot: tx.slot,
              blockTime: tx.blockTime,
              evidence: { vault, otherPool: evPool, instruction: parent.ordinal, event: "TradeEvent" },
              status: "observed",
              payoutEligible: false,
              // The basis of the vault this inflow was excluded from (its snapshot explains why).
              basisId: basis.id,
            });
          }
        }
        continue;
      }
      if (!parent) {
        out.anomalies.push("TradeEvent without a resolvable trade instruction");
        continue;
      }
      tradeEventParents.add(parent.ordinal);
      const ixName = TRADE_IX.get(parent.data.subarray(0, 8).toString("hex"));
      if (!ixName) {
        out.anomalies.push("TradeEvent emitted by an unexpected instruction");
        continue;
      }
      const d: any = ev.data;
      const direction = enumVariant(d.trade_direction ?? d.tradeDirection);
      const side = direction === "buy" ? "buy" : "sell";
      if (!ixName.startsWith(side)) {
        out.anomalies.push(`TradeEvent direction ${direction} does not match instruction ${ixName}`);
        continue;
      }
      const protocolFee = toBig(d.protocol_fee ?? d.protocolFee);
      const platformFee = toBig(d.platform_fee ?? d.platformFee);
      const creatorFee = toBig(d.creator_fee ?? d.creatorFee);
      const shareFee = toBig(d.share_fee ?? d.shareFee);
      const amountIn = toBig(d.amount_in ?? d.amountIn);
      const amountOut = toBig(d.amount_out ?? d.amountOut);
      const { trader, source } = resolveTrader(tx, parent.accounts[0], info.tokenMint, side);
      const totalFee = protocolFee + platformFee + creatorFee + shareFee;
      const eligibleFee = creatorRole ? creatorFee : platformFee;
      // Cross-check the event against the transfer into the beneficiary's vault, when the program
      // moved it in this instruction (post fee-vault upgrade). A disagreement is never "resolved"
      // by picking one: the trade is flagged and its fee is not payable.
      const vaultIn = subtreeTransfers(tx, parent).filter((t) => t.destination === vault).reduce((a, t) => a + t.amount, 0n);
      const consistent = vaultIn === 0n || vaultIn === eligibleFee;
      if (!consistent) out.anomalies.push(`LaunchLab trade ${tx.signature.slice(0, 8)}…: ${creatorRole ? "creator" : "platform"}_fee ${eligibleFee} ≠ vault inflow ${vaultIn}`);
      const ok = payable && consistent;
      out.swaps.push({
        signature: tx.signature,
        eventIndex: ev.ordinal,
        side,
        trader,
        traderSource: source,
        quoteAmount: side === "buy" ? amountIn : amountOut,
        baseAmount: side === "buy" ? amountOut : amountIn,
        totalFee,
        totalFeeMint: info.quoteMint,
        eligibleFee,
        eligibleFeeMint: info.quoteMint,
        slot: tx.slot,
        blockTime: tx.blockTime,
        feePhase: "bonding_curve",
        excludedFee: totalFee - eligibleFee,
        excludedReason: ok ? EXCLUSION.notBeneficiaryShare : !payable ? `${EXCLUSION.allocationMismatch}: ${basis.problems.join("; ")}` : "event_vault_transfer_mismatch",
        feeStatus: ok ? "observed" : "unresolved",
        payoutEligible: ok,
        basisId: basis.id,
        evidence: { event: "TradeEvent", instruction: parent.ordinal, field: creatorRole ? "creator_fee" : "platform_fee", vaultInflow: vaultIn.toString(), vault },
      } satisfies NormalizedSwap);
    }

    for (const ix of tx.instructions) {
      if (ix.programId !== LAUNCHLAB_PROGRAM_ID) continue;
      const disc = ix.data.subarray(0, 8);
      if (TRADE_IX.has(disc.toString("hex")) && ix.accounts[4] === info.poolAddress && !tradeEventParents.has(ix.ordinal)) {
        out.anomalies.push("LaunchLab trade instruction on pool without a TradeEvent");
      }
      // Claims: the amount is what THIS claim instruction moved out of the vault — not the vault's
      // net change over the whole transaction (which a trade or another claim could distort).
      const isCreatorClaim = creatorRole && disc.equals(CLAIM_CREATOR_IX) && ix.accounts[2] === vault;
      const isPlatformClaim = !creatorRole && disc.equals(CLAIM_PLATFORM_VAULT_IX) && ix.accounts[3] === vault;
      if (isCreatorClaim || isPlatformClaim) {
        const outflows = subtreeTransfers(tx, ix).filter((t) => t.source === vault);
        const claimed = outflows.reduce((a, t) => a + t.amount, 0n);
        if (claimed > 0n) {
          out.claims.push({
            signature: tx.signature,
            claimer: ix.accounts[0]!,
            quoteAmount: claimed,
            baseAmount: 0n,
            slot: tx.slot,
            blockTime: tx.blockTime,
            evidence: { instruction: ix.ordinal, vault, transfers: outflows.map((t) => `${t.ordinal}:${t.destination}:${t.amount}`).join(",") },
          });
        }
      }
    }
    return out;
  }

  async getFeeSourceState(): Promise<FeeSourceState> {
    if (!this.rpc) throw new Error("RPC required");
    const info = this.info();
    const bal = await this.rpc.getTokenAccountBalance(info.accounts.feeVault!);
    const slot = bal?.slot ?? (await this.rpc.getSlot("confirmed"));
    return {
      slot,
      unclaimedQuote: bal?.amount ?? 0n,
      unclaimedBase: 0n,
      mayIncludeOtherPools: true,
      source: info.feeBeneficiaryRole === "creator" ? "creator fee vault [creator, quote_mint]" : "platform fee vault [platform_config, quote_mint]",
    };
  }

  async buildClaimInstructions(claimer: PublicKey, destination: PublicKey): Promise<ClaimPlan> {
    const info = this.info();
    if (claimer.toBase58() !== info.beneficiary) {
      throw new ProviderValidationError(`Claim signer ${claimer.toBase58()} is not the pool's ${info.feeBeneficiaryRole} (${info.beneficiary})`);
    }
    const quoteMint = new PublicKey(info.quoteMint);
    const quoteProgram = new PublicKey(info.quoteTokenProgram);
    const recipient = getAssociatedTokenAddressSync(quoteMint, claimer, true, quoteProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    const k = (pubkey: PublicKey | string, isWritable = false, isSigner = false) => ({ pubkey: typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey, isWritable, isSigner });
    const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(claimer, recipient, claimer, quoteMint, quoteProgram)];
    if (info.feeBeneficiaryRole === "creator") {
      ixs.push(
        new TransactionInstruction({
          programId: PROGRAM,
          data: CLAIM_CREATOR_IX,
          keys: [k(claimer, true, true), k(CREATOR_FEE_VAULT_AUTH), k(info.accounts.creatorFeeVault!, true), k(recipient, true), k(quoteMint), k(quoteProgram), k(SystemProgram.programId), k(ASSOCIATED_TOKEN_PROGRAM_ID)],
        }),
      );
    } else {
      ixs.push(
        new TransactionInstruction({
          programId: PROGRAM,
          data: CLAIM_PLATFORM_VAULT_IX,
          keys: [k(claimer, true, true), k(PLATFORM_FEE_VAULT_AUTH), k(info.accounts.platformConfig!), k(info.accounts.platformFeeVault!, true), k(recipient, true), k(quoteMint), k(quoteProgram), k(SystemProgram.programId), k(ASSOCIATED_TOKEN_PROGRAM_ID)],
        }),
      );
    }
    if (info.quoteMint === WSOL_MINT) ixs.push(createCloseAccountInstruction(recipient, destination, claimer, [], quoteProgram));
    return { instructions: ixs, signer: claimer, description: `LaunchLab ${info.feeBeneficiaryRole} fee claim → ${destination.toBase58()}` };
  }
}
