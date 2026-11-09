/**
 * Phase-aware revenue report (read-only): bonding-curve creator fees and their Last-60 contribution,
 * CPMM creator fees, Forge platform LP claims and their Last-60 contribution, and buyer-reward funding
 * balances — every stream separately, per fee mint. Reads MongoDB only (plus getSlot); never signs.
 *
 * Usage: bun run report:revenue [--pool <bondingPool>] [--json]
 * Exit code: 0 no discrepancies · 2 reconciliation discrepancies or unresolved funding present.
 */
import { buildRevenueReport, connectDatabase, jsonSafe, loadConfig, renderRevenueReport, resolveFundingActivation, RpcClient } from "../packages/engine/src";

const args = process.argv.slice(2);
const poolArg = args.includes("--pool") ? args[args.indexOf("--pool") + 1] : undefined;
const cfg = loadConfig("cli");
const db = await connectDatabase(cfg.mongo.uri, cfg.mongo.dbName, { syncIndexes: false });
try {
  const rpc = new RpcClient({ urls: cfg.solana.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
  await resolveFundingActivation(cfg, db, rpc);
  const slot = await rpc.getSlot("confirmed").catch(() => null);
  const r = await buildRevenueReport(db, { sourcePool: poolArg ?? cfg.provider.poolAddress, policy: cfg.revenue.policy, currentSlot: slot });
  console.log(args.includes("--json") ? JSON.stringify(jsonSafe(r), null, 2) : renderRevenueReport(r));
  process.exitCode = r.buyerRewards.reconciliationDiscrepancies.length || r.buyerRewards.unlinkedFundingInflows.count ? 2 : 0;
} finally {
  await db.close();
}
