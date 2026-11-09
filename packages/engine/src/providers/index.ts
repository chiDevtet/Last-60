import type { AppConfig } from "../config/env";
import type { ChainRpc } from "../chain/rpc";
import { AwaitingLaunchError, type LaunchProvider } from "./LaunchProvider";
import { MeteoraDBCProvider } from "./meteora/MeteoraDBCProvider";
import { RaydiumLaunchLabProvider } from "./raydium/RaydiumLaunchLabProvider";
import { MockProvider } from "./mock/MockProvider";
import { MigrationAwareProvider } from "./MigrationAwareProvider";

export * from "./LaunchProvider";
export { MeteoraDBCProvider, DBC_PROGRAM_ID } from "./meteora/MeteoraDBCProvider";
export { RaydiumLaunchLabProvider, LAUNCHLAB_PROGRAM_ID } from "./raydium/RaydiumLaunchLabProvider";
export { deriveLaunchLabPool } from "./raydium/pda";
export { MockProvider } from "./mock/MockProvider";
export * from "./migration";
export { MigrationAwareProvider } from "./MigrationAwareProvider";
export { destinationSpec, buildDestination, type DestinationSpec, DammV2Destination, CpmmDestination } from "./destination";
export { resolveAndAttachMigration, attachStoredMigration } from "./migrationAttach";

export interface ProviderTarget {
  id: AppConfig["provider"]["id"];
  poolAddress: string | null;
  tokenMint: string | null;
  role: AppConfig["provider"]["feeBeneficiaryRole"];
  payoutMint: string;
  /** Operator-declared allocation, used only to verify on-chain values. */
  expected?: AppConfig["provider"]["expected"];
}

/**
 * The provider target for the effective settings — used by the indexer, the rewards worker and the
 * CLI so that every process loads the same pool, role, payout mint AND the same operator
 * declarations, and therefore resolves the same allocation bases and verification.
 */
export function providerTargetFor(s: { launchProvider: ProviderTarget["id"]; poolAddress: string | null; tokenMint: string | null; feeBeneficiaryRole: ProviderTarget["role"]; payoutAssetMint: string }, cfg: Pick<AppConfig, "provider">): ProviderTarget {
  return { id: s.launchProvider, poolAddress: s.poolAddress, tokenMint: s.tokenMint, role: s.feeBeneficiaryRole, payoutMint: s.payoutAssetMint, expected: cfg.provider.expected };
}

/**
 * The ONLY place that knows which concrete adapter backs LAUNCH_PROVIDER. Bonding-curve providers
 * are wrapped so that a verified graduation destination can be attached later.
 */
export function createProvider(target: ProviderTarget, rpc: ChainRpc | null): LaunchProvider {
  switch (target.id) {
    case "meteora_dbc":
      return new MigrationAwareProvider(new MeteoraDBCProvider(rpc, { tokenMint: req(target.tokenMint, "TOKEN_MINT"), poolAddress: req(target.poolAddress, "POOL_ADDRESS"), role: target.role, payoutMint: target.payoutMint, expected: target.expected }), rpc);
    case "raydium_launchlab":
      return new MigrationAwareProvider(new RaydiumLaunchLabProvider(rpc, { tokenMint: req(target.tokenMint, "TOKEN_MINT"), poolAddress: req(target.poolAddress, "POOL_ADDRESS"), role: target.role, payoutMint: target.payoutMint, expected: target.expected }), rpc);
    case "mock":
      return new MockProvider({ poolAddress: target.poolAddress ?? undefined, tokenMint: target.tokenMint ?? undefined });
  }
}

function req(v: string | null, name: string): string {
  // Not configured yet (set from the admin console or the environment): a waiting state, not a crash.
  if (!v) throw new AwaitingLaunchError(name === "TOKEN_MINT" ? "no token mint is configured yet (set it in the admin console)" : `${name} is not configured yet`);
  return v;
}
