/**
 * Independent, public verifier for a settled round. Uses ONLY the public API (snapshot slots,
 * payouts) and a Solana RPC — not the database — to re-derive who should have been paid:
 *
 *   recipients = most recent BUYER_COUNT unique wallets whose latest qualifying buy lies in
 *                (previous round's snapshot slot, this round's snapshot slot]
 *
 * Usage: bun scripts/verify-round.ts <roundNumber> [--fees] [--from-slot=N]
 * Env:   API_URL (default http://localhost:4000), SOLANA_RPC_URL, LAUNCH_PROVIDER, POOL_ADDRESS,
 *        TOKEN_MINT, FEE_BENEFICIARY_ROLE  (the same public values the site shows)
 */
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { normalizeTransaction } from "../packages/engine/src/chain/tx";
import { createProvider } from "../packages/engine/src/providers";

const n = Number(process.argv[2]);
const withFees = process.argv.includes("--fees");
const API = process.env.API_URL ?? "http://localhost:4000";
const rpc = new RpcClient({ urls: [process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: Number(process.env.RPS ?? 4), retries: 10 });
const get = async (p: string) => {
  const r = await fetch(`${API}${p}`);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};

const round = await get(`/api/v1/rounds/${n}`);
const prev = await get(`/api/v1/rounds/${n - 1}`).catch(() => null);
if (!round.snapshotSlot) throw new Error("round has no snapshot");
const fromArg = process.argv.find((a) => a.startsWith("--from-slot="));
const lower: number | null = fromArg ? Number(fromArg.split("=")[1]) : (prev?.snapshotSlot ?? null);
const upper: number = round.snapshotSlot;
const provider = createProvider({ id: (process.env.LAUNCH_PROVIDER as any) ?? "meteora_dbc", poolAddress: process.env.POOL_ADDRESS!, tokenMint: process.env.TOKEN_MINT!, role: (process.env.FEE_BENEFICIARY_ROLE as any) ?? "creator", payoutMint: "So11111111111111111111111111111111111111112" }, rpc);
const info = await provider.load();
console.log(`round #${n}: period slots (${lower ?? "genesis"}, ${upper}], min buy ${round.minBuy}, buyer count ${round.buyerCount}, pool ${info.poolAddress}`);

// Walk signatures newest → oldest from the snapshot slot down to the previous snapshot slot.
const winners: { wallet: string; slot: number; pos: number; sig: string }[] = [];
const seen = new Set<string>();
let feeTotal = 0n;
let before: string | undefined;
let done = false;
const blockOrder = new Map<number, string[]>();
outer: for (;;) {
  const page = await rpc.getSignaturesForAddress(info.poolAddress, { before, limit: 1000, commitment: "finalized" });
  if (!page.length) break;
  before = page[page.length - 1]!.signature;
  for (const s of page) {
    if (s.slot > upper || s.err) continue;
    if (lower !== null && s.slot <= lower) break outer;
    if (done && !withFees) break outer;
    const raw = await rpc.getTransactionRaw(s.signature, "finalized");
    if (!raw) throw new Error(`missing ${s.signature}`);
    const parsed = provider.parseTransaction(normalizeTransaction(raw));
    for (const sw of parsed.swaps) {
      if (sw.eligibleFeeMint === info.quoteMint) feeTotal += sw.eligibleFee;
      if (done || sw.side !== "buy" || sw.quoteAmount < BigInt(round.minBuy) || seen.has(sw.trader)) continue;
      if ([info.beneficiary, info.creator].includes(sw.trader)) continue;
      if (!blockOrder.has(sw.slot)) blockOrder.set(sw.slot, (await rpc.getBlockSignatures(sw.slot)) ?? []);
      seen.add(sw.trader);
      winners.push({ wallet: sw.trader, slot: sw.slot, pos: blockOrder.get(sw.slot)!.indexOf(sw.signature), sig: sw.signature });
      // Keep collecting while the boundary slot may still change the order.
      if (winners.length >= round.buyerCount && winners[winners.length - 1]!.slot !== winners[round.buyerCount - 1]!.slot) done = true;
    }
  }
  if (page.length < 1000) break;
}
winners.sort((a, b) => b.slot - a.slot || b.pos - a.pos);
const expected = winners.slice(0, round.buyerCount).map((w) => w.wallet).sort();
const actual = round.payouts.map((p: any) => p.recipient).sort();
console.log("derived from chain:", expected);
console.log("paid by engine:    ", actual);
const recipientsOk = JSON.stringify(expected) === JSON.stringify(actual);
console.log(recipientsOk ? "✔ recipients verified against the chain" : "✘ recipient mismatch");
if (withFees) {
  console.log(`eligible fees from chain: ${feeTotal}  engine: ${round.fees}  ${String(feeTotal) === round.fees ? "✔ fees verified" : "✘ fee mismatch"}`);
  const reward = (feeTotal * BigInt(round.rewardBps)) / 10_000n + BigInt(round.rolloverIn);
  console.log(`reward (${round.rewardBps} bps + rollover): ${reward}  engine: ${round.reward}  ${String(reward) === round.reward ? "✔" : "✘"}`);
}
process.exit(recipientsOk ? 0 : 1);
