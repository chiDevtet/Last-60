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
  const pc = inner instanceof RaydiumLaunchLabProvider ? inner.platformConfigState() : null;
  const expectedCpmmCreatorFeeRate = inner instanceof RaydiumLaunchLabProvider ? (inner.expectedAllocation()?.cpmmCreatorFeeRate ?? null) : null;
  return destinationSpec(info, v, lpCheckOf(provider), pc ? { creatorScale: pc.creatorScale?.toString() ?? null, platformScale: pc.platformScale?.toString() ?? null, platformNftWallet: pc.platformLockNftWallet ?? null, expectedCpmmCreatorFeeRate } : {});
}

export type MigrationOutcome = MigrationStatus | "conflict";

/** Supported source → destination kinds. Everything else is unsupported and never attached. */
const SUPPORTED_KIND: Record<string, DestinationSpec["kind"]> = { meteora_dbc: "dbc_damm_v2", raydium_launchlab: "launchlab_cpmm" };

/** The facts that identify ONE graduation. A verified spec is only ever reused for the same facts. */
function identityOf(x: { kind: string; pool?: string; destinationPool?: string; program?: string; destinationProgram?: string; ctx?: { sourcePool: string; migrationSignature: string; migrationSlot: number }; bondingPool?: string; signature?: string; slot?: number }) {
  return JSON.stringify([x.kind, x.pool ?? x.destinationPool, x.program ?? x.destinationProgram, x.ctx?.sourcePool ?? x.bondingPool, x.ctx?.migrationSignature ?? x.signature, x.ctx?.migrationSlot ?? x.slot]);
}

/**
 * Pure: why a persisted destination spec must NOT be attached to this loaded launch (empty = ok).
 * The spec must describe a supported graduation OF THIS bonding pool, for this provider, beneficiary,
 * role and mint pair, with a self-consistent allocation basis — and the stored verification record
 * it came from must still show every required check true.
 */
export function storedSpecProblems(info: PoolInfo, migration: any): string[] {
  const p: string[] = [];
  const spec: DestinationSpec | null = migration?.spec ?? null;
  if (!migration || migration.status !== "verified" || migration.verified !== true) p.push(`stored migration status is "${migration?.status ?? "none"}", not verified`);
  if (!spec) return [...p, "no stored destination spec"];
  const required: string[] = Array.isArray(migration.requiredChecks) ? migration.requiredChecks : [];
  if (!required.length || !required.every((c) => migration.checks?.[c] === true)) p.push("stored verification record does not show every required check passing");
  if (migration.supported !== true) p.push("stored migration is not a supported destination");
  if (SUPPORTED_KIND[info.provider] !== spec.kind) p.push(`destination kind ${spec.kind} is not the supported path for ${info.provider}`);
  if (spec.ctx.sourceProvider !== info.provider) p.push(`spec provider ${spec.ctx.sourceProvider} ≠ ${info.provider}`);
  if (spec.ctx.sourcePool !== info.poolAddress) p.push(`spec source pool ${spec.ctx.sourcePool} ≠ ${info.poolAddress}`);
  if (spec.ctx.beneficiary !== info.beneficiary) p.push(`spec beneficiary ${spec.ctx.beneficiary} ≠ ${info.beneficiary}`);
  if (spec.ctx.baseMint !== info.tokenMint || spec.ctx.quoteMint !== info.quoteMint) p.push("spec mints differ from the launch's mints");
  if (migration.destinationPool && migration.destinationPool !== spec.pool) p.push("spec pool differs from the verified destination pool");
  if (migration.signature && migration.signature !== spec.ctx.migrationSignature) p.push("spec migration signature differs from the verified migration");
  for (const b of [spec.allocation, spec.lpAllocation].filter(Boolean) as DestinationSpec["allocation"][]) {
    if (b.pool !== spec.pool || b.role !== info.feeBeneficiaryRole || b.beneficiary !== info.beneficiary || b.provider !== info.provider) p.push(`destination basis ${b.id} does not belong to this pool / role / beneficiary / provider`);
  }
  return p;
}

/**
 * Find, strictly verify and persist the graduation of the loaded bonding pool, then attach the
 * destination FROM THE PERSISTED RECORD (so the indexer and the rewards worker always attach the
 * exact same spec). Re-running is idempotent and never rewrites a verified spec:
 *   - same graduation, still verified  → the ORIGINAL spec (and its allocation snapshots) is kept;
 *   - same graduation, now failing     → detached (status unverified), original kept as history;
 *   - a DIFFERENT graduation is found  → status "conflict", detached; operator review required.
 */
export async function resolveAndAttachMigration(db: Models, rpc: ChainRpc, provider: LaunchProvider): Promise<{ status: MigrationOutcome; verified: VerifiedMigration | null; spec: DestinationSpec | null }> {
  const info = provider instanceof MigrationAwareProvider ? provider.inner.info() : provider.info();
  if (info.provider === "mock" || info.status !== "migrated") return { status: "not_found", verified: null, spec: null };
  const m = await findMigration(rpc, info.provider, info.poolAddress);
  if (!m) return { status: "not_found", verified: null, spec: null };
  const v = await verifyMigration(rpc, m, verifyContextOf(provider, info));
  const verified = migrationVerified(v);
  const fresh = verified ? specFor(provider, info, v) : null;
  const key = { key: `${info.provider}:${info.poolAddress}` };
  const doc: any = await db.Pool.findOne(key, { migration: 1 }).lean();
  const prior: DestinationSpec | null = doc?.migration?.spec ?? doc?.migration?.verifiedSpec ?? null;
  let status: MigrationOutcome = !v.supported ? "unsupported" : verified && fresh ? "verified" : "unverified";
  let spec: DestinationSpec | null = status === "verified" ? fresh : null;
  if (prior && identityOf(prior) !== identityOf({ ...m, kind: m.kind })) {
    status = "conflict";
    spec = null;
    v.notes.push(`a different graduation (${m.kind} ${m.destinationPool}, tx ${m.signature}) was found than the one previously verified (${prior.kind} ${prior.pool}, tx ${prior.ctx.migrationSignature}); destination detached — operator review required`);
  } else if (prior && status === "verified") {
    spec = prior; // never rewrite the allocation snapshots of an already-verified graduation
  }
  await db.Pool.updateOne(key, {
    $set: {
      migration: jsonSafe({ ...v, verified: status === "verified", status, spec, verifiedSpec: prior ?? spec, resolvedAt: new Date(), ...(prior ? { reverifiedAt: new Date() } : {}) }),
    },
  });
  if (provider instanceof MigrationAwareProvider) await attachStoredMigration(db, provider);
  return { status, verified: v, spec };
}

/**
 * Attach the destination recorded (and verified) on `pools.migration` — used by both workers, at
 * start and on every refresh. Anything that does not belong to this exact launch is refused and the
 * destination is detached (fail safe): nothing from an unverified, stale or mismatched destination
 * reaches fee accounting or buyer tracking.
 */
export async function attachStoredMigration(db: Models, provider: LaunchProvider): Promise<boolean> {
  if (!(provider instanceof MigrationAwareProvider)) return false;
  const info = provider.inner.info();
  const doc: any = await db.Pool.findOne({ key: `${info.provider}:${info.poolAddress}` }, { migration: 1 }).lean();
  if (!doc?.migration?.spec) return provider.attach(null);
  const problems = storedSpecProblems(info, doc.migration);
  if (problems.length) {
    lastAttachProblems.set(info.poolAddress, problems);
    return provider.attach(null);
  }
  lastAttachProblems.delete(info.poolAddress);
  return provider.attach(doc.migration.spec);
}

const lastAttachProblems = new Map<string, string[]>();
/** Why the stored destination of a pool was last refused (for logs / operator reports). */
export function storedMigrationRefusal(pool: string): string[] | null {
  return lastAttachProblems.get(pool) ?? null;
}
