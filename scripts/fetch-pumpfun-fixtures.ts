/**
 * Collects REAL mainnet pump.fun / PumpSwap transactions and account snapshots for the provider tests.
 * Usage: bun scripts/fetch-pumpfun-fixtures.ts [rpcUrl]
 * Output: packages/engine/test/fixtures/mainnet/pumpfun-{txs,graduation}.json (public chain data only).
 *
 * The transactions are named by what they exercise; the signatures were found by scanning finalized
 * blocks around slot 468 605 800 for each instruction of the two programs (IDLs vendored in
 * packages/engine/src/providers/pumpfun/idl and …/destination/idl).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { normalizeTransaction } from "../packages/engine/src/chain/tx";
import { instructionDiscriminator } from "../packages/engine/src/chain/anchorEvents";
import { canonicalPumpSwapPool, derivePumpBondingCurve, pumpCreatorVault, pumpSwapCreatorVaultAta, PUMP_AMM_PROGRAM_ID } from "../packages/engine/src/providers/pumpfun/pda";
import { decodePumpBondingCurve } from "../packages/engine/src/providers/pumpfun/PumpFunProvider";
import { decodePumpSwapPool } from "../packages/engine/src/providers/destination/pumpSwap";

const OUT = join(import.meta.dir, "../packages/engine/test/fixtures/mainnet");
mkdirSync(OUT, { recursive: true });
const rpc = new RpcClient({ urls: [process.argv[2] ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: 4, retries: 8 });

const TXS: Record<string, string> = {
  // pump (bonding curve)
  "bonding-buy-legacy": "3Q2Nwp6LXtj1zqMC3XpAXYSx83gk57DSi1nALfF52CsDDpo4gJFa7BmGXuyZ3W9Hmj2azY2Db92aMTdodoM9nVb",
  "bonding-sell-legacy": "3pErmqST6vdYVGXCQmNUfq8FEi9GygT117pY6FZoSkftfbVN1xbUgHHsGJh4nxXqMb12ue3NpNgesdavGkXhmniB",
  "bonding-buy-exact-sol-in": "4voT2AeJY2LGJePaHbZ63GS3AhioRY86WQmwGXesmLxypiNVALaqnUetqUoXNjWdLZJnLE1yr96b67CivCPvpZ4p",
  "bonding-buy-v2": "5f45c2LpYMfGbbj25KgaPMQhC1oTJ9Ai5mGCCSqMMAGqkTXwAbsdVP2VsPSco9jauPQhrAxKmyrCXmrGQh7dQiAa",
  "bonding-sell-v2": "24cnSWUbZPbdxrmvEq9xQ3K7fncsdJGi3Emy8HZhn8sDDGAuFagKPNLKFoPw9nkjZushcKboD1x2oUzCuUASFFug",
  "bonding-buy-v3": "xanLikhz98yTzCU5sf8tA4Bnuya1oid3dDnKT75MfNLpE9WDV3xScLr4Pxg21JbpuUpC5MiKSFy7De5WREBsu8H",
  "bonding-sell-v3": "2rYSnVvNx5AutV37zgh5Ag1mf6zq1Shn1TnGzuihcrugmvCqYpAVxiXi8gruBeRbNqkQwp1bzUcknfQTD78JnnSC",
  "bonding-buy-v3-holder-reward": "4499LfBTn65HYLa4ueaDEbfoQ5oHnkgPBrUMJbnBLp46Bx1cBNe1N63QTLWh3cKVL3pJYSN35jWLDqyLokqr9cPQ",
  "bonding-sweep-crank": "4CdEx5t1xoKSTMdcDfQaKgXkDpT7v9gTtZP3GgyY6j7FFMzNhpiApHD6AEHmXy6KaqBbv9eB693swWtuqCVJr8qy",
  "bonding-sweep-collect": "3EjDgBb4quAZW1PWbYDJHV4azRpJRzEbZ7RhgRXn1j7UeHKBQc8zeZsaEzyUGpTygAjmM52486F3kUeoyxY8h4fu",
  "collect-both-empty": "Gag6WToRuF3MtEQxMGfVdezFQ69Ea6iQcCGMcdqYk1PggDM7MDnsZ3bbsiSVWi9ntpK9f1xoLAKmg8cS2v9xWTY",
  "migrate-v2": "2dvpF8fwupmgyzuTzbiyqCNd7dkqf17HR4xZDbWfKjhz4dem1JDkHwAzcR21TxYMp1yMQQAH979dwk3Veo2D88Gn",
  // pump_amm (PumpSwap)
  "amm-buy": "tph8D4rUJVgK78N9mGXPBAfdPdV8FbcPqVnxurQGtjZhRTb8UCG1VGfuhQ9tjGMGvLQCBzyD9uEi2MEz2EKpVMx",
  "amm-buy-exact-quote-in": "5gKMJHpHGPBXEsdQrEf3gZZdo775vA5MdSgPT9BeSvQCAaMucAY4JAJb8hshuxeiHzLtytUWR97qb6xsYgm6Jv97",
  "amm-sell": "dihvGKYeQDNPtGgALpTHkvWdJRgfchQ3CcZbHFpW3qab1zFdcQfCEneK3g97pv19S7ARYzbzPyc7gpynTWcKY7m",
  "amm-buy-v2": "5b6WNEg1Vus7x9Ef61wxo7s4am7nPBEqxQquV45rCi1HFPMMT3g8gy8ypEESR3H3jZoSsR3qUVdH3rjc7KvCStWS",
  "amm-buy-exact-quote-in-v2": "4oSNsqnrGnwouwZUQM1mEeDbcQzX3C11EGZ7GcHwVZbTG1dppJ5pGTFMqMG84gnPFLCpQTAHE8cT6VGrfAeP3eSM",
  "amm-sell-v2": "3dUDUTyCRZ1MaqvNwGTJ4gBr7Tr3fvW1H4XeBh5iVhXVyKoW2xcsogTxSeY63KEyjfehenkSM4Xn3Pz3q8APE499",
  "amm-sweep-crank": "3HhqYBV29W7wSKqcJjHNygAmFEWjBWrC8mF5TKo341BXuyx81K5zbdtt2YWJkW46YZzHBoHHhgewiUX3iFDJtfvj",
  "amm-sweep-collect": "54phK6fyr93pJbS7NrxXsdJufv6YBrRQWPvwrGjhS5qXezRDhdD3Roc7wJwhzQR1aF8ccxwoGV1ZAbrfz7BUSmm9",
  "amm-collect-token-quote": "4MQe8zZQuvwNtSNR8nG2xenQ891oYYf9KHtq5hEzsKPjonUdQ3bfSdRDXjUEwpr4rJkMEVa5ZAKbwcL2tSkUPZtz",
};

const txs: Record<string, any> = {};
for (const [name, sig] of Object.entries(TXS)) {
  const raw = await rpc.getTransactionRaw(sig, "finalized");
  if (!raw) throw new Error(`transaction ${name} (${sig}) not available from this RPC`);
  txs[name] = raw;
  console.log("fetched", name);
}
writeFileSync(join(OUT, "pumpfun-txs.json"), JSON.stringify(txs));
console.log("saved pumpfun-txs.json");

// Graduation of the coin of `migrate-v2`: account snapshot for strict verification, plus the first
// trades of its PumpSwap pool by instruction kind.
const mig = normalizeTransaction(txs["migrate-v2"]);
const migIx = mig.instructions.find((i) => i.data.subarray(0, 8).equals(instructionDiscriminator("migrate_v2")))!;
const mint = migIx.accounts[2]!;
const curve = derivePumpBondingCurve(mint);
const pool = canonicalPumpSwapPool(mint);
const first = await rpc.getMultipleAccounts([curve, pool, mint], "finalized");
const curveState = decodePumpBondingCurve(first.value[0]!.data);
const poolState = decodePumpSwapPool(first.value[1]!.data);
const addresses = [curve, pool, mint, poolState.poolBaseTokenAccount, poolState.poolQuoteTokenAccount, pumpCreatorVault(curveState.creator), pumpSwapCreatorVaultAta(poolState.coinCreator)];
const snap = await rpc.getMultipleAccounts(addresses, "finalized");
const accounts: Record<string, any> = {};
addresses.forEach((a, i) => {
  const v = snap.value[i];
  if (v) accounts[a] = { owner: v.owner, lamports: v.lamports, data: v.data.toString("base64") };
});
const wanted = new Map(["buy", "buy_exact_quote_in", "sell", "buy_v2", "buy_exact_quote_in_v2", "sell_v2"].map((n) => [instructionDiscriminator(n).toString("hex"), n]));
const poolTxs: Record<string, any> = {};
let before: string | undefined;
for (let page = 0; page < 6 && Object.keys(poolTxs).length < 4; page++) {
  const sigs = await rpc.getSignaturesForAddress(pool, { limit: 100, before });
  if (!sigs.length) break;
  before = sigs[sigs.length - 1]!.signature;
  for (const s of sigs.filter((x) => !x.err).slice(0, 25)) {
    const raw = await rpc.getTransactionRaw(s.signature, "finalized");
    if (!raw) continue;
    for (const ix of normalizeTransaction(raw).instructions) {
      const n = ix.programId === PUMP_AMM_PROGRAM_ID ? wanted.get(ix.data.subarray(0, 8).toString("hex")) : undefined;
      if (n && ix.accounts[0] === pool && !poolTxs[n]) poolTxs[n] = raw;
    }
  }
}
// The crank sweeps name the vault, not the creator: read the creator of each swept curve.
const sweepCreators: Record<string, string> = {};
const SWEEP = instructionDiscriminator("sweep_creator_fee");
for (const ix of normalizeTransaction(txs["bonding-sweep-crank"]).instructions.filter((i) => i.data.subarray(0, 8).equals(SWEEP))) {
  const acc = (await rpc.getAccountInfo(ix.accounts[7]!, "finalized")).value;
  if (acc) sweepCreators[ix.accounts[2]!] = decodePumpBondingCurve(acc.data).creator;
}
writeFileSync(join(OUT, "pumpfun-graduation.json"), JSON.stringify({ slot: snap.slot, mint, bondingCurve: curve, pool, creator: curveState.creator, coinCreator: poolState.coinCreator, migration: txs["migrate-v2"], accounts, poolTxs, sweepCreators }));
console.log("saved pumpfun-graduation.json", { mint, curve, pool, creator: curveState.creator, coinCreator: poolState.coinCreator, poolTxs: Object.keys(poolTxs) });
