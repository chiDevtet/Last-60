import type { AppConfig } from "../config/env";
import type { ChainRpc } from "../chain/rpc";
import type { LaunchProvider } from "./LaunchProvider";
import { MeteoraDBCProvider } from "./meteora/MeteoraDBCProvider";
import { RaydiumLaunchLabProvider } from "./raydium/RaydiumLaunchLabProvider";
import { MockProvider } from "./mock/MockProvider";
import { MigrationAwareProvider } from "./MigrationAwareProvider";

export * from "./LaunchProvider";
export { MeteoraDBCProvider, DBC_PROGRAM_ID } from "./meteora/MeteoraDBCProvider";
export { RaydiumLaunchLabProvider, LAUNCHLAB_PROGRAM_ID } from "./raydium/RaydiumLaunchLabProvider";
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
 * The ONLY place that knows which concrete adapter backs LAUNCH_PROVIDER. Bonding-curve providers
 * are wrapped so that a verified graduation destination can be attached later.
 */
export function createProvider(target: ProviderTarget, rpc: ChainRpc | null): LaunchProvider {
  switch (target.id) {
    case "meteora_dbc":
      return new MigrationAwareProvider(new MeteoraDBCProvider(rpc, { poolAddress: req(target.poolAddress, "POOL_ADDRESS"), tokenMint: req(target.tokenMint, "TOKEN_MINT"), role: target.role, payoutMint: target.payoutMint, expected: target.expected }), rpc);
    case "raydium_launchlab":
      return new MigrationAwareProvider(new RaydiumLaunchLabProvider(rpc, { poolAddress: req(target.poolAddress, "POOL_ADDRESS"), tokenMint: req(target.tokenMint, "TOKEN_MINT"), role: target.role, payoutMint: target.payoutMint, expected: target.expected }), rpc);
    case "mock":
      return new MockProvider({ poolAddress: target.poolAddress ?? undefined, tokenMint: target.tokenMint ?? undefined });
  }
}

function req(v: string | null, name: string): string {
  if (!v) throw new Error(`${name} is required for this provider`);
  return v;
}
