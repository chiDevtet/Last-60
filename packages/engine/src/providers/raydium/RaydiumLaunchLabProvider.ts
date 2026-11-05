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
 *     to the total fee rate — e.g. 5000 = 0.5% of the trade — not a percentage of the other fees.
 *     The program charges total_fee = ceil(amount × Σrates / 1e6) and splits it pro rata to the
 *     rates; TradeEvent.creator_fee is that exact split (Raydium SDK curve.ts splitFee).
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
}

/**
 * Byte offsets follow the Raydium SDK `PlatformConfig` layout (verified on a mainnet account:
 * fee_rate 7500, creator_fee_rate 5000, platform_scale 1 000 000, cp_config = the CPMM config used
 * by that platform's migrations).
 */
export function decodeLaunchLabPlatformConfig(data: Buffer): LaunchLabPlatformConfig {
  if (!data.subarray(0, 8).equals(PLATFORM_CONFIG_DISC)) throw new ProviderValidationError("account is not a LaunchLab PlatformConfig");
  const cpCreator = data.length >= 832 ? pk(data, 800) : null;
  return {
    platformFeeWallet: pk(data, 16),
    platformLockNftWallet: pk(data, 48),
    platformScale: u64(data, 80),
    creatorScale: u64(data, 88),
    burnScale: u64(data, 96),
    feeRate: u64(data, 104),
    cpConfig: pk(data, 688),
    creatorFeeRate: u64(data, 720),
    platformCpCreator: cpCreator && cpCreator !== "11111111111111111111111111111111" ? cpCreator : null,
  };
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
    const check = creatorRole ? verifyDeclared("creator_fee_rate", Number(platform.creatorFeeRate), this.opts.expected?.launchlabCreatorFeeRate) : { verification: "not_declared" as const, problems: [] };
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
    if (creatorRole && check.verification === "not_declared") warnings.push("creator fee rate not declared (EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE); the on-chain value is used as read");
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
              basisId: null,
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
