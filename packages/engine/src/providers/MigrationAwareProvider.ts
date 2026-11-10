/**
 * Wraps a bonding-curve provider and, once its graduation has been VERIFIED on-chain, the destination
 * pool adapter. Before attachment nothing from the destination is indexed or accounted; after it,
 * the launch's reward periods cover both pools (bonding-curve history + destination activity), so a
 * migration creates neither a gap nor an overlap: records are slot-ordered and keyed per
 * (signature, event), and destination activity cannot predate the destination pool.
 */
import type { PublicKey } from "@solana/web3.js";
import type { NormalizedTx } from "../chain/tx";
import type { ChainRpc } from "../chain/rpc";
import type { NormalizedAttribution } from "../accounting/attribution";
import { DammV2Destination } from "./destination/dammV2";
import type { CheckpointState, ClaimPlan, FeeSourceState, LaunchProvider, ParsedTransaction, PoolInfo } from "./LaunchProvider";
import { buildDestination, type DestinationAdapter, type DestinationSpec } from "./destination";

export class MigrationAwareProvider implements LaunchProvider {
  private dest: DestinationAdapter | null = null;
  private specKey: string | null = null;

  constructor(
    readonly inner: LaunchProvider,
    private readonly rpc: ChainRpc | null,
  ) {}

  get id() {
    return this.inner.id;
  }
  get programId() {
    return this.inner.programId;
  }
  get destination(): DestinationAdapter | null {
    return this.dest;
  }

  /** Attach (idempotently) the destination described by a verified spec. */
  attach(spec: DestinationSpec | null): boolean {
    const key = spec ? JSON.stringify(spec) : null;
    if (key === this.specKey) return false;
    this.specKey = key;
    this.dest = spec ? buildDestination(spec, this.rpc) : null;
    return true;
  }

  async load(): Promise<PoolInfo> {
    await this.inner.load();
    return this.info();
  }

  info(): PoolInfo {
    const base = this.inner.info();
    const d = this.dest;
    if (!d) return { ...base, accountingPools: [base.poolAddress], destination: null };
    return {
      ...base,
      watchAddresses: [...new Set([...base.watchAddresses, ...d.watchAddresses()])],
      accountingPools: [base.poolAddress, d.pool],
      destination: { kind: d.kind, program: d.program, pool: d.pool, migrationSlot: d.migrationSlot, migrationSignature: d.migrationSignature, supported: true, allocation: d.allocation, ...(d.lpAllocation ? { lpAllocation: d.lpAllocation } : {}) },
      watchFromSlot: Object.fromEntries(d.watchAddresses().map((a) => [a, d.migrationSlot])),
    };
  }

  supportedQuoteAssets(): string[] {
    return this.inner.supportedQuoteAssets();
  }

  parseTransaction(tx: NormalizedTx): ParsedTransaction {
    const a = this.inner.parseTransaction(tx);
    if (!this.dest) return a;
    const b = this.dest.parse(tx);
    return { swaps: [...a.swaps, ...b.swaps], claims: [...a.claims, ...b.claims], anomalies: [...a.anomalies, ...b.anomalies], attributions: [...(a.attributions ?? []), ...(b.attributions ?? [])] };
  }

  /** The creator's DAMM v2 migration positions (Meteora DBC graduation, role creator), when attached. */
  private dammV2(): DammV2Destination | null {
    return this.dest instanceof DammV2Destination && this.inner.info().feeBeneficiaryRole === "creator" ? this.dest : null;
  }

  /** Bonding-curve unclaimed fees, plus — after a DBC → DAMM v2 graduation — the creator's unclaimed position LP fees. */
  async getFeeSourceState(): Promise<FeeSourceState> {
    const a = await this.inner.getFeeSourceState();
    const d = this.dammV2();
    const b = d ? await d.claimState(this.inner.info().beneficiary).catch(() => null) : null;
    if (!b || (b.unclaimedQuote === 0n && b.unclaimedBase === 0n)) return a;
    return { ...a, unclaimedQuote: a.unclaimedQuote + b.unclaimedQuote, unclaimedBase: a.unclaimedBase + b.unclaimedBase, source: `${a.source} + DAMM v2 migration positions (${b.positions.length})` };
  }

  async buildClaimInstructions(claimer: PublicKey, destination: PublicKey): Promise<ClaimPlan> {
    const d = this.dammV2();
    if (!d) return this.inner.buildClaimInstructions(claimer, destination);
    const info = this.inner.info();
    const lp = await d.buildClaimInstructions(claimer, destination, { [info.tokenMint]: info.baseTokenProgram, [info.quoteMint]: info.quoteTokenProgram });
    if (!lp.claimed) return this.inner.buildClaimInstructions(claimer, destination);
    // Residual bonding-curve fees are claimed in the same transaction when there are any.
    const inner = await this.inner.getFeeSourceState().catch(() => null);
    const bonding = inner && (inner.unclaimedQuote > 0n || inner.unclaimedBase > 0n) ? await this.inner.buildClaimInstructions(claimer, destination) : null;
    return { instructions: [...(bonding?.instructions ?? []), ...lp.instructions], signer: claimer, description: `${bonding ? `${bonding.description} + ` : ""}claim_position_fee ×${lp.claimed} (DAMM v2 ${d.pool}) → ${destination.toBase58()}` };
  }

  async checkpoint(snapshotSlot: number, previous: (key: string) => Promise<CheckpointState | null>): Promise<NormalizedAttribution[]> {
    const inner = this.inner.checkpoint ? await this.inner.checkpoint(snapshotSlot, previous) : [];
    const dest = this.dest?.checkpoint ? await this.dest.checkpoint(snapshotSlot, previous) : [];
    return [...inner, ...dest];
  }
}
