/**
 * Resolve and STRICTLY verify where a bonding-curve pool graduated, using exactly the logic the
 * indexer uses (provider load → findMigration → verifyMigration with creator / partner / platform
 * facts → destination spec). Read-only: nothing is signed or sent. Usage:
 *   bun scripts/resolve-migration.ts <meteora_dbc|raydium_launchlab> <bondingPool> <baseMint> [creator|partner|platform] [rpcUrl]
 * Exit code 0 = verified and supported, 2 = unverified or unsupported, 1 = no migration found.
 */
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { createProvider, findMigration, migrationVerified, verifyMigration } from "../packages/engine/src/providers";
import { MigrationAwareProvider } from "../packages/engine/src/providers/MigrationAwareProvider";
import { specFor, verifyContextOf } from "../packages/engine/src/providers/migrationAttach";
import { jsonSafe } from "../packages/engine/src/util/json";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const [provider, pool, base, role, url] = process.argv.slice(2) as ["meteora_dbc" | "raydium_launchlab", string, string, ("creator" | "partner" | "platform") | undefined, string | undefined];
if (!provider || !pool || !base) throw new Error("usage: resolve-migration.ts <provider> <bondingPool> <baseMint> [role] [rpcUrl]");
const rpc = new RpcClient({ urls: [url ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: 4, retries: 6 });
const p = createProvider({ id: provider, poolAddress: pool, tokenMint: base, role: role ?? "creator", payoutMint: WSOL_MINT }, rpc) as MigrationAwareProvider;
const info = await p.load();
const m = await findMigration(rpc, provider, pool);
if (!m) {
  console.log("No migration transaction found for", pool, `(status ${info.status}: still bonding, or migrated long ago — raise maxPages).`);
  process.exit(1);
}
const v = await verifyMigration(rpc, m, verifyContextOf(p, info));
const verified = migrationVerified(v);
const spec = verified ? specFor(p, info, v) : null;
console.log(JSON.stringify(jsonSafe({ verified, supported: v.supported, failed: v.failed, notes: v.notes, allocation: spec ? { destination: spec.allocation, migratedLp: spec.lpAllocation ?? spec.allocation } : null, migration: v }), null, 2));
process.exit(verified && spec ? 0 : 2);
