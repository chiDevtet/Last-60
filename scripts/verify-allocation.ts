/**
 * Operator tool (READ-ONLY): verify a launch's creator allocation against the operator declaration
 * (EXPECTED_* env) — or, with --forgepad, against Forgepad's intended targets — and print who the
 * beneficiary is, which mint fees are in, the on-chain values and the verification outcome.
 * Nothing is signed or sent; only getAccountInfo / getSignaturesForAddress / getTransaction are used.
 *
 * Usage:
 *   LAUNCH_PROVIDER=meteora_dbc POOL_ADDRESS=… TOKEN_MINT=… [FEE_BENEFICIARY_ROLE=creator] \
 *   [EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE=75 EXPECTED_DBC_CREATOR_LP_PERCENTAGE=75] \
 *   SOLANA_RPC_URL=… bun scripts/verify-allocation.ts [--forgepad] [--json]
 *
 * Exit code: 0 verified · 2 mismatch / unverifiable · 3 not declared · 1 error.
 */
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { createProvider, MigrationAwareProvider } from "../packages/engine/src/providers";
import { findMigration, migrationVerified, verifyMigration } from "../packages/engine/src/providers/migration";
import { specFor, verifyContextOf } from "../packages/engine/src/providers/migrationAttach";
import { buildAllocationReport, FORGEPAD_INTENDED, renderAllocationReport } from "../packages/engine/src/accounting/allocationReport";
import type { ExpectedAllocation } from "../packages/engine/src/config/env";

const args = new Set(process.argv.slice(2));
const env = process.env;
const id = (env.LAUNCH_PROVIDER ?? "") as "meteora_dbc" | "raydium_launchlab";
if (id !== "meteora_dbc" && id !== "raydium_launchlab") throw new Error("LAUNCH_PROVIDER must be meteora_dbc or raydium_launchlab");
if (!env.POOL_ADDRESS || !env.TOKEN_MINT) throw new Error("POOL_ADDRESS and TOKEN_MINT are required");
const role = (env.FEE_BENEFICIARY_ROLE ?? "creator") as "creator" | "partner" | "platform";
const int = (v: string | undefined) => (v && /^\d+$/.test(v.trim()) ? Number(v) : null);
const expected: ExpectedAllocation = {
  dbcCreatorTradingFeePercentage: int(env.EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE),
  dbcCreatorLpPercentage: int(env.EXPECTED_DBC_CREATOR_LP_PERCENTAGE),
  launchlabCreatorFeeRate: int(env.EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE),
  launchlabCreatorLpScale: int(env.EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE),
};
if (args.has("--forgepad")) for (const t of FORGEPAD_INTENDED[id]) expected[t.key] ??= t.value;

const rpc = new RpcClient({ urls: [env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: Number(env.RPS ?? 4), retries: 6 });
const provider = createProvider({ id, poolAddress: env.POOL_ADDRESS, tokenMint: env.TOKEN_MINT, role, payoutMint: env.PAYOUT_ASSET_MINT ?? "So11111111111111111111111111111111111111112", expected }, rpc) as MigrationAwareProvider;
await provider.load();
const inner: any = provider.inner;
let info = provider.info();
let migration: Record<string, unknown> | null = null;
if (info.status === "migrated") {
  const m = await findMigration(rpc, id, info.poolAddress);
  if (m) {
    const v = await verifyMigration(rpc, m, verifyContextOf(provider, info));
    const spec = migrationVerified(v) ? specFor(provider, info, v) : null;
    provider.attach(spec);
    info = provider.info();
    migration = { kind: m.kind, destination: m.destinationPool, signature: m.signature, slot: m.slot, supported: v.supported, verified: !!spec, failed: v.failed, notes: v.notes };
  } else migration = { found: false };
}
const report = buildAllocationReport(info, expected, inner.lpCheck);
if (args.has("--json")) console.log(JSON.stringify({ ...report, migration, declaredFrom: args.has("--forgepad") ? "EXPECTED_* env, missing values filled with Forgepad intended targets" : "EXPECTED_* env" }, null, 2));
else {
  console.log(renderAllocationReport(report));
  if (migration) console.log(`\n  graduation: ${JSON.stringify(migration)}`);
  if (args.has("--forgepad")) console.log("\n  (declarations not set in the environment were filled with Forgepad's intended targets for this check)");
}
process.exit(report.outcome === "verified" ? 0 : report.outcome === "not_declared" ? 3 : 2);
