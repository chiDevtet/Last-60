/**
 * pump.fun bonding-curve adapter (program `pump`, 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P).
 *
 * Built from the official IDL (@pump-fun/pump-sdk 4.3.1, vendored in ./idl) and verified on mainnet
 * transactions and accounts (test/fixtures/mainnet/pumpfun-*.json):
 *   - Every trade instruction (buy, buy_exact_sol_in, sell and their _v2 / _v3 forms, and the hops of
 *     multi_hop_curve_swap) emits ONE `TradeEvent` through a self-CPI. The event carries the mint, the
 *     trader (`user`), the side, the protocol `fee`, and the coin's `creator` with its `creator_fee`.
 *   - `sol_amount` excludes the fees: a buyer pays sol_amount + fee + creator_fee, a seller receives
 *     sol_amount − fee − creator_fee (lamport deltas of real trades match exactly). The buyback fee
 *     is a slice of `fee`, not an extra charge.
 *   - Where the creator fee goes depends on the instruction:
 *       legacy / _v2 trades   straight into the creator vault ["creator-vault", creator] (lamports);
 *       _v3 trades            it stays on the curve (`BondingCurve.creator_fee`) until the
 *                             permissionless `sweep_creator_fee` moves it to the same vault
 *                             (`SweepBondingCurveFeeEvent`, bucket 1).
 *   - The creator vault is keyed by the CREATOR: all coins of one creator share it. Each trade is
 *     attributed from its own event; what other coins put into the vault is recorded and excluded.
 *   - `collect_creator_fee` pays the vault (above its rent floor) to the creator and emits
 *     `CollectCreatorFeeEvent`. It is permissionless and always pays the creator itself.
 *   - Holder-reward coins pay the creator fee to holders (`holder_rewards`), cashback coins to the
 *     trader: neither is a creator entitlement, and such coins are never distributable here.
 * Only SOL-quoted coins are supported (the curve's `quote_mint` is the zero key for SOL).
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Idl } from "@coral-xyz/anchor";
import { WSOL_MINT } from "@last60/shared";
import idlJson from "./idl/pump.json";
import { AnchorEventDecoder, instructionDiscriminator, toAddr, toBig } from "../../chain/anchorEvents";
import type { FlatInstruction, NormalizedTx } from "../../chain/tx";
import type { ExpectedAllocation } from "../../config/env";
import { basisPayable, EXCLUSION, makeBasis, type AllocationBasis, type AllocationVerification, type NormalizedAttribution } from "../../accounting/attribution";
import type { ChainRpc } from "../../chain/rpc";
import { readMint } from "../mint";
import {
  AwaitingLaunchError,
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
import { canonicalPumpSwapPool, derivePumpBondingCurve, pumpCreatorVault, pumpSwapCreatorVaultAta, pumpSwapCreatorVaultAuthority, PUMP_AMM_PROGRAM_ID, PUMP_EVENT_AUTHORITY, PUMP_GLOBAL, PUMP_PROGRAM_ID } from "./pda";

export { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "./pda";

const PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
const idl = idlJson as unknown as Idl;
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

export const BONDING_CURVE_DISC = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
/**
 * Fallback rent-exempt minimum of a zero-data system account (`collect_creator_fee` leaves the vault
 * rent-exempt). The live value is read from the RPC: it was 890 880 lamports historically and is
 * 650 240 on mainnet since the 2026 rent reduction (observed: a collection left exactly 650 240).
 */
export const PUMP_CREATOR_VAULT_RENT_FLOOR = 890_880n;
/** `SweepBondingCurveFeeEvent.bucket` of the creator fee (0 = protocol fee). */
export const PUMP_SWEEP_BUCKET_CREATOR = 1;

/** Lamports that reached the creator vault outside any pump.fun fee (rent floor, plain transfer). */
export const PUMP_VAULT_TOP_UP = "creator_vault_top_up";

const TRADE_IX = new Map(
  ["buy", "buy_exact_sol_in", "sell", "buy_v2", "buy_exact_quote_in_v2", "sell_v2", "buy_v3", "buy_exact_quote_in_v3", "sell_v3", "multi_hop_curve_swap"].map((n) => [instructionDiscriminator(n).toString("hex"), n]),
);
const COLLECT_CREATOR_FEE_IX = instructionDiscriminator("collect_creator_fee");
const SWEEP_CREATOR_FEE_IX = instructionDiscriminator("sweep_creator_fee");

export interface PumpBondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  /** Zero key on curves created before creator fees existed. */
  creator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** Zero key = SOL. */
  quoteMint: string;
  /** Coin-specific creator fee rate; 0 = the pump-fees schedule applies. */
  creatorFeeBps: bigint;
  isHolderReward: boolean;
  /** Creator fees of _v3 trades not swept to the creator vault yet. */
  creatorFee: bigint;
  protocolFees: bigint;
}

/**
 * Borsh layout of `BondingCurve` (IDL order; the account grew over time and older curves are shorter —
 * absent trailing fields read as zero / false):
 *   0 disc · 8 virtual_token_reserves · 16 virtual_quote_reserves · 24 real_token_reserves ·
 *   32 real_quote_reserves · 40 token_total_supply · 48 complete · 49 creator · 81 is_mayhem_mode ·
 *   82 is_cashback_coin · 83 quote_mint · 115 creator_fee_bps · 123 can_edit_creator_fee ·
 *   124 is_holder_reward · 125 creator_fee · 133 protocol_fees · 141 depth · …166
 */
export function decodePumpBondingCurve(data: Buffer): PumpBondingCurve {
  if (!data.subarray(0, 8).equals(BONDING_CURVE_DISC)) throw new ProviderValidationError("account is not a pump.fun BondingCurve");
  if (data.length < 49) throw new ProviderValidationError(`BondingCurve data too short (${data.length} bytes)`);
  const u64 = (o: number) => (data.length >= o + 8 ? data.readBigUInt64LE(o) : 0n);
  const flag = (o: number) => data.length > o && data[o] === 1;
  const key = (o: number) => (data.length >= o + 32 ? new PublicKey(data.subarray(o, o + 32)).toBase58() : DEFAULT_PUBKEY);
  return {
    virtualTokenReserves: u64(8),
    virtualQuoteReserves: u64(16),
    realTokenReserves: u64(24),
    realQuoteReserves: u64(32),
    tokenTotalSupply: u64(40),
    complete: flag(48),
    creator: key(49),
    isMayhemMode: flag(81),
    isCashbackCoin: flag(82),
    quoteMint: key(83),
    creatorFeeBps: u64(115),
    isHolderReward: flag(124),
    creatorFee: u64(125),
    protocolFees: u64(133),
  };
}

/**
 * Verification of the creator allocation. pump.fun fixes no creator rate in the coin (it comes from
 * the pump-fees schedule and changes with the market cap), so what is declared and checked is the
 * identity that earns it: the curve's `creator` must be the declared creator wallet
 * (EXPECTED_PUMPFUN_CREATOR, default: the configured creator wallet). Holder-reward and cashback coins
 * give the creator fee to someone else and can never be verified.
 */
export function verifyPumpCreator(curve: Pick<PumpBondingCurve, "creator" | "isHolderReward" | "isCashbackCoin">, expected: Pick<ExpectedAllocation, "pumpfunCreator"> | undefined): { verification: AllocationVerification; problems: string[] } {
  if (curve.isHolderReward) return { verification: "unverifiable", problems: ["this is a holder-reward coin: pump.fun pays its creator fee to the coin's holders, not to a creator"] };
  if (curve.isCashbackCoin) return { verification: "unverifiable", problems: ["this is a cashback coin: pump.fun returns its creator fee to the traders, not to a creator"] };
  if (curve.creator === DEFAULT_PUBKEY) return { verification: "unverifiable", problems: ["the bonding curve has no creator (created before pump.fun creator fees)"] };
  const declared = expected?.pumpfunCreator ?? null;
  if (declared === null) return { verification: "not_declared", problems: [] };
  if (declared !== curve.creator) return { verification: "mismatch", problems: [`the coin's creator is ${curve.creator} on-chain but ${declared} was declared`] };
  return { verification: "verified", problems: [] };
}

export class PumpFunProvider implements LaunchProvider {
  readonly id = "pump_fun" as const;
  readonly programId = PUMP_PROGRAM_ID;
  private readonly events = new AnchorEventDecoder(PUMP_PROGRAM_ID, idl);
  private cached: PoolInfo | null = null;
  private curve: PumpBondingCurve | null = null;
  private rentFloor: bigint | null = null;
  /** pump.fun gives the creator no LP at graduation: there is no migrated-LP allocation to declare. */
  readonly lpCheck: { verification: AllocationVerification; problems: string[] } = { verification: "not_declared", problems: [] };

  constructor(
    private readonly rpc: ChainRpc | null,
    private readonly opts: { poolAddress: string; tokenMint: string; role: FeeBeneficiaryRole; payoutMint?: string; expected?: ExpectedAllocation },
  ) {
    if (opts.role !== "creator") throw new ProviderValidationError(`pump.fun pays trading fees to the coin's creator only: the fee role must be "creator" (not "${opts.role}")`);
  }

  hydrate(curve: PumpBondingCurve, mints: { baseDecimals: number; baseTokenProgram: string }, slot = 0, graduated: boolean = curve.complete): PoolInfo {
    this.curve = curve;
    const status: PoolStatus = !curve.complete ? "bonding" : graduated ? "migrated" : "migrating";
    const vault = pumpCreatorVault(curve.creator);
    const check = verifyPumpCreator(curve, this.opts.expected);
    const allocation: AllocationBasis = makeBasis({
      provider: this.id,
      pool: this.opts.poolAddress,
      phase: "bonding_curve",
      role: this.opts.role,
      beneficiary: curve.creator,
      params: { creator: curve.creator, creatorVault: vault, holderReward: curve.isHolderReward, cashback: curve.isCashbackCoin },
      source: `BondingCurve ${this.opts.poolAddress} (creator); per-trade TradeEvent.creator / creator_fee`,
      verification: check.verification,
      problems: check.problems,
    });
    const warnings: string[] = [];
    for (const p of check.problems) warnings.push(`${check.verification === "mismatch" ? "ALLOCATION MISMATCH" : "NOT DISTRIBUTABLE"}: ${p}; creator fees are recorded but NOT eligible for payout`);
    if (check.verification === "not_declared") warnings.push("NOT DECLARED: the coin's creator wallet (EXPECTED_PUMPFUN_CREATOR, or a configured creator wallet) — fees are recorded with the on-chain creator but are NOT distributed until it is declared and verified");
    warnings.push("the pump.fun creator vault is shared by every coin of this creator: other coins' deposits are tracked and excluded, never attributed to this coin");
    const ammVaultAuthority = pumpSwapCreatorVaultAuthority(curve.creator);
    const ammVault = pumpSwapCreatorVaultAta(curve.creator);
    this.cached = {
      provider: this.id,
      programId: this.programId,
      poolAddress: this.opts.poolAddress,
      tokenMint: this.opts.tokenMint,
      // SOL-quoted: fees are native lamports, accounted as the SOL asset (same as wrapped SOL).
      quoteMint: WSOL_MINT,
      baseDecimals: mints.baseDecimals,
      quoteDecimals: 9,
      baseTokenProgram: mints.baseTokenProgram,
      quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      creator: curve.creator,
      feeBeneficiaryRole: this.opts.role,
      beneficiary: curve.creator,
      status,
      feeParams: {
        creatorFeeBps: curve.creatorFeeBps.toString(),
        creatorFeeSource: curve.creatorFeeBps > 0n ? "BondingCurve.creator_fee_bps" : "pump-fees schedule (per trade, in TradeEvent.creator_fee_basis_points)",
        feeRateDenominator: "10000",
        holderReward: curve.isHolderReward,
        cashback: curve.isCashbackCoin,
        mayhemMode: curve.isMayhemMode,
        allocationVerification: allocation.verification,
        migratedLpAllocationVerification: this.lpCheck.verification,
      },
      accounts: {
        global: PUMP_GLOBAL,
        bondingCurve: this.opts.poolAddress,
        creatorVault: vault,
        feeVault: vault,
        pumpSwapPool: canonicalPumpSwapPool(this.opts.tokenMint),
        pumpSwapCreatorVaultAuthority: ammVaultAuthority,
        pumpSwapCreatorVault: ammVault,
      },
      // Claims and sweeps of other coins touch the vault, not the curve, so both must be watched.
      watchAddresses: [this.opts.poolAddress, vault],
      slot,
      warnings,
      allocation,
    };
    return this.cached;
  }

  curveState(): PumpBondingCurve | null {
    return this.curve;
  }

  expectedAllocation(): ExpectedAllocation | undefined {
    return this.opts.expected;
  }

  async load(): Promise<PoolInfo> {
    if (!this.rpc) throw new Error("PumpFunProvider.load requires an RPC client");
    const derived = derivePumpBondingCurve(this.opts.tokenMint);
    if (this.opts.poolAddress !== derived) throw new ProviderValidationError(`Pool ${this.opts.poolAddress} is not the pump.fun bonding curve of TOKEN_MINT ${this.opts.tokenMint} (${derived}); leave the pool address empty`);
    const { slot, value } = await this.rpc.getAccountInfo(this.opts.poolAddress);
    if (!value) throw new AwaitingLaunchError(`bonding curve ${this.opts.poolAddress} does not exist yet (waiting for the launch)`);
    if (value.owner !== PUMP_PROGRAM_ID) throw new ProviderValidationError(`Bonding curve ${this.opts.poolAddress} is owned by ${value.owner}, not pump.fun`);
    const curve = decodePumpBondingCurve(value.data);
    if (curve.quoteMint !== DEFAULT_PUBKEY && curve.quoteMint !== WSOL_MINT) throw new ProviderValidationError(`This pump.fun coin is quoted in ${curve.quoteMint}; only SOL-quoted coins are supported`);
    if (this.opts.payoutMint && this.opts.payoutMint !== WSOL_MINT) throw new ProviderValidationError(`Payout asset ${this.opts.payoutMint} differs from the coin's quote asset (SOL); Asteroid Protocol never converts between assets`);
    const base = await readMint(this.rpc, this.opts.tokenMint);
    let graduated = false;
    if (curve.complete) {
      const pool = await this.rpc.getAccountInfo(canonicalPumpSwapPool(this.opts.tokenMint));
      graduated = !!pool.value && pool.value.owner === PUMP_AMM_PROGRAM_ID;
    }
    return this.hydrate(curve, { baseDecimals: base.decimals, baseTokenProgram: base.program }, slot, graduated);
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
    const basis = info.allocation!;
    const payable = basisPayable(basis);
    const vault = info.accounts.feeVault!;
    const curve = info.poolAddress;
    const tradeParents = new Set<number>();
    // Lamports that THIS coin put into the shared creator vault and that were collected out of it in
    // this transaction: the rest of the vault's balance change came from the creator's other coins.
    let ownVaultDeposits = 0n;
    let collected = 0n;
    let pumpTouchedVault = false;
    let otherCoinPaidVault = false;

    for (const ev of this.events.decodeAll(tx)) {
      const d: any = ev.data;
      const parent = ev.parent;
      if (parent?.accounts.includes(vault)) pumpTouchedVault = true;
      if (ev.name === "TradeEvent") {
        if (toAddr(d.mint) !== info.tokenMint) {
          if (parent?.accounts.includes(vault)) otherCoinPaidVault = true;
          continue;
        }
        if (!parent) {
          out.anomalies.push("pump.fun TradeEvent without a resolvable trade instruction");
          continue;
        }
        const ixName = TRADE_IX.get(parent.data.subarray(0, 8).toString("hex"));
        if (!ixName) {
          out.anomalies.push("pump.fun TradeEvent emitted by an unexpected instruction");
          continue;
        }
        tradeParents.add(parent.ordinal);
        const side = d.is_buy ? "buy" : "sell";
        const solAmount = toBig(d.sol_amount);
        const tokenAmount = toBig(d.token_amount);
        const protocolFee = toBig(d.fee);
        const creatorFee = toBig(d.creator_fee);
        // Fees paid to parties other than the creator inside the creator-fee slot of the trade.
        const holderRewards = toBig(d.holder_rewards ?? 0);
        const cashback = toBig(d.cashback ?? 0);
        const eventCreator = toAddr(d.creator);
        const toCreator = eventCreator === info.beneficiary && holderRewards === 0n && cashback === 0n;
        const totalFee = protocolFee + creatorFee;
        const eligibleFee = toCreator ? creatorFee : 0n;
        // Legacy and _v2 trades carry the creator vault and pay it in the trade; _v3 trades do not
        // (the fee stays on the curve until swept).
        const paidToVault = toCreator && parent.accounts.includes(vault);
        if (paidToVault) ownVaultDeposits += creatorFee;
        const { trader, source } = resolveTrader(tx, toAddr(d.user), info.tokenMint, side);
        const ok = payable && toCreator;
        out.swaps.push({
          signature: tx.signature,
          eventIndex: ev.ordinal,
          side,
          trader,
          traderSource: source,
          quoteAmount: side === "buy" ? solAmount + totalFee : solAmount - totalFee,
          baseAmount: tokenAmount,
          totalFee,
          totalFeeMint: info.quoteMint,
          eligibleFee,
          eligibleFeeMint: info.quoteMint,
          slot: tx.slot,
          blockTime: tx.blockTime,
          feePhase: "bonding_curve",
          excludedFee: totalFee - eligibleFee,
          excludedReason: !toCreator ? (eventCreator !== info.beneficiary ? `creator_fee_paid_to_${eventCreator}` : holderRewards > 0n ? "creator_fee_paid_to_holders" : "creator_fee_returned_as_cashback") : payable ? EXCLUSION.notBeneficiaryShare : `${EXCLUSION.allocationMismatch}: ${basis.problems.join("; ")}`,
          feeStatus: ok ? "observed" : toCreator ? "unresolved" : "observed",
          payoutEligible: ok,
          basisId: basis.id,
          evidence: { event: "TradeEvent", instruction: parent.ordinal, ix: ixName, field: "creator_fee", creator: eventCreator, creatorFeeBps: Number(toBig(d.creator_fee_basis_points)), settledTo: paidToVault ? "creator_vault" : "bonding_curve_bucket", vault },
        } satisfies NormalizedSwap);
      } else if (ev.name === "SweepBondingCurveFeeEvent") {
        // The curve's un-swept creator fees moved into the vault (already attributed per trade).
        if (Number(d.bucket) !== PUMP_SWEEP_BUCKET_CREATOR || toAddr(d.recipient) !== vault) continue;
        if (toAddr(d.bonding_curve) === curve) ownVaultDeposits += toBig(d.amount);
        else otherCoinPaidVault = true;
      } else if (ev.name === "CollectCreatorFeeEvent") {
        const quote = toAddr(d.quote_mint);
        if (toAddr(d.creator) !== info.beneficiary || (quote !== DEFAULT_PUBKEY && quote !== WSOL_MINT)) continue;
        const amount = toBig(d.creator_fee);
        collected += amount;
        if (amount > 0n && parent) {
          out.claims.push({
            signature: tx.signature,
            claimer: info.beneficiary,
            quoteAmount: amount,
            baseAmount: 0n,
            slot: tx.slot,
            blockTime: tx.blockTime,
            index: parent.ordinal,
            evidence: { instruction: parent.ordinal, event: "CollectCreatorFeeEvent", vault, recipient: info.beneficiary, native: true },
          });
        }
      }
    }

    for (const ix of tx.instructions) {
      if (ix.programId !== PUMP_PROGRAM_ID) continue;
      const name = TRADE_IX.get(ix.data.subarray(0, 8).toString("hex"));
      // multi_hop_curve_swap names its curves in remaining accounts and may not trade this coin at all.
      if (name && name !== "multi_hop_curve_swap" && tradesCurve(ix, name, curve) && !tradeParents.has(ix.ordinal)) out.anomalies.push("pump.fun trade instruction on the bonding curve without a TradeEvent");
      if (ix.accounts.includes(vault)) pumpTouchedVault = true;
    }

    // Whatever else reached the shared vault in this transaction: fees of the creator's other coins, or
    // a plain top-up (e.g. the rent floor a sweep's payer funds on a new vault). Both are recorded so
    // that the vault reconciles exactly; neither is ever attributed to this coin.
    const delta = lamportDelta(tx, vault);
    if (delta !== null && (pumpTouchedVault || delta !== 0n)) {
      const foreign = delta + collected - ownVaultDeposits;
      if (foreign > 0n) {
        out.attributions!.push({
          key: `vault-inflow:${tx.signature}:${vault}`,
          kind: "shared_vault_inflow",
          phase: "bonding_curve",
          provider: this.id,
          sourcePool: curve,
          destinationPool: null,
          beneficiary: info.beneficiary,
          feeMint: info.quoteMint,
          grossAmount: foreign,
          creatorAmount: 0n,
          excludedAmount: foreign,
          excludedReason: otherCoinPaidVault ? EXCLUSION.otherPoolSharedVault : PUMP_VAULT_TOP_UP,
          signature: tx.signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          evidence: { vault, vaultLamportDelta: delta.toString(), thisCoinDeposits: ownVaultDeposits.toString(), collected: collected.toString() },
          status: "observed",
          payoutEligible: false,
          basisId: basis.id,
        } satisfies NormalizedAttribution);
      } else if (foreign < 0n) {
        out.anomalies.push(`pump.fun ${tx.signature.slice(0, 8)}…: creator vault changed by ${delta} but this coin's events account for ${ownVaultDeposits - collected}`);
      }
    }
    return out;
  }

  /** Rent-exempt minimum of the (zero-data) creator vault, which every collection leaves behind. */
  private async vaultRentFloor(): Promise<bigint> {
    if (this.rentFloor === null) {
      try {
        this.rentFloor = BigInt(await this.rpc!.getMinimumBalanceForRentExemption(0));
      } catch {
        return PUMP_CREATOR_VAULT_RENT_FLOOR; // conservative (the historical, higher floor); retried next time
      }
    }
    return this.rentFloor;
  }

  private async readState(): Promise<{ slot: number; vaultLamports: bigint; bucket: bigint; claimable: bigint }> {
    if (!this.rpc) throw new Error("RPC required");
    const info = this.info();
    const r = await this.rpc.getMultipleAccounts([info.accounts.feeVault!, info.poolAddress]);
    const vaultLamports = BigInt(r.value[0]?.lamports ?? 0);
    const curveAcc = r.value[1];
    const bucket = curveAcc && curveAcc.owner === PUMP_PROGRAM_ID ? decodePumpBondingCurve(curveAcc.data).creatorFee : 0n;
    const floor = await this.vaultRentFloor();
    // After a sweep the vault holds its balance plus the bucket; a collection pays what exceeds the floor.
    const total = vaultLamports + bucket;
    return { slot: r.slot, vaultLamports, bucket, claimable: total > floor ? total - floor : 0n };
  }

  /**
   * Everything the chain holds for the creator and not collected yet: the vault's lamports plus this
   * curve's un-swept creator fees. The vault's rent floor stays behind at every collection, so
   * `claimableQuote` (what a claim would pay now) is lower than the balance that is reconciled.
   */
  async getFeeSourceState(): Promise<FeeSourceState> {
    const s = await this.readState();
    return {
      slot: s.slot,
      unclaimedQuote: s.vaultLamports + s.bucket,
      claimableQuote: s.claimable,
      unclaimedBase: 0n,
      mayIncludeOtherPools: true,
      source: 'creator vault ["creator-vault", creator] lamports + BondingCurve.creator_fee (un-swept)',
    };
  }

  /** `sweep_creator_fee`: moves the curve's un-swept creator fees into the creator vault (permissionless). */
  sweepInstruction(payer: PublicKey): TransactionInstruction {
    const info = this.info();
    const k = (pubkey: PublicKey | string, isWritable = false, isSigner = false) => ({ pubkey: typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey, isWritable, isSigner });
    const wsol = new PublicKey(WSOL_MINT);
    const ata = (owner: string) => getAssociatedTokenAddressSync(wsol, new PublicKey(owner), true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const vault = info.accounts.feeVault!;
    return new TransactionInstruction({
      programId: PROGRAM,
      data: SWEEP_CREATOR_FEE_IX,
      keys: [k(payer, true, true), k(PUMP_GLOBAL), k(info.tokenMint), k(wsol), k(TOKEN_PROGRAM_ID), k(ASSOCIATED_TOKEN_PROGRAM_ID), k(SystemProgram.programId), k(info.poolAddress, true), k(ata(info.poolAddress), true), k(vault, true), k(ata(vault), true), k(PUMP_EVENT_AUTHORITY), k(PROGRAM)],
    });
  }

  /** `collect_creator_fee`: pays the creator vault (above its rent floor) to the creator, in native SOL. */
  collectInstruction(): TransactionInstruction {
    const info = this.info();
    const k = (pubkey: PublicKey | string, isWritable = false) => ({ pubkey: typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey, isWritable, isSigner: false });
    return new TransactionInstruction({ programId: PROGRAM, data: COLLECT_CREATOR_FEE_IX, keys: [k(info.beneficiary, true), k(info.accounts.feeVault!, true), k(SystemProgram.programId), k(PUMP_EVENT_AUTHORITY), k(PROGRAM)] });
  }

  /**
   * Sweep (when the curve holds un-swept fees) + `collect_creator_fee`. The program pays the creator
   * wallet itself, in native SOL; when the payout destination is another wallet, the amount claimable
   * at build time is forwarded in the same transaction (fees of trades landing in between stay in the
   * creator wallet until the next claim is forwarded by hand).
   */
  async buildClaimInstructions(claimer: PublicKey, destination: PublicKey): Promise<ClaimPlan> {
    const info = this.info();
    if (claimer.toBase58() !== info.beneficiary) throw new ProviderValidationError(`Claim signer ${claimer.toBase58()} is not the coin's creator (${info.beneficiary})`);
    const s = await this.readState();
    const ixs: TransactionInstruction[] = [];
    if (s.bucket > 0n) ixs.push(this.sweepInstruction(claimer));
    ixs.push(this.collectInstruction());
    if (!destination.equals(claimer) && s.claimable > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: claimer, toPubkey: destination, lamports: s.claimable }));
    return { instructions: ixs, signer: claimer, description: `pump.fun ${s.bucket > 0n ? "sweep_creator_fee + " : ""}collect_creator_fee → ${destination.toBase58()}` };
  }
}

/** Index of the bonding curve in each trade instruction's accounts (IDL). */
const CURVE_INDEX: Record<string, number> = { buy: 3, buy_exact_sol_in: 3, sell: 3, buy_v2: 10, buy_exact_quote_in_v2: 10, sell_v2: 10, buy_v3: 5, buy_exact_quote_in_v3: 5, sell_v3: 5 };
function tradesCurve(ix: FlatInstruction, name: string, curve: string): boolean {
  const i = CURVE_INDEX[name];
  return i !== undefined && ix.accounts[i] === curve;
}

/** Net lamport change of an account over the transaction (null when it is not part of it). */
export function lamportDelta(tx: NormalizedTx, account: string): bigint | null {
  const i = tx.accountKeys.indexOf(account);
  if (i < 0 || tx.preBalances[i] === undefined || tx.postBalances[i] === undefined) return null;
  return tx.postBalances[i]! - tx.preBalances[i]!;
}
