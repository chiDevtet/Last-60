/**
 * Graduation handling shared by the indexer and the rewards worker:
 *   1. find the migration transaction of the bonding pool (evidence, never a guess);
 *   2. verify it strictly (verifyMigration — every required check for its kind);
 *   3. persist the outcome on `pools.migration` (verified | unverified | unsupported, with failed checks);
 *   4. attach the destination adapter ONLY when verified and supported.
 * Re-running is idempotent: the same migration produces the same spec and the attach is a no-op.
 */
import type { ChainRpc } from "../chain/rpc";
import type { Models } from "../db/models";
import { jsonSafe } from "../util/json";
import type { LaunchProvider, PoolInfo } from "./LaunchProvider";
import { MigrationAwareProvider } from "./MigrationAwareProvider";
import { MeteoraDBCProvider } from "./meteora/MeteoraDBCProvider";
import { RaydiumLaunchLabProvider } from "./raydium/RaydiumLaunchLabProvider";
import { findMigration, migrationVerified, verifyMigration, type VerifiedMigration, type VerifyContext } from "./migration";
import { destinationSpec, type DestinationSpec } from "./destination";

export type MigrationStatus = "verified" | "unverified" | "unsupported" | "not_found";

/** Verification context derived from the loaded bonding provider (creator, partner, platform facts). */
export function verifyContextOf(provider: LaunchProvider, info: PoolInfo): VerifyContext {
  const inner = provider instanceof MigrationAwareProvider ? provider.inner : provider;
  const ctx: VerifyContext = { base: info.tokenMint, quote: info.quoteMint, bondingCreator: info.creator };
  if (inner instanceof MeteoraDBCProvider) ctx.feeClaimer = inner.configState()?.feeClaimer ?? info.accounts.feeClaimer;
  if (inner instanceof RaydiumLaunchLabProvider) {
    const pc = inner.platformConfigState();
    if (pc) ctx.platform = { cpConfig: pc.cpConfig, platformCpCreator: pc.platformCpCreator ?? null, platformLockNftWallet: pc.platformLockNftWallet };
  }
  return ctx;
}

function lpCheckOf(provider: LaunchProvider) {
  const inner = provider instanceof MigrationAwareProvider ? provider.inner : provider;
  if (inner instanceof MeteoraDBCProvider || inner instanceof RaydiumLaunchLabProvider) return inner.lpCheck;
  return { verification: "not_declared" as const, problems: [] };
}

export function specFor(provider: LaunchProvider, info: PoolInfo, v: VerifiedMigration): DestinationSpec | null {
  const inner = provider instanceof MigrationAwareProvider ? provider.inner : provider;
  const creatorScale = inner instanceof RaydiumLaunchLabProvider ? (inner.platformConfigState()?.creatorScale?.toString() ?? null) : null;
  return destinationSpec(info, v, lpCheckOf(provider), { creatorScale });
}

export async function resolveAndAttachMigration(db: Models, rpc: ChainRpc, provider: LaunchProvider): Promise<{ status: MigrationStatus; verified: VerifiedMigration | null; spec: DestinationSpec | null }> {
  const info = provider instanceof MigrationAwareProvider ? provider.inner.info() : provider.info();
  if (info.provider === "mock" || info.status !== "migrated") return { status: "not_found", verified: null, spec: null };
  const m = await findMigration(rpc, info.provider, info.poolAddress);
  if (!m) return { status: "not_found", verified: null, spec: null };
  const v = await verifyMigration(rpc, m, verifyContextOf(provider, info));
  const verified = migrationVerified(v);
  const spec = verified ? specFor(provider, info, v) : null;
  const status: MigrationStatus = !v.supported ? "unsupported" : verified && spec ? "verified" : "unverified";
  await db.Pool.updateOne(
    { key: `${info.provider}:${info.poolAddress}` },
    { $set: { migration: jsonSafe({ ...v, verified: status === "verified", status, spec, resolvedAt: new Date() }) } },
  );
  if (provider instanceof MigrationAwareProvider) provider.attach(spec);
  return { status, verified: v, spec };
}

/** Re-attach the destination recorded (and verified) by the indexer — used by the rewards worker. */
export async function attachStoredMigration(db: Models, provider: LaunchProvider): Promise<boolean> {
  if (!(provider instanceof MigrationAwareProvider)) return false;
  const info = provider.inner.info();
  const doc: any = await db.Pool.findOne({ key: `${info.provider}:${info.poolAddress}` }, { migration: 1 }).lean();
  const spec: DestinationSpec | null = doc?.migration?.status === "verified" && doc.migration.spec ? doc.migration.spec : null;
  // The spec must belong to this pool and beneficiary; anything else is ignored (fail safe).
  if (spec && (spec.ctx.sourcePool !== info.poolAddress || spec.ctx.beneficiary !== info.beneficiary)) return provider.attach(null);
  return provider.attach(spec);
}
