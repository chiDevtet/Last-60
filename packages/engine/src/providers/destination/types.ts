/**
 * Post-graduation (destination pool) adapters. An adapter is attached to a launch ONLY after its
 * migration was verified on-chain (`verifyMigration` → every required check true). It contributes:
 *   - buyer tracking: decoded swaps on the destination pool (same signer rule as bonding curves);
 *   - creator-fee attribution for the destination's actual creator entitlement:
 *       DAMM v2  — fee growth of LP positions whose NFT the beneficiary holds (checkpointed);
 *       CPMM     — creator fees as COLLECTED to the pool creator, and LP fees COLLECTED from the
 *                  locked-LP fee key minted to the beneficiary at migration.
 * Gross pool fees, protocol / partner / platform shares and other LPs' fees are recorded as
 * excluded, never attributed.
 */
import type { NormalizedTx } from "../../chain/tx";
import type { AllocationBasis, NormalizedAttribution } from "../../accounting/attribution";
import type { CheckpointState, ParsedTransaction } from "../LaunchProvider";

export interface DestinationAdapter {
  readonly kind: "dbc_damm_v2" | "launchlab_cpmm";
  readonly program: string;
  readonly pool: string;
  readonly migrationSlot: number;
  readonly migrationSignature: string;
  /** Basis of the beneficiary's post-migration allocation (positions / locks / creator-fee recipient). */
  readonly allocation: AllocationBasis;
  watchAddresses(): string[];
  /** Pure: decode destination-pool activity of one transaction. */
  parse(tx: NormalizedTx): ParsedTransaction;
  checkpoint?(snapshotSlot: number, previous: (key: string) => Promise<CheckpointState | null>): Promise<NormalizedAttribution[]>;
}

export interface DestinationContext {
  sourceProvider: "meteora_dbc" | "raydium_launchlab";
  sourcePool: string;
  baseMint: string;
  quoteMint: string;
  beneficiary: string;
  migrationSlot: number;
  migrationSignature: string;
}
