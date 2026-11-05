/**
 * Builds the post-graduation adapter for a VERIFIED migration and serialises it as a plain spec
 * (stored on `pools.migration.spec`) so that every process — indexer and rewards worker — attaches
 * exactly the same destination with the same allocation basis.
 */
import type { ChainRpc } from "../../chain/rpc";
import { makeBasis, type AllocationBasis, type AllocationVerification } from "../../accounting/attribution";
import type { PoolInfo } from "../LaunchProvider";
import { migrationVerified, type VerifiedMigration } from "../migration";
import { CpmmDestination, type CpmmPoolFacts } from "./cpmm";
import { DammV2Destination, type DammV2Position } from "./dammV2";
import type { DestinationAdapter, DestinationContext } from "./types";

export type { DestinationAdapter } from "./types";
export { DammV2Destination } from "./dammV2";
export { CpmmDestination } from "./cpmm";

export interface DestinationSpec {
  kind: "dbc_damm_v2" | "launchlab_cpmm";
  pool: string;
  program: string;
  ctx: DestinationContext;
  allocation: AllocationBasis;
  lpAllocation?: AllocationBasis;
  dammV2?: { tokenAMint: string; tokenBMint: string; positions: DammV2Position[] };
  cpmm?: CpmmPoolFacts;
}

/**
 * The spec for a verified, supported migration — or null (unverified / unsupported migrations never
 * enter accounting). `lpCheck` is the result of comparing the declared creator LP allocation with
 * the source config (DBC LP percentages / LaunchLab creator_scale).
 */
export function destinationSpec(info: PoolInfo, v: VerifiedMigration, lpCheck: { verification: AllocationVerification; problems: string[] }, sourceFacts: { creatorScale?: string | null } = {}): DestinationSpec | null {
  if (!migrationVerified(v) || info.provider === "mock") return null;
  const ctx: DestinationContext = {
    sourceProvider: info.provider,
    sourcePool: info.poolAddress,
    baseMint: info.tokenMint,
    quoteMint: info.quoteMint,
    beneficiary: info.beneficiary,
    migrationSlot: v.slot,
    migrationSignature: v.signature,
  };
  const common = { provider: info.provider, pool: v.destinationPool, role: info.feeBeneficiaryRole, beneficiary: info.beneficiary };
  if (v.kind === "dbc_damm_v2") {
    const held = v.positionStates.filter((p) => p.holder === info.beneficiary);
    const liq = v.positionStates.reduce((a, p) => a + p.liquidity, 0n);
    const heldLiq = held.reduce((a, p) => a + p.liquidity, 0n);
    const allocation = makeBasis({
      ...common,
      phase: "migrated_lp",
      params: {
        positions: v.positionStates.map((p) => `${p.position}:${p.holder ?? "?"}`).join(","),
        beneficiaryPositions: held.map((p) => p.position).join(","),
        beneficiaryLiquidityShareOfMigrationPositionsBps: liq > 0n ? Number((heldLiq * 10_000n) / liq) : 0,
        creatorLpPercentage: String(info.feeParams.creatorLpPercentage ?? "unknown"),
      },
      source: `DAMM v2 pool ${v.destinationPool}; migration positions from tx ${v.signature}; DBC config LP percentages`,
      verification: lpCheck.verification,
      problems: lpCheck.problems,
    });
    return { kind: v.kind, pool: v.destinationPool, program: v.destinationProgram, ctx, allocation, dammV2: { tokenAMint: v.tokenAMint!, tokenBMint: v.tokenBMint!, positions: v.positionStates.map((p) => ({ position: p.position, nftMint: p.nftMint, nftAccount: p.nftAccount })) } };
  }
  if (v.kind === "launchlab_cpmm") {
    const beneficiaryLocks = v.locks.filter((l) => l.nftOwnerAtMigration === info.beneficiary).map((l) => ({ lockPda: l.lockPda, nftMint: l.nftMint }));
    const creatorFeeIsBeneficiary = v.cpmmPoolCreator === info.beneficiary && v.cpmmEnableCreatorFee === true;
    const allocation = makeBasis({
      ...common,
      phase: "post_migration_trading",
      params: { cpmmPoolCreator: v.cpmmPoolCreator ?? "?", enableCreatorFee: v.cpmmEnableCreatorFee ?? false, creatorFeeRate: v.cpmmConfig?.creatorFeeRate ?? "?", creatorFeeShareRate: v.cpmmConfig?.creatorFeeShareRate ?? "?", creatorFeeIsBeneficiary },
      source: `CPMM pool ${v.destinationPool} pool_creator / enable_creator_fee; AmmConfig ${v.destinationConfig}`,
      verification: "not_declared",
      problems: [],
    });
    // The lock set must agree with the platform's creator_scale: a positive scale without a lock
    // minted to the creator (or the reverse) is not provable → unverifiable, never paid.
    const scale = sourceFacts.creatorScale ? BigInt(sourceFacts.creatorScale) : null;
    const lpProblems = [...lpCheck.problems];
    let lpVerification = lpCheck.verification;
    if (scale !== null && info.feeBeneficiaryRole === "creator" && (scale > 0n) !== beneficiaryLocks.length > 0) {
      lpVerification = "unverifiable";
      lpProblems.push(`creator_scale is ${scale} but ${beneficiaryLocks.length} LP lock(s) were minted to the creator at migration`);
    }
    const lpAllocation = makeBasis({
      ...common,
      phase: "migrated_lp",
      params: { creatorScale: sourceFacts.creatorScale ?? "unknown", locks: v.locks.map((l) => `${l.lockPda}:${l.nftOwnerAtMigration}:${l.lpAmount}`).join(","), beneficiaryLocks: beneficiaryLocks.map((l) => l.lockPda).join(",") },
      source: `LP-lock accounts created by migration tx ${v.signature}; PlatformConfig creator_scale`,
      verification: lpVerification,
      problems: lpProblems,
    });
    const cpmm: CpmmPoolFacts = { token0Mint: v.tokenAMint!, token1Mint: v.tokenBMint!, token0Vault: v.cpmmVaults!.token0, token1Vault: v.cpmmVaults!.token1, poolCreator: v.cpmmPoolCreator!, enableCreatorFee: v.cpmmEnableCreatorFee === true, beneficiaryLocks };
    return { kind: v.kind, pool: v.destinationPool, program: v.destinationProgram, ctx, allocation, lpAllocation, cpmm };
  }
  return null;
}

export function buildDestination(spec: DestinationSpec, rpc: ChainRpc | null): DestinationAdapter {
  if (spec.kind === "dbc_damm_v2") return new DammV2Destination(rpc, spec.pool, spec.dammV2!.tokenAMint, spec.dammV2!.tokenBMint, spec.dammV2!.positions, spec.ctx, spec.allocation);
  return new CpmmDestination(spec.pool, spec.cpmm!, spec.ctx, spec.allocation, spec.lpAllocation!);
}
