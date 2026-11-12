/**
 * PumpSwap destination adapter (pump.fun → PumpSwap graduations; program `pump_amm`,
 * pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA).
 *
 * Built from the official IDL (@pump-fun/pump-swap-sdk 2.2.0, vendored in ./idl) and verified on
 * mainnet transactions and accounts (test/fixtures/mainnet/pumpfun-*.json):
 *   - buy / buy_exact_quote_in / sell, their _v2 forms and the hops of multi_hop_swap emit ONE
 *     `BuyEvent` / `SellEvent` through a self-CPI, naming the pool, the trader (`user`), the pool's
 *     `coin_creator` and the exact `coin_creator_fee` of the trade (quote token).
 *   - A buyer pays `user_quote_amount_in` (LP + protocol + creator fees included); a seller receives
 *     `user_quote_amount_out` (after them).
 *   - Unlike Raydium CPMM, the creator fee is final at the trade: nothing is withheld at collection.
 *       legacy trades   pay it into the coin creator vault — the quote-token account of the PDA
 *                       ["creator_vault", coin_creator] — in the trade;
 *       _v2 trades      leave it in the pool (`Pool.creator_fees`) until the permissionless
 *                       `sweep_creator_fee` moves it to the same vault (`SweepPoolFeeEvent`, bucket 1).
 *   - The vault is keyed by the CREATOR: all graduated coins of one creator share it. Each trade is
 *     attributed from its own event; other coins' deposits are recorded and excluded.
 *   - `collect_coin_creator_fee` pays the whole vault to the creator's quote-token account and emits
 *     `CollectCoinCreatorFeeEvent`. It is permissionless and always pays the creator's own account.
 *   - The creator receives NO liquidity at graduation (the LP is burned): there is no migrated-LP stream.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Idl } from "@coral-xyz/anchor";
import { WSOL_MINT } from "@last60/shared";
import idlJson from "./idl/pump_amm.json";
import { AnchorEventDecoder, instructionDiscriminator, toAddr, toBig } from "../../chain/anchorEvents";
import { tokenAccountDelta, type NormalizedTx } from "../../chain/tx";
import type { ChainRpc } from "../../chain/rpc";
import { basisPayable, EXCLUSION, type AllocationBasis, type NormalizedAttribution } from "../../accounting/attribution";
import { resolveTrader, type NormalizedSwap, type ParsedTransaction } from "../LaunchProvider";
import { pumpSwapCreatorVaultAta, pumpSwapCreatorVaultAuthority, PUMP_AMM_EVENT_AUTHORITY, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_PROGRAM_ID } from "../pumpfun/pda";
import type { DestinationAdapter, DestinationContext } from "./types";

const idl = idlJson as unknown as Idl;
const PROGRAM = new PublicKey(PUMP_AMM_PROGRAM_ID);
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const PUMP_SWAP_POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
/** `SweepPoolFeeEvent.bucket` of the creator fee (0 = protocol fee). */
export const PUMP_SWAP_SWEEP_BUCKET_CREATOR = 1;

const TRADE_IX = new Map(["buy", "buy_exact_quote_in", "sell", "buy_v2", "buy_exact_quote_in_v2", "sell_v2", "multi_hop_swap"].map((n) => [instructionDiscriminator(n).toString("hex"), n]));
const COLLECT_IX = instructionDiscriminator("collect_coin_creator_fee");
const SWEEP_IX = instructionDiscriminator("sweep_creator_fee");

export interface PumpSwapPool {
  index: number;
  /** Who created the pool: the coin's pump.fun pool authority for a graduation. */
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  /** Zero key on pools created before coin creator fees existed. */
  coinCreator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  isHolderReward: boolean;
  /** Creator fees of _v2 trades not swept to the coin creator vault yet. */
  creatorFees: bigint;
}

/**
 * Borsh layout of `Pool` (IDL order; older pools are shorter — absent trailing fields read as zero):
 *   0 disc · 8 pool_bump · 9 index (u16) · 11 creator · 43 base_mint · 75 quote_mint · 107 lp_mint ·
 *   139 pool_base_token_account · 171 pool_quote_token_account · 203 lp_supply · 211 coin_creator ·
 *   243 is_mayhem_mode · 244 is_cashback_coin · 245 virtual_quote_reserves (i128) · 261 creator_fee_bps ·
 *   269 can_edit_creator_fee · 270 is_holder_reward · 271 protocol_fees · 279 creator_fees
 */
export function decodePumpSwapPool(data: Buffer): PumpSwapPool {
  if (!data.subarray(0, 8).equals(PUMP_SWAP_POOL_DISC)) throw new Error("account is not a PumpSwap Pool");
  if (data.length < 211) throw new Error(`PumpSwap Pool data too short (${data.length} bytes)`);
  const key = (o: number) => (data.length >= o + 32 ? new PublicKey(data.subarray(o, o + 32)).toBase58() : DEFAULT_PUBKEY);
  const flag = (o: number) => data.length > o && data[o] === 1;
  return {
    index: data.readUInt16LE(9),
    creator: key(11),
    baseMint: key(43),
    quoteMint: key(75),
    lpMint: key(107),
    poolBaseTokenAccount: key(139),
    poolQuoteTokenAccount: key(171),
    coinCreator: key(211),
    isMayhemMode: flag(243),
    isCashbackCoin: flag(244),
    isHolderReward: flag(270),
    creatorFees: data.length >= 287 ? data.readBigUInt64LE(279) : 0n,
  };
}

export interface PumpSwapPoolFacts {
  baseMint: string;
  quoteMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  /** `Pool.coin_creator` when the migration was verified (each trade still names its own). */
  coinCreator: string;
  /** Token program of the quote mint (SPL Token for WSOL). */
  quoteTokenProgram: string;
}

export interface PumpSwapClaimState {
  slot: number;
  /** Quote tokens in the beneficiary's coin creator vault (all their graduated coins). */
  vaultBalance: bigint;
  vaultExists: boolean;
  /** This pool's un-swept creator fees, when the pool still pays the beneficiary. */
  poolBucket: bigint;
  coinCreator: string | null;
}

export class PumpSwapDestination implements DestinationAdapter {
  readonly kind = "pumpfun_pumpswap" as const;
  readonly program = PUMP_AMM_PROGRAM_ID;
  private readonly events = new AnchorEventDecoder(PUMP_AMM_PROGRAM_ID, idl);
  readonly vaultAuthority: string;
  /** The beneficiary's coin creator vault for the pool's quote token. */
  readonly vault: string;

  constructor(
    private readonly rpc: ChainRpc | null,
    readonly pool: string,
    readonly facts: PumpSwapPoolFacts,
    private readonly ctx: DestinationContext,
    /** Basis of the PumpSwap creator-fee entitlement (coin_creator == beneficiary). */
    readonly allocation: AllocationBasis,
  ) {
    this.vaultAuthority = pumpSwapCreatorVaultAuthority(ctx.beneficiary);
    this.vault = pumpSwapCreatorVaultAta(ctx.beneficiary, facts.quoteMint, facts.quoteTokenProgram || TOKEN_PROGRAM);
  }

  get migrationSlot() {
    return this.ctx.migrationSlot;
  }
  get migrationSignature() {
    return this.ctx.migrationSignature;
  }

  /** The pool sees every trade and pool sweep; the vault sees collections and the creator's other coins. */
  watchAddresses(): string[] {
    return [this.pool, this.vault];
  }

  parse(tx: NormalizedTx): ParsedTransaction {
    const out: ParsedTransaction = { swaps: [], claims: [], anomalies: [], attributions: [] };
    if (tx.err) return out;
    // The beneficiary's vault also serves coins that graduated earlier: only this pool is bounded by its migration.
    const afterMigration = tx.slot >= this.ctx.migrationSlot;
    const payable = basisPayable(this.allocation);
    let ownVaultDeposits = 0n;
    let collected = 0n;
    let otherPoolPaidVault = false;
    let sawCollect = false;

    for (const ev of this.events.decodeAll(tx)) {
      const d: any = ev.data;
      const parent = ev.parent;
      if (ev.name === "BuyEvent" || ev.name === "SellEvent") {
        if (toAddr(d.pool) !== this.pool) {
          if (parent?.accounts.includes(this.vault)) otherPoolPaidVault = true;
          continue;
        }
        if (!afterMigration) {
          out.anomalies.push(`PumpSwap activity at slot ${tx.slot} precedes the verified migration slot ${this.ctx.migrationSlot}`);
          continue;
        }
        const ixName = parent ? TRADE_IX.get(parent.data.subarray(0, 8).toString("hex")) : undefined;
        if (!parent || !ixName) {
          out.anomalies.push(`PumpSwap ${ev.name} ${parent ? "emitted by an unexpected instruction" : "without a resolvable trade instruction"}`);
          continue;
        }
        const side = ev.name === "BuyEvent" ? "buy" : "sell";
        const lpFee = toBig(d.lp_fee);
        const protocolFee = toBig(d.protocol_fee);
        const creatorFee = toBig(d.coin_creator_fee);
        const holderRewards = toBig(d.holder_rewards ?? 0);
        const cashback = toBig(d.cashback ?? 0);
        const coinCreator = toAddr(d.coin_creator);
        const toCreator = coinCreator === this.ctx.beneficiary && holderRewards === 0n && cashback === 0n;
        const totalFee = lpFee + protocolFee + creatorFee;
        const eligibleFee = toCreator ? creatorFee : 0n;
        const paidToVault = toCreator && parent.accounts.includes(this.vault);
        if (paidToVault) ownVaultDeposits += creatorFee;
        const { trader, source } = resolveTrader(tx, toAddr(d.user), this.ctx.baseMint, side);
        const ok = payable && toCreator;
        out.swaps.push({
          signature: tx.signature,
          eventIndex: ev.ordinal,
          pool: this.pool,
          side,
          trader,
          traderSource: source,
          quoteAmount: side === "buy" ? toBig(d.user_quote_amount_in) : toBig(d.user_quote_amount_out),
          baseAmount: side === "buy" ? toBig(d.base_amount_out) : toBig(d.base_amount_in),
          totalFee,
          totalFeeMint: this.facts.quoteMint,
          eligibleFee,
          eligibleFeeMint: this.facts.quoteMint,
          slot: tx.slot,
          blockTime: tx.blockTime,
          feePhase: "post_migration_trading",
          excludedFee: totalFee - eligibleFee,
          excludedReason: !toCreator ? (coinCreator !== this.ctx.beneficiary ? `creator_fee_paid_to_${coinCreator}` : holderRewards > 0n ? "creator_fee_paid_to_holders" : "creator_fee_returned_as_cashback") : payable ? EXCLUSION.notBeneficiaryShare : `${EXCLUSION.allocationMismatch}: ${this.allocation.problems.join("; ")}`,
          feeStatus: ok ? "observed" : toCreator ? "unresolved" : "observed",
          payoutEligible: ok,
          basisId: this.allocation.id,
          evidence: { event: ev.name, instruction: parent.ordinal, ix: ixName, field: "coin_creator_fee", coinCreator, creatorFeeBps: Number(toBig(d.coin_creator_fee_basis_points)), settledTo: paidToVault ? "coin_creator_vault" : "pool_bucket", vault: this.vault },
        } satisfies NormalizedSwap);
      } else if (ev.name === "SweepPoolFeeEvent") {
        if (Number(d.bucket) !== PUMP_SWAP_SWEEP_BUCKET_CREATOR || toAddr(d.recipient) !== this.vaultAuthority || toAddr(d.quote_mint) !== this.facts.quoteMint) continue;
        if (toAddr(d.pool) === this.pool) ownVaultDeposits += toBig(d.amount);
        else otherPoolPaidVault = true;
      } else if (ev.name === "CollectCoinCreatorFeeEvent") {
        if (toAddr(d.coin_creator) !== this.ctx.beneficiary || toAddr(d.coin_creator_vault_ata) !== this.vault) continue;
        sawCollect = true;
        const amount = toBig(d.coin_creator_fee);
        collected += amount;
        if (amount > 0n && parent) {
          out.claims.push({
            signature: tx.signature,
            claimer: this.ctx.beneficiary,
            quoteAmount: amount,
            baseAmount: 0n,
            slot: tx.slot,
            blockTime: tx.blockTime,
            pool: this.pool,
            index: parent.ordinal,
            evidence: { instruction: parent.ordinal, event: "CollectCoinCreatorFeeEvent", vault: this.vault, recipientAccount: toAddr(d.coin_creator_token_account) },
          });
        }
      }
    }

    // Other graduated coins of the same creator (or a plain transfer) into the shared vault: recorded
    // and excluded, so that a collection can be told apart from this pool's own fees.
    const touched = tx.preTokenBalances.some((b) => b.account === this.vault) || tx.postTokenBalances.some((b) => b.account === this.vault);
    if (touched) {
      const delta = tokenAccountDelta(tx, this.vault);
      const foreign = delta + collected - ownVaultDeposits;
      if (foreign > 0n) {
        out.attributions!.push({
          key: `vault-inflow:${tx.signature}:${this.vault}`,
          kind: "shared_vault_inflow",
          phase: "post_migration_trading",
          provider: this.ctx.sourceProvider,
          sourcePool: this.ctx.sourcePool,
          destinationPool: this.pool,
          beneficiary: this.ctx.beneficiary,
          feeMint: this.facts.quoteMint,
          grossAmount: foreign,
          creatorAmount: 0n,
          excludedAmount: foreign,
          excludedReason: otherPoolPaidVault ? EXCLUSION.otherPoolSharedVault : "creator_vault_top_up",
          signature: tx.signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          evidence: { vault: this.vault, vaultDelta: delta.toString(), thisPoolDeposits: ownVaultDeposits.toString(), collected: collected.toString() },
          status: "observed",
          payoutEligible: false,
          basisId: this.allocation.id,
        } satisfies NormalizedAttribution);
      } else if (foreign < 0n && !sawCollect) {
        out.anomalies.push(`PumpSwap ${tx.signature.slice(0, 8)}…: coin creator vault changed by ${delta} but this pool's events account for ${ownVaultDeposits - collected}`);
      }
    }
    return out;
  }

  /** What the beneficiary could collect from PumpSwap right now (vault balance + this pool's un-swept fees). */
  async claimState(holder: string): Promise<PumpSwapClaimState | null> {
    if (!this.rpc || holder !== this.ctx.beneficiary) return null;
    const r = await this.rpc.getMultipleAccounts([this.vault, this.pool], "confirmed");
    const vaultAcc = r.value[0];
    const poolAcc = r.value[1];
    // SPL token account: amount (u64) at byte 64.
    const vaultBalance = vaultAcc && vaultAcc.data.length >= 72 ? vaultAcc.data.readBigUInt64LE(64) : 0n;
    let poolBucket = 0n;
    let coinCreator: string | null = null;
    if (poolAcc && poolAcc.owner === PUMP_AMM_PROGRAM_ID && poolAcc.data.subarray(0, 8).equals(PUMP_SWAP_POOL_DISC)) {
      const p = decodePumpSwapPool(poolAcc.data);
      coinCreator = p.coinCreator;
      if (p.coinCreator === holder) poolBucket = p.creatorFees;
    }
    return { slot: r.slot, vaultBalance, vaultExists: !!vaultAcc, poolBucket, coinCreator };
  }

  /**
   * pump_amm `sweep_creator_fee` (when this pool holds un-swept fees of the claimer) and
   * `collect_coin_creator_fee` into the claimer's quote-token account; a WSOL account is then closed
   * so the fees arrive as native SOL at `destination`.
   */
  async buildClaimInstructions(claimer: PublicKey, destination: PublicKey): Promise<{ instructions: TransactionInstruction[]; claimable: bigint; state: PumpSwapClaimState | null }> {
    const state = await this.claimState(claimer.toBase58());
    const claimable = state ? state.vaultBalance + state.poolBucket : 0n;
    if (!state || claimable === 0n) return { instructions: [], claimable: 0n, state };
    const quoteMint = new PublicKey(this.facts.quoteMint);
    const quoteProgram = new PublicKey(this.facts.quoteTokenProgram || TOKEN_PROGRAM);
    const recipient = getAssociatedTokenAddressSync(quoteMint, claimer, true, quoteProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    const k = (pubkey: PublicKey | string, isWritable = false, isSigner = false) => ({ pubkey: typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey, isWritable, isSigner });
    const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(claimer, recipient, claimer, quoteMint, quoteProgram)];
    if (state.poolBucket > 0n) {
      ixs.push(
        new TransactionInstruction({
          programId: PROGRAM,
          data: SWEEP_IX,
          keys: [k(claimer, true, true), k(PUMP_AMM_GLOBAL_CONFIG), k(this.pool, true), k(quoteMint), k(quoteProgram), k(this.facts.poolQuoteTokenAccount, true), k(this.vaultAuthority), k(this.vault, true), k(SystemProgram.programId), k(ASSOCIATED_TOKEN_PROGRAM_ID), k(PUMP_AMM_EVENT_AUTHORITY), k(PROGRAM)],
        }),
      );
    }
    ixs.push(new TransactionInstruction({ programId: PROGRAM, data: COLLECT_IX, keys: [k(quoteMint), k(quoteProgram), k(claimer), k(this.vaultAuthority), k(this.vault, true), k(recipient, true), k(PUMP_AMM_EVENT_AUTHORITY), k(PROGRAM)] }));
    if (this.facts.quoteMint === WSOL_MINT) ixs.push(createCloseAccountInstruction(recipient, destination, claimer, [], quoteProgram));
    return { instructions: ixs, claimable, state };
  }
}
