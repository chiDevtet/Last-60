/**
 * Finds a busy, SOL-quoted, live (bonding) pool for read-only demos and soak tests.
 *   bun scripts/find-active-pool.ts [meteora_dbc|raydium_launchlab]
 * Prints env lines for TOKEN_MINT / POOL_ADDRESS. Read-only.
 */
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { normalizeTransaction } from "../packages/engine/src/chain/tx";
import { AnchorEventDecoder, enumVariant, toAddr } from "../packages/engine/src/chain/anchorEvents";
import { DBC_PROGRAM_ID, LAUNCHLAB_PROGRAM_ID, MeteoraDBCProvider, RaydiumLaunchLabProvider } from "../packages/engine/src/providers";
import dbcIdl from "../packages/engine/src/providers/meteora/idl/dynamic_bonding_curve.json";
import llIdl from "../packages/engine/src/providers/raydium/idl/raydium_launchpad.json";

const which = (process.argv[2] ?? "meteora_dbc") as "meteora_dbc" | "raydium_launchlab";
const rpc = new RpcClient({ urls: [process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: 4, retries: 8 });
const WSOL = "So11111111111111111111111111111111111111112";
const program = which === "meteora_dbc" ? DBC_PROGRAM_ID : LAUNCHLAB_PROGRAM_ID;
const dec = new AnchorEventDecoder(program, (which === "meteora_dbc" ? dbcIdl : llIdl) as any);
const counts = new Map<string, { n: number; buys: number; mint: string }>();
const sigs = await rpc.getSignaturesForAddress(program, { limit: Number(process.env.SCAN ?? 120) });
for (const s of sigs) {
  if (s.err) continue;
  const raw = await rpc.getTransactionRaw(s.signature);
  if (!raw) continue;
  for (const e of dec.decodeAll(normalizeTransaction(raw))) {
    if (!e.parent) continue;
    if (which === "meteora_dbc" && e.name === "EvtSwap3") {
      const pool = toAddr((e.data as any).pool);
      const c = counts.get(pool) ?? { n: 0, buys: 0, mint: e.parent.accounts[7]! };
      c.n++;
      if (Number((e.data as any).trade_direction) === 1) c.buys++;
      counts.set(pool, c);
    }
    if (which === "raydium_launchlab" && e.name === "TradeEvent") {
      const pool = toAddr((e.data as any).pool_state);
      const c = counts.get(pool) ?? { n: 0, buys: 0, mint: e.parent.accounts[9]! };
      c.n++;
      if (enumVariant((e.data as any).trade_direction) === "buy") c.buys++;
      counts.set(pool, c);
    }
  }
}
const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
for (const [pool, c] of ranked) {
  try {
    const p = which === "meteora_dbc" ? new MeteoraDBCProvider(rpc, { poolAddress: pool, tokenMint: c.mint, role: "creator" }) : new RaydiumLaunchLabProvider(rpc, { poolAddress: pool, tokenMint: c.mint, role: "creator" });
    const info = await p.load();
    const ok = info.quoteMint === WSOL && info.status === "bonding";
    console.log(`${ok ? "✔" : " "} ${pool} trades=${c.n} buys=${c.buys} status=${info.status} quote=${info.quoteMint === WSOL ? "SOL" : info.quoteMint.slice(0, 6)}`, info.feeParams);
    if (ok && (which === "raydium_launchlab" || Number(info.feeParams.creatorTradingFeePercentage) > 0) && info.feeParams.collectFeeMode !== "OutputToken") {
      console.log(`\nLAUNCH_PROVIDER=${which}\nTOKEN_MINT=${info.tokenMint}\nPOOL_ADDRESS=${pool}`);
      process.exit(0);
    }
  } catch (err) {
    console.log("  skip", pool, String(err));
  }
}
console.log("no ideal pool in sample; rerun or raise SCAN");
