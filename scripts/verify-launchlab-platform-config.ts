/**
 * Operator tool (READ-ONLY): fetch, decode, validate and explain a Raydium LaunchLab PlatformConfig —
 * by default Forgepad's own (5zZFa8KitVsp3qGDvCQeDZgn5YEKxAASA5EQTjVzobcX) — and the CPMM AmmConfig it
 * names, then print the accounting interpretation of every fee stream, separating what this
 * configuration CONFIRMS from what needs a specific launch pool or migration transaction.
 * Only getAccountInfo is used. Nothing is signed or sent.
 *
 * Usage:
 *   SOLANA_RPC_URL=… bun scripts/verify-launchlab-platform-config.ts [PLATFORM_CONFIG] [--pool POOL] [--json]
 *
 * Exit code: 0 decoded and validated · 2 account missing · 3 wrong owner · 4 unsupported layout /
 * decoding ambiguity / out-of-range values · 5 cpswap_config is not a CPMM AmmConfig · 6 pool not
 * bound to this PlatformConfig · 1 error.
 */
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { checkLaunchLabPlatformConfig, PLATFORM_CHECK_EXIT } from "../packages/engine/src/accounting/launchlabPlatformCheck";
import { FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG, renderPlatformConfigReport } from "../packages/engine/src/accounting/launchlabPlatform";
import { jsonSafe } from "../packages/engine/src/util/json";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--pool");
const address = positional[0] ?? process.env.EXPECTED_LAUNCHLAB_PLATFORM_CONFIG ?? FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG;

try {
  const rpc = new RpcClient({ urls: [process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"], maxRps: Number(process.env.RPS ?? 4), retries: 6 });
  const r = await checkLaunchLabPlatformConfig(rpc, address, { pool: opt("--pool") ?? process.env.POOL_ADDRESS ?? null });
  if (flag("--json")) console.log(JSON.stringify(jsonSafe(r), null, 2));
  else {
    console.log(renderPlatformConfigReport({ ...r, owner: r.owner ?? "(none)" }));
    if (r.pool) console.log(`\n  pool ${r.pool.address}: ${r.pool.bound ? "BOUND to this PlatformConfig" : `NOT bound (uses ${r.pool.platformConfig})`}`);
    console.log(`\n  RPC ${rpc.endpoint} · read-only (getAccountInfo) · nothing signed or sent`);
  }
  process.exit(PLATFORM_CHECK_EXIT[r.code]);
} catch (e) {
  console.error(`verify-launchlab-platform-config: ${(e as Error).message}`);
  process.exit(1);
}
