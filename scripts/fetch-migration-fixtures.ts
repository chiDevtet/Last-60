/**
 * Collects REAL mainnet graduation evidence for test/fixtures/mainnet/migration-*.json:
 * the migration transaction of a bonding pool plus the destination pool / position / NFT accounts.
 * Read-only (getSignaturesForAddress, getTransaction, getAccountInfo); public chain data only.
 *
 * Usage: bun scripts/fetch-migration-fixtures.ts <meteora_dbc|raydium_launchlab> <bondingPool> <outName> [rpcUrl]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { findMigration } from "../packages/engine/src/providers/migration";

const [provider, pool, outName, url] = process.argv.slice(2) as ["meteora_dbc" | "raydium_launchlab", string, string, string | undefined];
if (!provider || !pool || !outName) throw new Error("usage: fetch-migration-fixtures.ts <provider> <bondingPool> <outName> [rpcUrl]");
const rpc = new RpcClient({ urls: [url ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: 4, retries: 8 });
const m = await findMigration(rpc, provider, pool);
if (!m) throw new Error("no migration transaction found");
const tx = await rpc.getTransactionRaw(m.signature, "finalized");
const addresses = [pool, m.destinationPool, ...(m.destinationConfig ? [m.destinationConfig] : []), ...m.positions.flatMap((p) => [p.position, p.nftAccount])];
const { slot, value } = await rpc.getMultipleAccounts(addresses, "finalized");
const accounts = Object.fromEntries(addresses.map((a, i) => [a, value[i] ? { owner: value[i]!.owner, data: value[i]!.data.toString("base64") } : null]));
writeFileSync(join(import.meta.dir, "../packages/engine/test/fixtures/mainnet", outName), JSON.stringify({ slot, provider, bondingPool: pool, migration: { ...m }, tx, accounts }));
console.log("saved", outName, { signature: m.signature, destination: m.destinationPool, accountsSlot: slot });
