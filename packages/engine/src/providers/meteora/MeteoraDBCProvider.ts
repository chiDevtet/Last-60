/**
 * Meteora Dynamic Bonding Curve adapter.
 *
 * Verified against program source (MeteoraAg/dynamic-bonding-curve) and mainnet transactions:
 *   - Every swap emits EvtSwap, EvtSwap2 and EvtSwap3 via self-CPI. EvtSwap3 is authoritative;
 *     EvtSwap2 is a fallback for program versions that predate EvtSwap3.
 *   - trade_direction 1 = QuoteToBase (buy), 0 = BaseToQuote (sell).
 *   - `trading_fee` is the LP share; creator = floor(trading_fee * creator_trading_fee_percentage / 100),
 *     partner = trading_fee - creator (state/config.rs::split_partner_and_creator_fee).
 *   - Fees are in the base token when collect_fee_mode = OutputToken and the trade is a buy.
 *   - Unclaimed fees: pool.creator_quote_fee / creator_base_fee / partner_quote_fee / partner_base_fee.
 */
import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { WSOL_MINT } from "@last60/shared";
import idlJson from "./idl/dynamic_bonding_curve.json";
import { AnchorEventDecoder, enumVariant, instructionDiscriminator, toAddr, toBig } from "../../chain/anchorEvents";
import type { NormalizedTx } from "../../chain/tx";
import type { ChainRpc } from "../../chain/rpc";
import { readMint } from "../mint";
import type { ExpectedAllocation } from "../../config/env";
import { basisPayable, EXCLUSION, makeBasis, type AllocationBasis, type AllocationVerification } from "../../accounting/attribution";
import {
  ProviderValidationError,
  resolveTrader,
  type ClaimPlan,
  type FeeBeneficiaryRole,
  type FeeSourceState,
  type LaunchProvider,
  type NormalizedFeeClaim,
  type NormalizedSwap,
  type ParsedTransaction,
  type PoolInfo,
  type PoolStatus,
} from "../LaunchProvider";

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const idl = idlJson as unknown as Idl;
const PROGRAM = new PublicKey(DBC_PROGRAM_ID);
export const DBC_POOL_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], PROGRAM)[0];
export const DBC_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PROGRAM)[0];

const SWAP_IX = new Set(["swap", "swap2", "swap2_with_transfer_hook"].map((n) => instructionDiscriminator(n).toString("hex")));
const CLAIM_CREATOR_IX = new Set(["claim_creator_trading_fee", "claim_creator_trading_fee2"].map((n) => instructionDiscriminator(n).toString("hex")));
const CLAIM_PARTNER_IX = new Set(["claim_trading_fee", "claim_trading_fee2"].map((n) => instructionDiscriminator(n).toString("hex")));
const U64_MAX = (1n << 64n) - 1n;

/** Read a field from an Anchor-decoded struct regardless of snake/camel casing. */
function f(obj: any, snake: string): any {
  if (obj == null) return undefined;
  if (snake in obj) return obj[snake];
  const camel = snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  return obj[camel];
}

export interface DbcPoolState {
  config: string;
  creator: string;
  baseMint: string;
  baseVault: string;
  quoteVault: string;
  isMigrated: boolean;
  migrationProgress: number;
  creatorQuoteFee: bigint;
  creatorBaseFee: bigint;
  partnerQuoteFee: bigint;
  partnerBaseFee: bigint;
  transferHook: boolean;
}

export interface DbcConfigState {
  quoteMint: string;
  feeClaimer: string;
  collectFeeMode: number; // 0 = QuoteToken, 1 = OutputToken
  creatorTradingFeePercentage: number;
  migrationOption: number;
  /** LP split applied at graduation (percent of distributable liquidity). Absent on hand-built test configs. */
  lp?: {
    creatorLiquidity: number;
    creatorPermanentLocked: number;
    creatorVesting: number;
    partnerLiquidity: number;
    partnerPermanentLocked: number;
    partnerVesting: number;
  };
}

/** Creator's total share of migrated LP (liquid + permanently locked + vesting), in percent. */
export function dbcCreatorLpPercentage(cfg: DbcConfigState): number | null {
  if (!cfg.lp) return null;
  return cfg.lp.creatorLiquidity + cfg.lp.creatorPermanentLocked + cfg.lp.creatorVesting;
}

/**
 * Compare an on-chain DBC parameter with the operator's declaration. The on-chain value is always
 * what is accounted; a mismatch only makes the affected fees ineligible and flags the pool.
 */
export function verifyDeclared(label: string, onChain: number | null, declared: number | null | undefined): { verification: AllocationVerification; problems: string[] } {
  if (declared === null || declared === undefined) return { verification: "not_declared", problems: [] };
  if (onChain === null) return { verification: "unverifiable", problems: [`${label} could not be read on-chain (declared ${declared})`] };
  if (onChain !== declared) return { verification: "mismatch", problems: [`${label} is ${onChain} on-chain but ${declared} was declared`] };
  return { verification: "verified", problems: [] };
}

/**
 * Facts about a DBC config that change what LAST60 can distribute. Observed on mainnet: configs
 * with creator_trading_fee_percentage = 0 (the creator earns NOTHING from bonding-curve trades,
 * the partner/launchpad takes 100%) that nevertheless give the creator the LP position after
 * graduation — so the configured role's entitlement can flip at migration.
 */
export function dbcConfigWarnings(role: FeeBeneficiaryRole, cfg: DbcConfigState): string[] {
  const w: string[] = [];
  if (role === "creator" && cfg.creatorTradingFeePercentage === 0) w.push("creator_trading_fee_percentage is 0 on this DBC config: the creator earns no bonding-curve trading fees, so rounds will have no eligible fees before graduation");
  if (role === "partner" && cfg.creatorTradingFeePercentage === 100) w.push("creator_trading_fee_percentage is 100 on this DBC config: the partner earns no bonding-curve trading fees");
  if (cfg.collectFeeMode === 1) w.push("collect_fee_mode is OutputToken: fees on buys accrue in the base token and are recorded but not distributed as the payout asset");
  return w;
}

function vestingPct(v: any): number {
  if (!v || Number(f(v, "is_initialized")) !== 1) return 0;
  return Number(f(v, "vesting_percentage"));
}

export class MeteoraDBCProvider implements LaunchProvider {
  readonly id = "meteora_dbc" as const;
  readonly programId = DBC_PROGRAM_ID;
  private readonly coder = new BorshCoder(idl);
  private readonly events = new AnchorEventDecoder(DBC_PROGRAM_ID, idl);
  private cached: PoolInfo | null = null;
  private cfg: DbcConfigState | null = null;

  constructor(
    private readonly rpc: ChainRpc | null,
    private readonly opts: { poolAddress: string; tokenMint: string; role: FeeBeneficiaryRole; payoutMint?: string; expected?: ExpectedAllocation },
  ) {
    if (opts.role === "platform") throw new ProviderValidationError('Meteora DBC has no "platform" fee role (use creator or partner)');
  }

  decodePool(data: Buffer): DbcPoolState {
    const disc = data.subarray(0, 8).toString("hex");
    const name = disc === Buffer.from([237, 219, 184, 23, 42, 189, 169, 35]).toString("hex") ? "TransferHookPool" : "VirtualPool";
    const acc: any = this.coder.accounts.decode(name, data);
    const s = f(acc, "pool_state");
    return {
      config: toAddr(f(s, "config")),
      creator: toAddr(f(s, "creator")),
      baseMint: toAddr(f(s, "base_mint")),
      baseVault: toAddr(f(s, "base_vault")),
      quoteVault: toAddr(f(s, "quote_vault")),
      isMigrated: Number(f(s, "is_migrated")) === 1,
      migrationProgress: Number(f(s, "migration_progress")),
      creatorQuoteFee: toBig(f(s, "creator_quote_fee")),
      creatorBaseFee: toBig(f(s, "creator_base_fee")),
      partnerQuoteFee: toBig(f(s, "partner_quote_fee")),
      partnerBaseFee: toBig(f(s, "partner_base_fee")),
      transferHook: name === "TransferHookPool",
    };
  }

  decodeConfig(data: Buffer): DbcConfigState {
    const disc = data.subarray(0, 8).toString("hex");
    const isHook = disc === Buffer.from([40, 220, 194, 251, 41, 199, 123, 253]).toString("hex");
    const acc: any = this.coder.accounts.decode(isHook ? "ConfigWithTransferHook" : "PoolConfig", data);
    const c = isHook ? f(acc, "config") : acc;
    return {
      quoteMint: toAddr(f(c, "quote_mint")),
      feeClaimer: toAddr(f(c, "fee_claimer")),
      collectFeeMode: Number(f(c, "collect_fee_mode")),
      creatorTradingFeePercentage: Number(f(c, "creator_trading_fee_percentage")),
      migrationOption: Number(f(c, "migration_option")),
      lp: {
        creatorLiquidity: Number(f(c, "creator_liquidity_percentage")),
        creatorPermanentLocked: Number(f(c, "creator_permanent_locked_liquidity_percentage")),
        creatorVesting: vestingPct(f(c, "creator_liquidity_vesting_info")),
        partnerLiquidity: Number(f(c, "partner_liquidity_percentage")),
        partnerPermanentLocked: Number(f(c, "partner_permanent_locked_liquidity_percentage")),
        partnerVesting: vestingPct(f(c, "partner_liquidity_vesting_info")),
      },
    };
  }

  /** Inject state without RPC (tests, offline reprocessing). */
  hydrate(pool: DbcPoolState, cfg: DbcConfigState, mints: { baseDecimals: number; quoteDecimals: number; baseTokenProgram: string; quoteTokenProgram: string }, slot = 0): PoolInfo {
    this.cfg = cfg;
    const status: PoolStatus = pool.isMigrated ? "migrated" : pool.migrationProgress > 0 ? "migrating" : "bonding";
    const beneficiary = this.opts.role === "creator" ? pool.creator : cfg.feeClaimer;
    // The creator's declared bonding-curve share is checked only for the creator role; the partner's
    // share is the on-chain complement and has no separate declaration.
    const check = this.opts.role === "creator" ? verifyDeclared("creator_trading_fee_percentage", cfg.creatorTradingFeePercentage, this.opts.expected?.dbcCreatorTradingFeePercentage) : { verification: "not_declared" as const, problems: [] };
    const allocation: AllocationBasis = makeBasis({
      provider: this.id,
      pool: this.opts.poolAddress,
      phase: "bonding_curve",
      role: this.opts.role,
      beneficiary,
      params: { creatorTradingFeePercentage: cfg.creatorTradingFeePercentage, collectFeeMode: cfg.collectFeeMode, config: pool.config },
      source: `PoolConfig ${pool.config} (creator_trading_fee_percentage); VirtualPool ${this.opts.poolAddress} (creator)`,
      verification: check.verification,
      problems: check.problems,
    });
    const lpPct = dbcCreatorLpPercentage(cfg);
    const lpCheck = this.opts.role === "creator" ? verifyDeclared("creator LP percentage", lpPct, this.opts.expected?.dbcCreatorLpPercentage) : { verification: "not_declared" as const, problems: [] };
    const warnings = [...dbcConfigWarnings(this.opts.role, cfg), ...check.problems.map((p) => `ALLOCATION MISMATCH: ${p}; bonding-curve fees are recorded but NOT eligible for payout`), ...lpCheck.problems.map((p) => `ALLOCATION MISMATCH: ${p}; migrated LP fees will NOT be eligible for payout`)];
    if (this.opts.role === "creator" && check.verification === "not_declared") warnings.push("NOT DECLARED: creator bonding-curve allocation (EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE) — fees are recorded with the on-chain value but are NOT distributed until it is declared and verified");
    if (this.opts.role === "creator" && lpCheck.verification === "not_declared") warnings.push("NOT DECLARED: creator migrated-LP allocation (EXPECTED_DBC_CREATOR_LP_PERCENTAGE) — post-graduation LP fees will be recorded but NOT distributed until it is declared and verified");
    if (this.opts.role !== "creator") warnings.push(`the "${this.opts.role}" role has no declarable allocation: its fees are recorded but never distributed`);
    this.lpCheck = lpCheck;
    this.cached = {
      provider: this.id,
      programId: this.programId,
      poolAddress: this.opts.poolAddress,
      tokenMint: pool.baseMint,
      quoteMint: cfg.quoteMint,
      ...mints,
      creator: pool.creator,
      feeBeneficiaryRole: this.opts.role,
      beneficiary,
      status,
      feeParams: {
        creatorTradingFeePercentage: cfg.creatorTradingFeePercentage,
        collectFeeMode: cfg.collectFeeMode === 0 ? "QuoteToken" : "OutputToken",
        migrationOption: cfg.migrationOption,
        transferHookPool: pool.transferHook,
        ...(lpPct !== null ? { creatorLpPercentage: lpPct, partnerLpPercentage: cfg.lp!.partnerLiquidity + cfg.lp!.partnerPermanentLocked + cfg.lp!.partnerVesting } : {}),
        allocationVerification: allocation.verification,
        migratedLpAllocationVerification: lpCheck.verification,
      },
      accounts: { config: pool.config, baseVault: pool.baseVault, quoteVault: pool.quoteVault, poolAuthority: DBC_POOL_AUTHORITY.toBase58(), feeClaimer: cfg.feeClaimer },
      watchAddresses: [this.opts.poolAddress],
      slot,
      warnings,
      allocation,
    };
    return this.cached;
  }

  /** Result of checking the declared creator LP percentage (applies to migrated LP fees). */
  lpCheck: { verification: AllocationVerification; problems: string[] } = { verification: "not_declared", problems: [] };

  /** Decoded config of the loaded pool (for migration verification). */
  configState(): DbcConfigState | null {
    return this.cfg;
  }

  async load(): Promise<PoolInfo> {
    if (!this.rpc) throw new Error("MeteoraDBCProvider.load requires an RPC client");
    const { slot, value } = await this.rpc.getAccountInfo(this.opts.poolAddress);
    if (!value) throw new ProviderValidationError(`Pool ${this.opts.poolAddress} does not exist on this cluster`);
    if (value.owner !== DBC_PROGRAM_ID) throw new ProviderValidationError(`Pool ${this.opts.poolAddress} is owned by ${value.owner}, not the Meteora DBC program`);
    const pool = this.decodePool(value.data);
    if (pool.baseMint !== this.opts.tokenMint) throw new ProviderValidationError(`Pool base mint ${pool.baseMint} does not match TOKEN_MINT ${this.opts.tokenMint}`);
    const cfgAcc = await this.rpc.getAccountInfo(pool.config);
    if (!cfgAcc.value || cfgAcc.value.owner !== DBC_PROGRAM_ID) throw new ProviderValidationError(`Config ${pool.config} not found or not owned by DBC`);
    const cfg = this.decodeConfig(cfgAcc.value.data);
    const [base, quote] = await Promise.all([readMint(this.rpc, pool.baseMint), readMint(this.rpc, cfg.quoteMint)]);
    if (this.opts.payoutMint && this.opts.payoutMint !== cfg.quoteMint) {
      throw new ProviderValidationError(`Payout asset ${this.opts.payoutMint} differs from the pool's quote mint ${cfg.quoteMint}; LAST60 never converts between assets`);
    }
    return this.hydrate(pool, cfg, { baseDecimals: base.decimals, quoteDecimals: quote.decimals, baseTokenProgram: base.program, quoteTokenProgram: quote.program }, slot);
  }

  info(): PoolInfo {
    if (!this.cached) throw new Error("provider not loaded");
    return this.cached;
  }

  supportedQuoteAssets(): string[] {
    return [WSOL_MINT];
  }

  /** Exact beneficiary share of an LP trading fee (mirrors split_partner_and_creator_fee). */
  eligibleShare(tradingFee: bigint): bigint {
    const pct = BigInt(this.cfg?.creatorTradingFeePercentage ?? 0);
    const creator = pct === 0n ? 0n : (tradingFee * pct) / 100n; // Rounding::Down
    return this.opts.role === "creator" ? creator : tradingFee - creator;
  }

  parseTransaction(tx: NormalizedTx): ParsedTransaction {
    const info = this.info();
    const out: ParsedTransaction = { swaps: [], claims: [], anomalies: [] };
    if (tx.err) return out; // failed transactions change no state
    const events = this.events.decodeAll(tx);

    // Group swap events by the instruction that emitted them; prefer EvtSwap3 over EvtSwap2.
    const byParent = new Map<number, typeof events>();
    for (const e of events) {
      if (!e.parent) continue;
      const list = byParent.get(e.parent.ordinal) ?? [];
      list.push(e);
      byParent.set(e.parent.ordinal, list);
    }

    for (const [, list] of byParent) {
      const parent = list[0]!.parent!;
      const disc = parent.data.subarray(0, 8).toString("hex");
      if (SWAP_IX.has(disc)) {
        if (parent.accounts[2] !== info.poolAddress) continue;
        const ev3 = list.find((e) => e.name === "EvtSwap3" || e.name === "EvtSwap3WithTransferHook");
        const ev2 = list.find((e) => e.name === "EvtSwap2" || e.name === "EvtSwap2WithTransferHook");
        const ev = ev3 ?? ev2;
        if (!ev) {
          out.anomalies.push(`DBC swap instruction on pool without a decodable swap event (${list.map((e) => e.name).join(",")})`);
          continue;
        }
        if (toAddr(f(ev.data, "pool")) !== info.poolAddress) continue;
        const swap = ev3 ? this.fromSwap3(tx, ev3.data, parent.accounts[9]) : this.fromSwap2(tx, ev2!.data, parent.accounts[9]);
        out.swaps.push({ ...this.attribute(swap, ev3 ? "EvtSwap3" : "EvtSwap2", parent.ordinal), eventIndex: ev.ordinal });
        continue;
      }
      const isCreatorClaim = CLAIM_CREATOR_IX.has(disc);
      const isPartnerClaim = CLAIM_PARTNER_IX.has(disc);
      if (isCreatorClaim || isPartnerClaim) {
        const ev = list.find((e) => e.name === (isCreatorClaim ? "EvtClaimCreatorTradingFee" : "EvtClaimTradingFee"));
        if (!ev || toAddr(f(ev.data, "pool")) !== info.poolAddress) continue;
        if ((this.opts.role === "creator") !== isCreatorClaim) continue; // someone else's share
        const claimer = isCreatorClaim ? parent.accounts[8]! : parent.accounts[9]!;
        out.claims.push({
          signature: tx.signature,
          claimer,
          baseAmount: toBig(f(ev.data, "token_base_amount")),
          quoteAmount: toBig(f(ev.data, "token_quote_amount")),
          slot: tx.slot,
          blockTime: tx.blockTime,
          // Instruction-scoped evidence: the claim instruction (its vault → recipient transfers).
          evidence: { instruction: parent.ordinal, event: isCreatorClaim ? "EvtClaimCreatorTradingFee" : "EvtClaimTradingFee" },
        } satisfies NormalizedFeeClaim);
      }
    }
    return out;
  }

  /** Attach provenance: gross vs beneficiary vs excluded, the basis, and payout eligibility. */
  private attribute(s: Omit<NormalizedSwap, "eventIndex">, event: string, ixOrdinal: number): Omit<NormalizedSwap, "eventIndex"> {
    const basis = this.info().allocation!;
    const payable = basisPayable(basis);
    return {
      ...s,
      feePhase: "bonding_curve",
      excludedFee: s.totalFee - s.eligibleFee,
      excludedReason: payable ? EXCLUSION.notBeneficiaryShare : `${EXCLUSION.allocationMismatch}: ${basis.problems.join("; ")}`,
      feeStatus: payable ? "observed" : "unresolved",
      payoutEligible: payable,
      basisId: basis.id,
      evidence: { event, instruction: ixOrdinal, formula: "floor(trading_fee * creator_trading_fee_percentage / 100)", creatorTradingFeePercentage: this.cfg?.creatorTradingFeePercentage ?? null },
    };
  }

  private fromSwap3(tx: NormalizedTx, d: any, payer: string | undefined): Omit<NormalizedSwap, "eventIndex"> {
    const info = this.info();
    const buy = Number(f(d, "trade_direction")) === 1;
    const side = buy ? "buy" : "sell";
    const feeOnBase = Boolean(f(d, "fee_on_base_token"));
    const tradingFee = toBig(f(d, "trading_fee"));
    const protocolFee = toBig(f(d, "protocol_fee"));
    const referralFee = toBig(f(d, "referral_fee"));
    const { trader, source } = resolveTrader(tx, payer, info.tokenMint, side);
    const feeMint = feeOnBase ? info.tokenMint : info.quoteMint;
    return {
      signature: tx.signature,
      side,
      trader,
      traderSource: source,
      quoteAmount: buy ? toBig(f(d, "included_transfer_fee_amount_in")) : toBig(f(d, "excluded_transfer_fee_amount_out")),
      baseAmount: buy ? toBig(f(d, "excluded_transfer_fee_amount_out")) : toBig(f(d, "included_transfer_fee_amount_in")),
      totalFee: tradingFee + protocolFee + referralFee,
      totalFeeMint: feeMint,
      eligibleFee: this.eligibleShare(tradingFee),
      eligibleFeeMint: feeMint,
      slot: tx.slot,
      blockTime: tx.blockTime,
    };
  }

  /** Fallback for program versions without EvtSwap3. Fee asset derived from collect_fee_mode. */
  private fromSwap2(tx: NormalizedTx, d: any, payer: string | undefined): Omit<NormalizedSwap, "eventIndex"> {
    const info = this.info();
    const buy = Number(f(d, "trade_direction")) === 1;
    const side = buy ? "buy" : "sell";
    const r = f(d, "swap_result");
    const tradingFee = toBig(f(r, "trading_fee"));
    const total = tradingFee + toBig(f(r, "protocol_fee")) + toBig(f(r, "referral_fee"));
    const feeOnBase = (this.cfg?.collectFeeMode ?? 0) === 1 && buy;
    const feeMint = feeOnBase ? info.tokenMint : info.quoteMint;
    const { trader, source } = resolveTrader(tx, payer, info.tokenMint, side);
    return {
      signature: tx.signature,
      side,
      trader,
      traderSource: source,
      quoteAmount: buy ? toBig(f(r, "included_fee_input_amount")) : toBig(f(r, "output_amount")),
      baseAmount: buy ? toBig(f(r, "output_amount")) : toBig(f(r, "included_fee_input_amount")),
      totalFee: total,
      totalFeeMint: feeMint,
      eligibleFee: this.eligibleShare(tradingFee),
      eligibleFeeMint: feeMint,
      slot: tx.slot,
      blockTime: tx.blockTime,
    };
  }

  async getFeeSourceState(): Promise<FeeSourceState> {
    if (!this.rpc) throw new Error("RPC required");
    const { slot, value } = await this.rpc.getAccountInfo(this.opts.poolAddress);
    if (!value) throw new Error("pool account disappeared");
    const p = this.decodePool(value.data);
    const creator = this.opts.role === "creator";
    return {
      slot,
      unclaimedQuote: creator ? p.creatorQuoteFee : p.partnerQuoteFee,
      unclaimedBase: creator ? p.creatorBaseFee : p.partnerBaseFee,
      mayIncludeOtherPools: false,
      source: creator ? "VirtualPool.creator_{quote,base}_fee" : "VirtualPool.partner_{quote,base}_fee",
    };
  }

  async buildClaimInstructions(claimer: PublicKey, destination: PublicKey): Promise<ClaimPlan> {
    const info = this.info();
    if (claimer.toBase58() !== info.beneficiary) {
      throw new ProviderValidationError(`Claim signer ${claimer.toBase58()} is not the pool's ${this.opts.role} (${info.beneficiary})`);
    }
    if (info.feeParams.transferHookPool) {
      throw new ProviderValidationError("Transfer-hook DBC pools need claim_creator_trading_fee2 with hook accounts; not supported by auto-claim");
    }
    const baseMint = new PublicKey(info.tokenMint);
    const quoteMint = new PublicKey(info.quoteMint);
    const baseProgram = new PublicKey(info.baseTokenProgram);
    const quoteProgram = new PublicKey(info.quoteTokenProgram);
    const baseAta = getAssociatedTokenAddressSync(baseMint, claimer, true, baseProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, claimer, true, quoteProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(claimer, baseAta, claimer, baseMint, baseProgram),
      createAssociatedTokenAccountIdempotentInstruction(claimer, quoteAta, claimer, quoteMint, quoteProgram),
    ];
    const creator = this.opts.role === "creator";
    const name = creator ? "claim_creator_trading_fee" : "claim_trading_fee";
    const max = new BN(U64_MAX.toString());
    const data = this.coder.instruction.encode(name, creator ? { max_base_amount: max, max_quote_amount: max } : { max_amount_a: max, max_amount_b: max });
    const k = (pubkey: PublicKey | string, isWritable = false, isSigner = false) => ({ pubkey: typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey, isWritable, isSigner });
    const keys = creator
      ? [k(DBC_POOL_AUTHORITY), k(info.poolAddress, true), k(baseAta, true), k(quoteAta, true), k(info.accounts.baseVault!, true), k(info.accounts.quoteVault!, true), k(baseMint), k(quoteMint), k(claimer, false, true), k(baseProgram), k(quoteProgram), k(DBC_EVENT_AUTHORITY), k(PROGRAM)]
      : [k(DBC_POOL_AUTHORITY), k(info.accounts.config!), k(info.poolAddress, true), k(baseAta, true), k(quoteAta, true), k(info.accounts.baseVault!, true), k(info.accounts.quoteVault!, true), k(baseMint), k(quoteMint), k(claimer, false, true), k(baseProgram), k(quoteProgram), k(DBC_EVENT_AUTHORITY), k(PROGRAM)];
    ixs.push(new TransactionInstruction({ programId: PROGRAM, keys, data }));
    if (info.quoteMint === WSOL_MINT) {
      // Unwrap: closing the WSOL ATA sends its lamports (claimed fees + rent) to `destination`.
      ixs.push(createCloseAccountInstruction(quoteAta, destination, claimer, [], quoteProgram));
    }
    return { instructions: ixs, signer: claimer, description: `${name} → ${destination.toBase58()}` };
  }
}
