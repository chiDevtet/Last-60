/**
 * Collects REAL mainnet graduation evidence for test/fixtures/mainnet/migration-*.json:
 * the migration transaction of a bonding pool plus every account the strict verifier reads —
 * destination pool, destination config, DAMM v2 positions + NFT accounts, LaunchLab LP-lock accounts
 * + fee-key NFT accounts, and the source config (DBC PoolConfig / LaunchLab PlatformConfig).
 * Read-only (getSignaturesForAddress, getTransaction, getAccountInfo); public chain data only.
 *
 * Usage: bun scripts/fetch-migration-fixtures.ts <meteora_dbc|raydium_launchlab> <bondingPool> <outName> [rpcUrl] [--augment]
 *   --augment  keep the stored transaction and accounts; only add accounts that are missing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { normalizeTransaction } from "../packages/engine/src/chain/tx";
import { findMigration, parseMigration } from "../packages/engine/src/providers/migration";
import { MeteoraDBCProvider } from "../packages/engine/src/providers/meteora/MeteoraDBCProvider";
import { decodeLaunchLabPool } from "../packages/engine/src/providers/raydium/RaydiumLaunchLabProvider";

const args = process.argv.slice(2).filter((a) => a !== "--augment");
const augment = process.argv.includes("--augment");
const [provider, pool, outName, url] = args as ["meteora_dbc" | "raydium_launchlab", string, string, string | undefined];
if (!provider || !pool || !outName) throw new Error("usage: fetch-migration-fixtures.ts <provider> <bondingPool> <outName> [rpcUrl] [--augment]");
const rpc = new RpcClient({ urls: [url ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: 3, retries: 8 });
const path = join(import.meta.dir, "../packages/engine/test/fixtures/mainnet", outName);
const prev = augment && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;

const tx = prev?.tx ?? (await (async () => {
  const m = await findMigration(rpc, provider, pool);
  if (!m) throw new Error("no migration transaction found");
  return rpc.getTransactionRaw(m.signature, "finalized");
})());
const m = parseMigration(normalizeTransaction(tx), provider, pool);
if (!m) throw new Error("fixture transaction is not a migration of this pool");

const addresses = new Set<string>([pool, m.destinationPool, ...(m.destinationConfig ? [m.destinationConfig] : []), ...m.positions.flatMap((p) => [p.position, p.nftAccount]), ...(m.locks ?? []).flatMap((l) => [l.lockPda, l.nftAccount])]);
// Source configuration (needed to check creator / partner / platform relationships).
const bonding = (await rpc.getAccountInfo(pool, "finalized")).value;
if (bonding) {
  if (provider === "meteora_dbc") addresses.add(new MeteoraDBCProvider(null, { poolAddress: pool, tokenMint: m.baseMint, role: "creator" }).decodePool(bonding.data).config);
  else addresses.add(decodeLaunchLabPool(bonding.data).platformConfig);
}
const missing = [...addresses].filter((a) => !prev?.accounts?.[a]);
const { slot, value } = await rpc.getMultipleAccounts(missing, "finalized");
const accounts = { ...(prev?.accounts ?? {}), ...Object.fromEntries(missing.map((a, i) => [a, value[i] ? { owner: value[i]!.owner, data: value[i]!.data.toString("base64") } : null])) };
writeFileSync(path, JSON.stringify({ slot: prev?.slot ?? slot, ...(prev ? { augmentedSlot: slot } : {}), provider, bondingPool: pool, migration: { ...m, locks: m.locks?.map((l) => ({ ...l, lpAmount: l.lpAmount.toString() })) }, tx, accounts }));
console.log("saved", outName, { signature: m.signature, destination: m.destinationPool, added: missing, accountsSlot: slot });
