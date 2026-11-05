/**
 * Resolve and verify where a bonding-curve pool graduated, and who holds the post-graduation fee
 * rights. Read-only. Usage:
 *   bun scripts/resolve-migration.ts <meteora_dbc|raydium_launchlab> <bondingPool> <baseMint> <quoteMint> [rpcUrl]
 */
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { findMigration, migrationVerified, verifyMigration } from "../packages/engine/src/providers/migration";
import { jsonSafe } from "../packages/engine/src/util/json";

const [provider, pool, base, quote, url] = process.argv.slice(2) as ["meteora_dbc" | "raydium_launchlab", string, string, string, string | undefined];
if (!provider || !pool || !base || !quote) throw new Error("usage: resolve-migration.ts <provider> <bondingPool> <baseMint> <quoteMint> [rpcUrl]");
const rpc = new RpcClient({ urls: [url ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: 4 });
const m = await findMigration(rpc, provider, pool);
if (!m) {
  console.log("No migration transaction found for", pool, "(still bonding, or migrated long ago — raise maxPages).");
  process.exit(1);
}
const v = await verifyMigration(rpc, m, { base, quote });
console.log(JSON.stringify(jsonSafe({ verified: migrationVerified(v), ...v }), null, 2));
