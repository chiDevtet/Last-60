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

  getFeeSourceState(): Promise<FeeSourceState> {
    return this.inner.getFeeSourceState();
  }

  buildClaimInstructions(claimer: PublicKey, destination: PublicKey): Promise<ClaimPlan> {
    return this.inner.buildClaimInstructions(claimer, destination);
  }

  async checkpoint(snapshotSlot: number, previous: (key: string) => Promise<CheckpointState | null>): Promise<NormalizedAttribution[]> {
    const inner = this.inner.checkpoint ? await this.inner.checkpoint(snapshotSlot, previous) : [];
    const dest = this.dest?.checkpoint ? await this.dest.checkpoint(snapshotSlot, previous) : [];
    return [...inner, ...dest];
  }
}
