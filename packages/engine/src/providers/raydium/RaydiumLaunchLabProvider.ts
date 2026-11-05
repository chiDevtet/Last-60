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
 *   - claim_creator_fee / claim_platform_fee_from_vault emit no event; amounts are read from the
 *     vault's token balance delta.
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
import { tokenAccountDelta, type NormalizedTx } from "../../chain/tx";
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
}

/** Byte offsets follow the Raydium SDK `PlatformConfig` layout. */
export function decodeLaunchLabPlatformConfig(data: Buffer): LaunchLabPlatformConfig {
  if (!data.subarray(0, 8).equals(PLATFORM_CONFIG_DISC)) throw new ProviderValidationError("account is not a LaunchLab PlatformConfig");
  return { platformFeeWallet: pk(data, 16), feeRate: u64(data, 104), creatorFeeRate: u64(data, 720) };
}

export class RaydiumLaunchLabProvider implements LaunchProvider {
  readonly id = "raydium_launchlab" as const;
  readonly programId = LAUNCHLAB_PROGRAM_ID;
  private readonly events = new AnchorEventDecoder(LAUNCHLAB_PROGRAM_ID, idl);
  private cached: PoolInfo | null = null;

  constructor(
    private readonly rpc: ChainRpc | null,
    private readonly opts: { poolAddress: string; tokenMint: string; role: FeeBeneficiaryRole; payoutMint?: string },
  ) {
    if (opts.role === "partner") throw new ProviderValidationError('Raydium LaunchLab has no "partner" fee role (use creator or platform)');
  }

  hydrate(pool: LaunchLabPoolState, platform: LaunchLabPlatformConfig, mints: { baseTokenProgram: string; quoteTokenProgram: string }, slot = 0): PoolInfo {
    const status: PoolStatus = pool.status === 0 ? "bonding" : pool.status === 1 ? "migrating" : "migrated";
    const quote = new PublicKey(pool.quoteMint);
    const cVault = creatorFeeVault(new PublicKey(pool.creator), quote).toBase58();
    const pVault = platformFeeVault(new PublicKey(pool.platformConfig), quote).toBase58();
    const creatorRole = this.opts.role === "creator";
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
      beneficiary: creatorRole ? pool.creator : platform.platformFeeWallet,
      status,
      feeParams: {
        platformFeeRate: platform.feeRate.toString(),
        creatorFeeRate: platform.creatorFeeRate.toString(),
        feeRateDenominator: "1000000",
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
    };
    return this.cached;
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
    const out: ParsedTransaction = { swaps: [], claims: [], anomalies: [] };
    if (tx.err) return out;
    const events = this.events.decodeAll(tx);
    const tradeEventParents = new Set<number>();

    for (const ev of events) {
      if (ev.name !== "TradeEvent") continue;
      const parent = ev.parent;
      if (!parent) {
        out.anomalies.push("TradeEvent without a resolvable trade instruction");
        continue;
      }
      if (toAddr(ev.data.pool_state ?? (ev.data as any).poolState) !== info.poolAddress) continue;
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
      out.swaps.push({
        signature: tx.signature,
        eventIndex: ev.ordinal,
        side,
        trader,
        traderSource: source,
        quoteAmount: side === "buy" ? amountIn : amountOut,
        baseAmount: side === "buy" ? amountOut : amountIn,
        totalFee: protocolFee + platformFee + creatorFee + shareFee,
        totalFeeMint: info.quoteMint,
        eligibleFee: info.feeBeneficiaryRole === "creator" ? creatorFee : platformFee,
        eligibleFeeMint: info.quoteMint,
        slot: tx.slot,
        blockTime: tx.blockTime,
      } satisfies NormalizedSwap);
    }

    // Trade instructions on our pool that produced no TradeEvent are anomalies.
    for (const ix of tx.instructions) {
      if (ix.programId !== LAUNCHLAB_PROGRAM_ID) continue;
      const disc = ix.data.subarray(0, 8);
      if (TRADE_IX.has(disc.toString("hex")) && ix.accounts[4] === info.poolAddress && !tradeEventParents.has(ix.ordinal)) {
        out.anomalies.push("LaunchLab trade instruction on pool without a TradeEvent");
      }
      const vault = info.accounts.feeVault!;
      if (info.feeBeneficiaryRole === "creator" && disc.equals(CLAIM_CREATOR_IX) && ix.accounts[2] === vault) {
        const claimed = -tokenAccountDelta(tx, vault);
        if (claimed > 0n) out.claims.push({ signature: tx.signature, claimer: ix.accounts[0]!, quoteAmount: claimed, baseAmount: 0n, slot: tx.slot, blockTime: tx.blockTime });
      }
      if (info.feeBeneficiaryRole === "platform" && disc.equals(CLAIM_PLATFORM_VAULT_IX) && ix.accounts[3] === vault) {
        const claimed = -tokenAccountDelta(tx, vault);
        if (claimed > 0n) out.claims.push({ signature: tx.signature, claimer: ix.accounts[0]!, quoteAmount: claimed, baseAmount: 0n, slot: tx.slot, blockTime: tx.blockTime });
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
