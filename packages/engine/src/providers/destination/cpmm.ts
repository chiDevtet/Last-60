/**
 * Raydium CPMM destination adapter (LaunchLab → CPMM graduations).
 *
 * Verified against raydium-cp-swap source, the published IDL (raydium_cp_swap 0.2.0), the Raydium SDK
 * and real mainnet accounts/transactions (test/fixtures/mainnet/destination-cpmm.json):
 *   - swap_base_input / swap_base_output (accounts: 0 payer … 3 pool_state, 4/5 user in/out,
 *     6/7 vault in/out, 10/11 mint in/out) emit `SwapEvent` through the LOG (emit!), with
 *     trade_fee (LP + protocol + fund) and creator_fee (accrued to the pool creator).
 *   - The creator fee accrues in pool_state.creator_fees_token_{0,1} and is settled at COLLECTION:
 *     the protocol keeps ⌊accrued × creator_fee_share_rate / 1e6⌋ (AmmConfig or a per-creator
 *     override), the rest is transferred to the pool creator's token accounts. Because the share is
 *     decided only at collection, per-swap accruals are recorded as `estimated` and are NEVER paid;
 *     the payable amount is the exact transfer observed in the collection instruction.
 *   - LaunchLab locks the migrated LP in the Raydium LP-lock program per platform/creator scale; the
 *     holder of the fee-key NFT collects that LP's fees with `collect_cp_fees`. Only collections from
 *     the lock minted to the beneficiary at migration, signed by the beneficiary, are attributed.
 *     LP principal stays locked (it is never part of a collection).
 * Raydium AMM v4 has no creator fee and is not supported (see migration.ts).
 */
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import idlJson from "./idl/raydium_cp_swap.json";
import { instructionDiscriminator, toAddr, toBig } from "../../chain/anchorEvents";
import { programDataLogs, subtreeTransfers, tokenAccountInfo, type FlatInstruction, type NormalizedTx } from "../../chain/tx";
import { basisPayable, EXCLUSION, type AllocationBasis, type NormalizedAttribution } from "../../accounting/attribution";
import { resolveTrader, type NormalizedSwap, type ParsedTransaction } from "../LaunchProvider";
import { COLLECT_CP_FEES_DISC, RAYDIUM_CP_LOCK_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID } from "../migration";
import type { DestinationAdapter, DestinationContext } from "./types";

const idl = idlJson as unknown as Idl;
const SWAP_IX = new Set(["swap_base_input", "swap_base_output"].map((n) => instructionDiscriminator(n).toString("hex")));
const COLLECT_CREATOR = instructionDiscriminator("collect_creator_fee").toString("hex");
const COLLECT_CREATOR_PERMISSIONLESS = instructionDiscriminator("collect_creator_fee_permissionless").toString("hex");

export interface CpmmPoolFacts {
  token0Mint: string;
  token1Mint: string;
  token0Vault: string;
  token1Vault: string;
  poolCreator: string;
  enableCreatorFee: boolean;
  /** Locks minted to the beneficiary at migration (fee-key NFTs). */
  beneficiaryLocks: { lockPda: string; nftMint: string }[];
}

export class CpmmDestination implements DestinationAdapter {
  readonly kind = "launchlab_cpmm" as const;
  readonly program = RAYDIUM_CPMM_PROGRAM_ID;
  private readonly coder = new BorshCoder(idl);

  constructor(
    readonly pool: string,
    private readonly facts: CpmmPoolFacts,
    private readonly ctx: DestinationContext,
    /** Basis of the CPMM creator-fee entitlement (pool_creator == beneficiary). */
    readonly allocation: AllocationBasis,
    /** Basis of the locked-LP entitlement (creator_scale lock). */
    private readonly lpAllocation: AllocationBasis,
  ) {}

  get migrationSlot() {
    return this.ctx.migrationSlot;
  }
  get migrationSignature() {
    return this.ctx.migrationSignature;
  }

  watchAddresses(): string[] {
    return [this.pool];
  }

  private vaultMint(vault: string): string | null {
    return vault === this.facts.token0Vault ? this.facts.token0Mint : vault === this.facts.token1Vault ? this.facts.token1Mint : null;
  }

  parse(tx: NormalizedTx): ParsedTransaction {
    const out: ParsedTransaction = { swaps: [], claims: [], anomalies: [], attributions: [] };
    if (tx.err) return out;
    if (tx.slot < this.ctx.migrationSlot) {
      out.anomalies.push(`CPMM activity at slot ${tx.slot} precedes the verified migration slot ${this.ctx.migrationSlot}`);
      return out;
    }
    // Log events of THIS pool, in execution order, to pair with this pool's swap instructions.
    const logs = programDataLogs(tx, RAYDIUM_CPMM_PROGRAM_ID);
    const events: any[] = [];
    for (const d of logs.data) {
      try {
        const e = this.coder.events.decode(d.toString("base64"));
        if (e?.name === "SwapEvent" && toAddr((e.data as any).pool_id) === this.pool) events.push(e.data);
      } catch {
        /* not an event of this IDL */
      }
    }
    const swapIxs = tx.instructions.filter((ix) => ix.programId === RAYDIUM_CPMM_PROGRAM_ID && SWAP_IX.has(ix.data.subarray(0, 8).toString("hex")) && ix.accounts[3] === this.pool);
    const paired = swapIxs.length === events.length;
    if (swapIxs.length && !paired) out.anomalies.push(`CPMM ${tx.signature.slice(0, 8)}…: ${swapIxs.length} swap instruction(s) but ${events.length} SwapEvent log(s)${logs.truncated ? " (log truncated)" : ""}; fee details unresolved`);
    swapIxs.forEach((ix, i) => {
      const s = this.swap(tx, ix, paired ? events[i] : null, i);
      if (s) out.swaps.push(s);
      else out.anomalies.push(`CPMM swap ${tx.signature.slice(0, 8)}… could not be decoded from its transfers`);
    });

    for (const ix of tx.instructions) {
      const disc = ix.data.subarray(0, 8).toString("hex");
      if (ix.programId === RAYDIUM_CPMM_PROGRAM_ID && (disc === COLLECT_CREATOR || disc === COLLECT_CREATOR_PERMISSIONLESS)) {
        const poolIdx = disc === COLLECT_CREATOR ? 2 : 3;
        if (ix.accounts[poolIdx] !== this.pool) continue;
        out.attributions!.push(...this.creatorCollection(tx, ix));
      } else if (ix.programId === RAYDIUM_CP_LOCK_PROGRAM_ID && ix.data.subarray(0, 8).equals(COLLECT_CP_FEES_DISC) && ix.accounts[6] === this.pool) {
        out.attributions!.push(...this.lockCollection(tx, ix));
      }
    }
    return out;
  }

  /** Buyer tracking from the instruction's own transfers; fees from the paired SwapEvent. */
  private swap(tx: NormalizedTx, ix: FlatInstruction, ev: any | null, ordinalInTx: number): NormalizedSwap | null {
    const a = ix.accounts;
    const inputMint = a[10]!;
    const side = inputMint === this.ctx.quoteMint ? "buy" : "sell";
    const transfers = subtreeTransfers(tx, ix);
    const paidIn = transfers.filter((t) => t.source === a[4] && t.destination === a[6]).reduce((s, t) => s + t.amount, 0n);
    const gotOut = transfers.filter((t) => t.source === a[7] && t.destination === a[5]).reduce((s, t) => s + t.amount, 0n);
    if (paidIn === 0n || gotOut === 0n) return null;
    const tradeFee = ev ? toBig(ev.trade_fee) : null;
    const creatorFee = ev ? toBig(ev.creator_fee) : null;
    const total = tradeFee !== null && creatorFee !== null ? tradeFee + creatorFee : 0n;
    const feeMint = ev ? (ev.creator_fee_on_input ? inputMint : a[11]!) : inputMint;
    const creatorIsBeneficiary = this.facts.poolCreator === this.ctx.beneficiary && this.facts.enableCreatorFee;
    const { trader, source } = resolveTrader(tx, a[0], this.ctx.baseMint, side);
    return {
      signature: tx.signature,
      eventIndex: ix.ordinal,
      pool: this.pool,
      side,
      trader,
      traderSource: source,
      quoteAmount: side === "buy" ? paidIn : gotOut,
      baseAmount: side === "buy" ? gotOut : paidIn,
      totalFee: total,
      totalFeeMint: feeMint,
      eligibleFee: 0n,
      eligibleFeeMint: feeMint,
      slot: tx.slot,
      blockTime: tx.blockTime,
      feePhase: "post_migration_trading",
      excludedFee: total,
      // trade_fee goes to LPs / protocol / fund; the creator fee is only final at collection.
      excludedReason: ev ? EXCLUSION.creatorFeeViaCollection : "swap event unavailable",
      feeStatus: ev ? "observed" : "unresolved",
      payoutEligible: true,
      basisId: this.allocation.id,
      estimatedCreatorFee: creatorIsBeneficiary && creatorFee !== null ? creatorFee : null,
      evidence: { instruction: ix.ordinal, swapInTx: ordinalInTx, event: ev ? "SwapEvent(log)" : null, tradeFee: tradeFee?.toString() ?? null, creatorFeeAccrued: creatorFee?.toString() ?? null },
    };
  }

  private record(tx: NormalizedTx, ix: FlatInstruction, kind: NormalizedAttribution["kind"], phase: NormalizedAttribution["phase"], mint: string, amount: bigint, eligible: boolean, reason: string | null, basis: AllocationBasis, evidence: Record<string, string | number | boolean | null>): NormalizedAttribution {
    return {
      key: `${kind}:${tx.signature}:${ix.ordinal}:${mint}`,
      kind,
      phase,
      provider: this.ctx.sourceProvider,
      sourcePool: this.ctx.sourcePool,
      destinationPool: this.pool,
      beneficiary: this.ctx.beneficiary,
      feeMint: mint,
      grossAmount: null,
      creatorAmount: eligible || reason?.startsWith(EXCLUSION.allocationMismatch) ? amount : 0n,
      excludedAmount: eligible || reason?.startsWith(EXCLUSION.allocationMismatch) ? 0n : amount,
      excludedReason: reason,
      signature: tx.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      evidence,
      status: eligible ? "collected" : reason?.startsWith(EXCLUSION.allocationMismatch) ? "unresolved" : "collected",
      payoutEligible: eligible,
      basisId: basis.id,
    };
  }

  /** collect_creator_fee(_permissionless): exact transfers from the pool vaults to the creator. */
  private creatorCollection(tx: NormalizedTx, ix: FlatInstruction): NormalizedAttribution[] {
    const out: NormalizedAttribution[] = [];
    for (const t of subtreeTransfers(tx, ix)) {
      const mint = this.vaultMint(t.source);
      if (!mint || t.amount === 0n) continue;
      const recipient = tokenAccountInfo(tx, t.destination)?.owner ?? null;
      const toBeneficiary = recipient === this.ctx.beneficiary && this.facts.poolCreator === this.ctx.beneficiary;
      const payable = basisPayable(this.allocation);
      const reason = !toBeneficiary ? EXCLUSION.cpmmCreatorNotBeneficiary : payable ? null : `${EXCLUSION.allocationMismatch}: ${this.allocation.problems.join("; ")}`;
      out.push(this.record(tx, ix, "creator_fee_collection", "post_migration_trading", mint, t.amount, toBeneficiary && payable, reason, this.allocation, { instruction: ix.ordinal, transfer: t.ordinal, from: t.source, to: t.destination, recipient, poolCreator: this.facts.poolCreator, note: "net of the protocol creator_fee_share retained at collection" }));
    }
    return out;
  }

  /** collect_cp_fees on the LP-lock program: LP fees of a locked position paid to the fee-key holder. */
  private lockCollection(tx: NormalizedTx, ix: FlatInstruction): NormalizedAttribution[] {
    const out: NormalizedAttribution[] = [];
    const lockPda = ix.accounts[3]!;
    const signer = ix.accounts[1]!;
    const isBeneficiaryLock = this.facts.beneficiaryLocks.some((l) => l.lockPda === lockPda);
    for (const t of subtreeTransfers(tx, ix)) {
      const mint = this.vaultMint(t.source);
      if (!mint || t.amount === 0n) continue;
      const recipient = tokenAccountInfo(tx, t.destination)?.owner ?? null;
      const ok = isBeneficiaryLock && signer === this.ctx.beneficiary && recipient === this.ctx.beneficiary;
      const payable = basisPayable(this.lpAllocation);
      const reason = !isBeneficiaryLock ? "lock_not_minted_to_beneficiary_at_migration" : !ok ? EXCLUSION.positionNotHeldByBeneficiary : payable ? null : `${EXCLUSION.allocationMismatch}: ${this.lpAllocation.problems.join("; ")}`;
      out.push(this.record(tx, ix, "locked_lp_fee_collection", "migrated_lp", mint, t.amount, ok && payable, reason, this.lpAllocation, { instruction: ix.ordinal, transfer: t.ordinal, lockPda, feeKeyHolder: signer, recipient }));
    }
    return out;
  }
}
