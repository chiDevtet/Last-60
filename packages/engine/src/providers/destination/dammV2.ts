/**
 * Meteora DAMM v2 destination adapter (DBC → DAMM v2 graduations).
 *
 * Verified against the DAMM v2 program source (MeteoraAg/damm-v2, IDL cp_amm 0.2.5) and real mainnet
 * transactions (test/fixtures/mainnet/destination-damm-v2.json):
 *   - every swap / swap2 emits EvtSwap2 via self-CPI; trade_direction 0 = AtoB, 1 = BtoA;
 *   - fees are taken on the OUTPUT token in BothToken mode and always in token B in OnlyB /
 *     Compounding mode (`FeeMode::get_fee_mode`);
 *   - LP fees accrue per position via `fee_{a,b}_per_liquidity`; a position's entitlement is
 *     pending + liquidity × Δfee_per_liquidity >> 128 (`dammV2ClaimableFees`). Protocol, partner,
 *     referral and compounding fees never reach positions — they are excluded by construction.
 *
 * Creator entitlement = fee growth of the migration-created positions whose NFT the beneficiary
 * holds at each checkpoint. Positions held by anyone else (e.g. the partner) are excluded.
 */
import type { Idl } from "@coral-xyz/anchor";
import idlJson from "./idl/damm_v2.json";
import { AnchorEventDecoder, instructionDiscriminator, toAddr, toBig } from "../../chain/anchorEvents";
import type { NormalizedTx } from "../../chain/tx";
import type { ChainRpc } from "../../chain/rpc";
import { basisPayable, EXCLUSION, type AllocationBasis, type NormalizedAttribution } from "../../accounting/attribution";
import { resolveTrader, type CheckpointState, type NormalizedSwap, type ParsedTransaction } from "../LaunchProvider";
import { DAMM_V2_POOL_DISC, DAMM_V2_POSITION_DISC, DAMM_V2_PROGRAM_ID, dammV2ClaimableFees, decodeDammV2Pool, decodeDammV2Position, resolveNftHolder } from "../migration";
import type { DestinationAdapter, DestinationContext } from "./types";

const idl = idlJson as unknown as Idl;
const SWAP_IX = new Set(["swap", "swap2"].map((n) => instructionDiscriminator(n).toString("hex")));
const CLAIM_IX = instructionDiscriminator("claim_position_fee").toString("hex");

export interface DammV2Position {
  position: string;
  nftMint: string;
  nftAccount: string;
}

/** Fee mint of a DAMM v2 swap (program `FeeMode::get_fee_mode`). */
export function dammV2FeeOnTokenA(collectFeeMode: number, tradeDirection: number): boolean {
  return collectFeeMode === 0 && tradeDirection === 1; // BothToken + BtoA → output (A); otherwise token B
}

export class DammV2Destination implements DestinationAdapter {
  readonly kind = "dbc_damm_v2" as const;
  readonly program = DAMM_V2_PROGRAM_ID;
  private readonly events = new AnchorEventDecoder(DAMM_V2_PROGRAM_ID, idl);

  constructor(
    private readonly rpc: ChainRpc | null,
    readonly pool: string,
    private readonly tokenAMint: string,
    private readonly tokenBMint: string,
    private readonly positions: DammV2Position[],
    private readonly ctx: DestinationContext,
    readonly allocation: AllocationBasis,
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

  parse(tx: NormalizedTx): ParsedTransaction {
    const out: ParsedTransaction = { swaps: [], claims: [], anomalies: [], attributions: [] };
    if (tx.err) return out;
    if (tx.slot < this.ctx.migrationSlot) {
      out.anomalies.push(`DAMM v2 activity at slot ${tx.slot} precedes the verified migration slot ${this.ctx.migrationSlot}`);
      return out;
    }
    for (const ev of this.events.decodeAll(tx)) {
      const parent = ev.parent;
      if (!parent) continue;
      const disc = parent.data.subarray(0, 8).toString("hex");
      const d: any = ev.data;
      if (ev.name === "EvtSwap2" && SWAP_IX.has(disc)) {
        if (toAddr(d.pool) !== this.pool || parent.accounts[1] !== this.pool) continue;
        out.swaps.push(this.swap(tx, d, parent.accounts[8], ev.ordinal, parent.ordinal));
      } else if (ev.name === "EvtClaimPositionFee" && disc === CLAIM_IX) {
        if (toAddr(d.pool) !== this.pool) continue;
        const position = toAddr(d.position);
        if (!this.positions.some((p) => p.position === position)) continue; // not a migration position
        const a = toBig(d.fee_a_claimed);
        const b = toBig(d.fee_b_claimed);
        const quoteIsA = this.tokenAMint === this.ctx.quoteMint;
        out.claims.push({
          signature: tx.signature,
          pool: this.pool,
          claimer: toAddr(d.owner),
          quoteAmount: quoteIsA ? a : b,
          baseAmount: quoteIsA ? b : a,
          slot: tx.slot,
          blockTime: tx.blockTime,
          evidence: { event: "EvtClaimPositionFee", position, instruction: parent.ordinal, owner: toAddr(d.owner) },
        });
      }
    }
    return out;
  }

  private swap(tx: NormalizedTx, d: any, payer: string | undefined, eventIndex: number, ixOrdinal: number): NormalizedSwap {
    const direction = Number(d.trade_direction);
    const inputMint = direction === 0 ? this.tokenAMint : this.tokenBMint;
    const side = inputMint === this.ctx.quoteMint ? "buy" : "sell";
    const r = d.swap_result;
    const total = toBig(r.claiming_fee ?? r.lp_fee) + toBig(r.protocol_fee) + toBig(r.compounding_fee ?? r.partner_fee ?? 0) + toBig(r.referral_fee);
    const feeMint = dammV2FeeOnTokenA(Number(d.collect_fee_mode), direction) ? this.tokenAMint : this.tokenBMint;
    const { trader, source } = resolveTrader(tx, payer, this.ctx.baseMint, side);
    return {
      signature: tx.signature,
      eventIndex,
      pool: this.pool,
      side,
      trader,
      traderSource: source,
      quoteAmount: side === "buy" ? toBig(d.included_transfer_fee_amount_in) : toBig(d.excluded_transfer_fee_amount_out),
      baseAmount: side === "buy" ? toBig(d.excluded_transfer_fee_amount_out) : toBig(d.included_transfer_fee_amount_in),
      totalFee: total,
      totalFeeMint: feeMint,
      // The creator's share of LP fees is measured on its positions (checkpoint), never per swap.
      eligibleFee: 0n,
      eligibleFeeMint: feeMint,
      slot: tx.slot,
      blockTime: tx.blockTime,
      feePhase: "post_migration_trading",
      excludedFee: total,
      excludedReason: EXCLUSION.lpFeesViaPosition,
      feeStatus: "observed",
      payoutEligible: true,
      basisId: this.allocation.id,
      evidence: { event: "EvtSwap2", instruction: ixOrdinal, collectFeeMode: Number(d.collect_fee_mode), claimingFee: toBig(r.claiming_fee ?? r.lp_fee).toString(), protocolFee: toBig(r.protocol_fee).toString() },
    };
  }

  /**
   * Position fee-growth checkpoint at a snapshot. For each migration position and token, the
   * cumulative entitlement (claimable + already claimed) is read with minContextSlot = snapshotSlot;
   * the increase since the previous checkpoint is attributed to the period ending at snapshotSlot.
   * Consecutive deltas tile exactly (a fee read slightly after the snapshot simply is not counted
   * again next period). Only positions whose NFT the beneficiary holds are creator-allocated.
   */
  async checkpoint(snapshotSlot: number, previous: (key: string) => Promise<CheckpointState | null>): Promise<NormalizedAttribution[]> {
    if (!this.rpc) throw new Error("DAMM v2 checkpoint requires an RPC client");
    const out: NormalizedAttribution[] = [];
    const accs = await this.rpc.getMultipleAccounts([this.pool, ...this.positions.flatMap((p) => [p.position, p.nftAccount])], "confirmed", { minContextSlot: snapshotSlot });
    const poolAcc = accs.value[0];
    const observedSlot = accs.slot;
    const base = { provider: this.ctx.sourceProvider, sourcePool: this.ctx.sourcePool, destinationPool: this.pool, beneficiary: this.ctx.beneficiary, signature: null, slot: snapshotSlot, observedSlot, blockTime: null, basisId: this.allocation.id, phase: "migrated_lp" as const };
    if (!poolAcc || poolAcc.owner !== DAMM_V2_PROGRAM_ID || !poolAcc.data.subarray(0, 8).equals(DAMM_V2_POOL_DISC)) {
      out.push({ ...base, key: `dammv2-unresolved:${this.pool}:${snapshotSlot}`, kind: "excluded", feeMint: this.ctx.quoteMint, grossAmount: null, creatorAmount: 0n, excludedAmount: 0n, excludedReason: "destination pool unreadable", evidence: { pool: this.pool }, status: "unresolved", payoutEligible: false });
      return out;
    }
    const pool = decodeDammV2Pool(poolAcc.data);
    for (let i = 0; i < this.positions.length; i++) {
      const p = this.positions[i]!;
      const posAcc = accs.value[1 + i * 2];
      if (!posAcc || posAcc.owner !== DAMM_V2_PROGRAM_ID || !posAcc.data.subarray(0, 8).equals(DAMM_V2_POSITION_DISC)) {
        out.push({ ...base, key: `dammv2-unresolved:${p.position}:${snapshotSlot}`, kind: "excluded", feeMint: this.ctx.quoteMint, grossAmount: null, creatorAmount: 0n, excludedAmount: 0n, excludedReason: "position account missing or invalid (closed?) — entitlement cannot be proven", evidence: { position: p.position }, status: "unresolved", payoutEligible: false });
        continue;
      }
      const pos = decodeDammV2Position(posAcc.data);
      if (pos.pool !== this.pool || pos.nftMint !== p.nftMint) continue;
      const holder = await resolveNftHolder(this.rpc, p.nftMint, p.nftAccount, accs.value[2 + i * 2], { minContextSlot: snapshotSlot });
      const fees = dammV2ClaimableFees(pool, pos);
      const liquidity = pos.unlockedLiquidity + pos.vestedLiquidity + pos.permanentLockedLiquidity;
      for (const [mint, claimable, claimed] of [
        [this.tokenAMint, fees.a, pos.totalClaimedAFee],
        [this.tokenBMint, fees.b, pos.totalClaimedBFee],
      ] as const) {
        const checkpointKey = `dammv2:${p.position}:${mint}`;
        const prev = await previous(checkpointKey);
        const cumulative = claimable + claimed;
        const prevCum = prev?.cumulative ?? 0n;
        if (cumulative === prevCum) continue;
        const evidence = { position: p.position, nftMint: p.nftMint, holder, liquidity: liquidity.toString(), poolLiquidity: pool.liquidity.toString(), claimable: claimable.toString(), claimed: claimed.toString(), cumulative: (cumulative > prevCum ? cumulative : prevCum).toString(), prevCumulative: prevCum.toString(), prevSlot: prev?.slot ?? null, checkpointKey, formula: "pending + liquidity * (fee_per_liquidity - checkpoint) >> 128, + total_claimed" };
        if (cumulative < prevCum) {
          // Cumulative entitlement can only grow; a decrease means the evidence is inconsistent. Do not
          // lower the stored counter (that would re-count later growth) and attribute nothing.
          out.push({ ...base, key: `dammv2-cp:${p.position}:${mint}:${snapshotSlot}`, kind: "excluded", feeMint: mint, grossAmount: null, creatorAmount: 0n, excludedAmount: 0n, excludedReason: `position fee counter decreased (${prevCum} → ${cumulative})`, evidence, status: "unresolved", payoutEligible: false });
          continue;
        }
        const delta = cumulative - prevCum;
        const ownsIt = holder !== null && holder === this.ctx.beneficiary;
        const payable = basisPayable(this.allocation);
        out.push({
          ...base,
          key: `dammv2-cp:${p.position}:${mint}:${snapshotSlot}`,
          kind: "position_checkpoint",
          feeMint: mint,
          grossAmount: delta,
          creatorAmount: ownsIt ? delta : 0n,
          excludedAmount: ownsIt ? 0n : delta,
          excludedReason: !ownsIt ? (holder === null ? "position NFT holder could not be resolved" : EXCLUSION.positionNotHeldByBeneficiary) : payable ? null : `${EXCLUSION.allocationMismatch}: ${this.allocation.problems.join("; ")}`,
          evidence,
          status: holder === null || (ownsIt && !payable) ? "unresolved" : "observed",
          payoutEligible: ownsIt && payable,
        });
      }
    }
    return out;
  }
}
