/**
 * Builds the post-graduation adapter for a VERIFIED migration and serialises it as a plain spec
 * (stored on `pools.migration.spec`) so that every process — indexer and rewards worker — attaches
 * exactly the same destination with the same allocation basis.
 */
import type { ChainRpc } from "../../chain/rpc";
import { makeBasis, type AllocationBasis, type AllocationVerification } from "../../accounting/attribution";
import { classifyLaunchLabLocks, launchLabLpVerification } from "../../accounting/launchlabPlatform";
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
export interface LaunchLabSourceFacts {
  /** PlatformConfig creator_scale / platform_scale (millionths of migrated LP), as decimal strings. */
  creatorScale?: string | null;
  platformScale?: string | null;
  /** PlatformConfig platform_nft_wallet: the owner of the platform Fee Key. */
  platformNftWallet?: string | null;
  /** Operator declaration EXPECTED_CPMM_CREATOR_FEE_RATE (millionths of swap value), compared with AmmConfig.creator_fee_rate. */
  expectedCpmmCreatorFeeRate?: number | null;
}

/**
 * Pure: verification of the CPMM creator-fee basis. Fails closed (unverifiable) when the
 * creator_fee_on mode or the effective creator-fee share rate cannot be established, or when the
 * pool_creator is not the beneficiary; `mismatch` when AmmConfig.creator_fee_rate differs from the
 * operator's declaration. Otherwise it inherits the bonding-curve allocation's verification.
 */
export function cpmmCreatorFeeVerification(v: Pick<VerifiedMigration, "cpmmPoolCreator" | "cpmmEnableCreatorFee" | "cpmmCreatorFeeOn" | "cpmmCreatorFeeOnRaw" | "cpmmConfig" | "cpmmFeeShare">, beneficiary: string, bonding: { verification: AllocationVerification; problems: string[] } | undefined, expectedRate: number | null | undefined): { verification: AllocationVerification; problems: string[] } {
  if (!(v.cpmmPoolCreator === beneficiary && v.cpmmEnableCreatorFee === true)) return { verification: "unverifiable", problems: [`CPMM pool_creator ${v.cpmmPoolCreator ?? "?"} is not the beneficiary ${beneficiary} or the creator fee is disabled`] };
  if (!v.cpmmCreatorFeeOn) return { verification: "unverifiable", problems: [`CPMM creator_fee_on ${v.cpmmCreatorFeeOnRaw ?? "?"} is not a verified mode (0 both_tokens / 1 only_token_0 / 2 only_token_1)`] };
  if (!v.cpmmFeeShare || v.cpmmFeeShare.effectiveRate === null) return { verification: "unverifiable", problems: [`CPMM creator-fee share rate unresolved: ${(v.cpmmFeeShare?.problems ?? ["not read"]).join("; ")}`] };
  if (expectedRate !== null && expectedRate !== undefined && String(expectedRate) !== v.cpmmConfig?.creatorFeeRate) return { verification: "mismatch", problems: [`CPMM AmmConfig creator_fee_rate ${v.cpmmConfig?.creatorFeeRate ?? "?"} ≠ declared EXPECTED_CPMM_CREATOR_FEE_RATE ${expectedRate}`] };
  return { verification: bonding?.verification ?? "not_declared", problems: [...(bonding?.problems ?? [])] };
}

export function destinationSpec(info: PoolInfo, v: VerifiedMigration, lpCheck: { verification: AllocationVerification; problems: string[] }, sourceFacts: LaunchLabSourceFacts = {}): DestinationSpec | null {
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
    const creatorFeeIsBeneficiary = v.cpmmPoolCreator === info.beneficiary && v.cpmmEnableCreatorFee === true;
    const check = cpmmCreatorFeeVerification(v, info.beneficiary, info.allocation, sourceFacts.expectedCpmmCreatorFeeRate);
    const share = v.cpmmFeeShare;
    const allocation = makeBasis({
      ...common,
      phase: "post_migration_trading",
      params: {
        cpmmPoolCreator: v.cpmmPoolCreator ?? "?",
        enableCreatorFee: v.cpmmEnableCreatorFee ?? false,
        creatorFeeRate: v.cpmmConfig?.creatorFeeRate ?? "?",
        // AmmConfig default (kept under its historical key) / per-creator override / effective rate.
        creatorFeeShareRate: v.cpmmConfig?.creatorFeeShareRate ?? "?",
        creatorFeeShareOverride: share ? (share.override === "present" ? share.overrideRate! : share.override) : "unknown",
        effectiveCreatorFeeShareRate: share?.effectiveRate ?? "unresolved",
        creatorFeeSharePda: share?.overridePda ?? "?",
        creatorFeeOn: v.cpmmCreatorFeeOn ?? `unverified:${v.cpmmCreatorFeeOnRaw ?? "?"}`,
        creatorFeeIsBeneficiary,
      },
      source: `CPMM pool ${v.destinationPool} pool_creator / enable_creator_fee / creator_fee_on; AmmConfig ${v.destinationConfig}; CreatorFeeShare ${share?.overridePda ?? "?"} read at slot ${share?.verifiedAtSlot ?? "?"}`,
      // There is no separate operator declaration for the CPMM creator fee beyond its rate: it is the
      // continuation of the LaunchLab creator allocation. It is "verified" only when (a) the pool
      // facts prove the beneficiary is the CPMM pool_creator with the creator fee enabled, (b) the
      // creator_fee_on mode and the effective creator-fee share rate are established, (c) the
      // AmmConfig rate matches EXPECTED_CPMM_CREATOR_FEE_RATE when declared AND (d) the bonding-curve
      // allocation itself was verified. It is independent of the locked-LP basis below.
      verification: check.verification,
      problems: check.problems,
    });
    // Locked-LP entitlement: decided by the lock records of THIS migration transaction, never by
    // creator_scale. Since the 2026-08-17 LaunchLab upgrade the program mints ONE platform Fee Key
    // (platform_scale + creator_scale) to platform_nft_wallet; a creator Fee Key exists only for a
    // pre-upgrade migration whose locks prove it (see classifyLaunchLabLocks).
    const big = (x: string | null | undefined) => (x === null || x === undefined || !/^\d+$/.test(x) ? null : BigInt(x));
    const creatorRole = info.feeBeneficiaryRole === "creator";
    const cls = classifyLaunchLabLocks({ locks: v.locks, beneficiary: info.beneficiary, platformNftWallet: sourceFacts.platformNftWallet, platformScale: big(sourceFacts.platformScale), creatorScale: big(sourceFacts.creatorScale), migrationSlot: v.slot });
    const lp = creatorRole ? launchLabLpVerification(cls, lpCheck) : { verification: "not_declared" as AllocationVerification, problems: [] as string[] };
    const beneficiaryLocks = creatorRole ? cls.creatorLocks : v.locks.filter((l) => l.nftOwnerAtMigration === info.beneficiary).map((l) => ({ lockPda: l.lockPda, nftMint: l.nftMint }));
    const lpAllocation = makeBasis({
      ...common,
      phase: "migrated_lp",
      params: { creatorScale: sourceFacts.creatorScale ?? "unknown", locks: v.locks.map((l) => `${l.lockPda}:${l.nftOwnerAtMigration}:${l.lpAmount}`).join(","), beneficiaryLocks: beneficiaryLocks.map((l) => l.lockPda).join(",") },
      source: `LP-lock accounts created by migration tx ${v.signature}; PlatformConfig platform_nft_wallet / platform_scale / creator_scale`,
      verification: lp.verification,
      problems: lp.problems,
    });
    const cpmm: CpmmPoolFacts = { token0Mint: v.tokenAMint!, token1Mint: v.tokenBMint!, token0Vault: v.cpmmVaults!.token0, token1Vault: v.cpmmVaults!.token1, poolCreator: v.cpmmPoolCreator!, enableCreatorFee: v.cpmmEnableCreatorFee === true, creatorFeeOn: v.cpmmCreatorFeeOn, ammConfig: v.destinationConfig ?? null, feeShare: v.cpmmFeeShare ? { ammConfigDefaultRate: v.cpmmFeeShare.ammConfigDefaultRate, override: v.cpmmFeeShare.override, overrideRate: v.cpmmFeeShare.overrideRate, effectiveRate: v.cpmmFeeShare.effectiveRate, overridePda: v.cpmmFeeShare.overridePda, verifiedAtSlot: v.cpmmFeeShare.verifiedAtSlot } : null, platformNftWallet: sourceFacts.platformNftWallet ?? null, allPlatformLocks: cls.platformLocks, beneficiaryLocks, ...(creatorRole ? { platformLocks: cls.platformLocks } : {}) };
    return { kind: v.kind, pool: v.destinationPool, program: v.destinationProgram, ctx, allocation, lpAllocation, cpmm };
  }
  return null;
}

export function buildDestination(spec: DestinationSpec, rpc: ChainRpc | null): DestinationAdapter {
  if (spec.kind === "dbc_damm_v2") return new DammV2Destination(rpc, spec.pool, spec.dammV2!.tokenAMint, spec.dammV2!.tokenBMint, spec.dammV2!.positions, spec.ctx, spec.allocation);
  return new CpmmDestination(spec.pool, spec.cpmm!, spec.ctx, spec.allocation, spec.lpAllocation!);
}
