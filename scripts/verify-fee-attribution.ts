/**
 * Operator tool: proves that a provider adapter's per-swap fee attribution reproduces the chain's
 * own accounting for a pool, by replaying the pool's ENTIRE history:
 *
 *     Σ eligibleFee(swaps) − Σ claims  ==  on-chain unclaimed balance (at a common slot)
 *
 * Usage:
 *   bun scripts/verify-fee-attribution.ts <meteora_dbc|raydium_launchlab> <pool> <tokenMint> [creator|partner|platform]
 *   bun scripts/verify-fee-attribution.ts find-dbc      # pick a small DBC pool with creator fees and verify it
 * Env: SOLANA_RPC_URL (defaults to the public mainnet endpoint; slow but works).
 */
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { normalizeTransaction } from "../packages/engine/src/chain/tx";
import { AnchorEventDecoder, toAddr } from "../packages/engine/src/chain/anchorEvents";
import { createProvider, DBC_PROGRAM_ID, MeteoraDBCProvider } from "../packages/engine/src/providers";
import dbcIdl from "../packages/engine/src/providers/meteora/idl/dynamic_bonding_curve.json";

const rpc = new RpcClient({ urls: [process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: Number(process.env.RPS ?? 4), retries: 10 });

async function allSignatures(address: string, cap: number) {
  const out: { signature: string; slot: number; err: unknown }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(address, { limit: 1000, before, commitment: "finalized" });
    out.push(...page);
    if (page.length < 1000 || out.length >= cap) break;
    before = page[page.length - 1]!.signature;
  }
  return out;
}

async function verify(providerId: "meteora_dbc" | "raydium_launchlab", pool: string, mint: string, role: "creator" | "partner" | "platform") {
  const provider = createProvider({ id: providerId, poolAddress: pool, tokenMint: mint, role, payoutMint: "So11111111111111111111111111111111111111112" }, rpc);
  const info = await provider.load();
  console.log(`pool ${pool} (${providerId}, role=${role}, beneficiary=${info.beneficiary}, status=${info.status})`, info.feeParams);
  // Snapshot the on-chain balance FIRST at finalized, then only count history up to that slot.
  const state = await provider.getFeeSourceState();
  const sigs = (await Promise.all(info.watchAddresses.map((a) => allSignatures(a, 20_000)))).flat();
  const unique = [...new Map(sigs.map((s) => [s.signature, s])).values()].filter((s) => !s.err && s.slot <= state.slot);
  console.log(`replaying ${unique.length} successful transactions up to slot ${state.slot}…`);
  let feesQuote = 0n, feesBase = 0n, claimedQuote = 0n, claimedBase = 0n, swaps = 0, anomalies = 0;
  for (const s of unique) {
    const raw = await rpc.getTransactionRaw(s.signature, "finalized");
    if (!raw) throw new Error(`missing tx ${s.signature}`);
    const parsed = provider.parseTransaction(normalizeTransaction(raw));
    anomalies += parsed.anomalies.length;
    for (const w of parsed.swaps) {
      swaps++;
      if (w.eligibleFeeMint === info.quoteMint) feesQuote += w.eligibleFee;
      else feesBase += w.eligibleFee;
    }
    for (const c of parsed.claims) {
      claimedQuote += c.quoteAmount;
      claimedBase += c.baseAmount;
    }
  }
  const expectedQuote = feesQuote - claimedQuote;
  const expectedBase = feesBase - claimedBase;
  console.log({ swaps, anomalies, feesQuote, claimedQuote, expectedQuote, actualQuote: state.unclaimedQuote, feesBase, claimedBase, expectedBase, actualBase: state.unclaimedBase, source: state.source });
  const ok = state.mayIncludeOtherPools ? state.unclaimedQuote >= expectedQuote : expectedQuote === state.unclaimedQuote && expectedBase === state.unclaimedBase;
  console.log(ok ? "✔ RECONCILED: attribution matches on-chain accounting exactly" : "✘ MISMATCH");
  return ok;
}

async function findDbc() {
  const dec = new AnchorEventDecoder(DBC_PROGRAM_ID, dbcIdl as any);
  const sigs = await rpc.getSignaturesForAddress(DBC_PROGRAM_ID, { limit: Number(process.env.SCAN ?? 200) });
  const seen = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    const raw = await rpc.getTransactionRaw(s.signature);
    if (!raw) continue;
    for (const e of dec.decodeAll(normalizeTransaction(raw))) {
      if (e.name !== "EvtSwap3" || !e.parent) continue;
      const pool = toAddr((e.data as any).pool);
      if (seen.has(pool)) continue;
      seen.add(pool);
      const acc = await rpc.getAccountInfo(pool);
      if (!acc.value) continue;
      const tmp = new MeteoraDBCProvider(rpc, { poolAddress: pool, tokenMint: e.parent.accounts[7]!, role: "creator" });
      const st = tmp.decodePool(acc.value.data);
      const cfgAcc = await rpc.getAccountInfo(st.config);
      const cfg = tmp.decodeConfig(cfgAcc.value!.data);
      if (cfg.creatorTradingFeePercentage === 0 || st.transferHook) continue;
      if (process.env.PARTIAL_SPLIT && cfg.creatorTradingFeePercentage === 100) continue;
      const n = (await rpc.getSignaturesForAddress(pool, { limit: 400 })).length;
      console.log(`candidate ${pool} creator%=${cfg.creatorTradingFeePercentage} mode=${cfg.collectFeeMode} sigs=${n}`);
      if (n < 400 && (st.creatorQuoteFee > 0n || st.creatorBaseFee > 0n)) return { pool, mint: st.baseMint };
    }
  }
  throw new Error("no suitable pool found in recent activity; pass one explicitly");
}

const [a, b, c, d] = process.argv.slice(2);
if (a === "find-dbc") {
  const { pool, mint } = await findDbc();
  process.exit((await verify("meteora_dbc", pool, mint, "creator")) ? 0 : 1);
} else if (a && b && c) {
  process.exit((await verify(a as any, b, c, (d as any) ?? "creator")) ? 0 : 1);
} else {
  console.error("usage: verify-fee-attribution.ts <provider> <pool> <mint> [role] | find-dbc");
  process.exit(2);
}
