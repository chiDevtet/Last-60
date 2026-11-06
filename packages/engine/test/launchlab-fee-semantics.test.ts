/**
 * LaunchLab creator_fee_rate semantics, verified three independent ways (no network):
 *   1. the Raydium SDK's own fee functions (`Curve.calculateFee` / `Curve.splitFee`, SDK 0.2.82-alpha);
 *   2. a real mainnet TradeEvent (fixtures/mainnet/launchlab-buy-creatorfee.json, slot 465800122)
 *      against the real PlatformConfig of its pool (fixtures/mainnet/launchlab-accounts.json);
 *   3. synthetic amounts that separate "0.5% of trade value" from "0.5% of total trading fees".
 * Raydium's documentation (raydium-docs-v1 products/launchlab/platform-config) states
 * MAX_CREATOR_FEE_RATE = 5000 = 50 bps on a 1 000 000 denominator, consistent with all three.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BN } from "@coral-xyz/anchor";
import { Curve } from "@raydium-io/raydium-sdk-v2";
import { normalizeTransaction } from "../src/chain/tx";
import { AnchorEventDecoder, toBig } from "../src/chain/anchorEvents";
import { decodeLaunchLabPlatformConfig, launchLabFeeSplit, LAUNCHLAB_PROGRAM_ID, RaydiumLaunchLabProvider } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import llIdl from "../src/providers/raydium/idl/raydium_launchpad.json";
import { buildAllocationReport, FORGEPAD_INTENDED, renderAllocationReport } from "../src/accounting/allocationReport";
import type { ExpectedAllocation } from "../src/config/env";

const FIX = join(import.meta.dir, "fixtures/mainnet");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const NONE: ExpectedAllocation = { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: null };

function sdkSplit(amount: bigint, r: { protocol: bigint; platform: bigint; creator: bigint; share?: bigint }) {
  const b = (x: bigint) => new BN(x.toString());
  const rates = { protocolFeeRate: b(r.protocol), platformFeeRate: b(r.platform), creatorFeeRate: b(r.creator), shareFeeRate: b(r.share ?? 0n) };
  const total = (Curve as any).calculateFee({ amount: b(amount), feeRate: (Curve as any).totalFeeRate(rates) });
  const s = (Curve as any).splitFee({ totalFee: total, ...rates });
  return { total: BigInt(total.toString()), creatorFee: BigInt(s.creatorFee.toString()), platformFee: BigInt(s.platformFee.toString()), protocolFee: BigInt(s.protocolFee.toString()), shareFee: BigInt(s.shareFee.toString()) };
}

function mainnetTrade() {
  const tx = normalizeTransaction(fixture("launchlab-buy-creatorfee.json"));
  const d: any = new AnchorEventDecoder(LAUNCHLAB_PROGRAM_ID, llIdl as any).decodeAll(tx).find((e) => e.name === "TradeEvent")!.data;
  const acc = fixture("launchlab-accounts.json");
  const pc = decodeLaunchLabPlatformConfig(Buffer.from(acc.accounts[acc.platformConfig].data, "base64"));
  return { tx, d, pc, acc };
}

describe("LaunchLab creator_fee_rate: a rate on TRADE VALUE (millionths), not a share of fees", () => {
  test("launchLabFeeSplit is identical to the Raydium SDK's calculateFee/splitFee", () => {
    for (const amount of [1n, 999n, 55_789_550n, 1_000_000_000n, 123_456_789_012n]) {
      for (const r of [
        { protocol: 2500n, platform: 7500n, creator: 500n },
        { protocol: 2500n, platform: 7500n, creator: 5000n },
        { protocol: 2500n, platform: 0n, creator: 5000n, share: 1000n },
        { protocol: 0n, platform: 0n, creator: 0n },
      ]) {
        const ours = launchLabFeeSplit(amount, r);
        const sdk = sdkSplit(amount, r);
        expect(ours.total).toBe(sdk.total);
        expect(ours.creatorFee).toBe(sdk.creatorFee);
        expect(ours.platformFee).toBe(sdk.platformFee);
        expect(ours.protocolFee).toBe(sdk.protocolFee);
        expect(ours.shareFee).toBe(sdk.shareFee);
      }
    }
  });

  test("a real mainnet TradeEvent is reproduced bit-exactly from the real PlatformConfig rates", () => {
    const { d, pc } = mainnetTrade();
    const amount = toBig(d.amount_in);
    const ev = { protocol: toBig(d.protocol_fee), platform: toBig(d.platform_fee), creator: toBig(d.creator_fee), share: toBig(d.share_fee) };
    const total = ev.protocol + ev.platform + ev.creator + ev.share;
    expect(pc.feeRate).toBe(7500n);
    expect(pc.creatorFeeRate).toBe(500n); // this platform: 0.05% of trade value
    // total_fee = ceil(amount × Σ / 1e6) admits exactly ONE integer Σ — which proves the protocol rate.
    const sums = [];
    for (let s = 1n; s <= 50_000n; s++) if ((amount * s + 999_999n) / 1_000_000n === total) sums.push(s);
    expect(sums).toEqual([10_500n]);
    const protocolRate = 10_500n - pc.feeRate - pc.creatorFeeRate; // share_fee was 0
    expect(protocolRate).toBe(2_500n);
    const split = launchLabFeeSplit(amount, { protocol: protocolRate, platform: pc.feeRate, creator: pc.creatorFeeRate });
    expect(split).toEqual({ total, platformFee: ev.platform, shareFee: 0n, creatorFee: ev.creator, protocolFee: ev.protocol });
    // creator fee ≈ rate × trade value …
    expect(ev.creator).toBe(27_894n);
    expect((amount * pc.creatorFeeRate) / 1_000_000n).toBe(27_894n);
    // … and NOT rate × total trading fees (that would be 292 lamports)
    expect((total * pc.creatorFeeRate) / 1_000_000n).toBe(292n);
    expect(ev.creator).not.toBe((total * pc.creatorFeeRate) / 1_000_000n);
  });

  test("5000 millionths = 0.5% of trade value, which is NOT 0.5% of total trading fees", () => {
    const amount = 1_000_000_000n; // 1 SOL bought
    const asTradeRate = launchLabFeeSplit(amount, { protocol: 2500n, platform: 7500n, creator: 5000n });
    expect(asTradeRate.total).toBe(15_000_000n); // 1.5% total: 0.25% protocol + 0.75% platform + 0.5% creator
    expect(asTradeRate.creatorFee).toBe(5_000_000n); // 0.5% of 1 SOL
    // The other reading — 0.5% of the protocol+platform fees (10 000 000) — would be 50 000, and
    // 0.5% of the total fee 75 000; neither is what the program pays. They must never be interchanged.
    const asShareOfFees = (10_000_000n * 5_000n) / 1_000_000n;
    expect(asShareOfFees).toBe(50_000n);
    expect(asTradeRate.creatorFee).toBe(100n * asShareOfFees);
    // A referral share fee raises the total but leaves the creator at 0.5% of trade value.
    const withShare = launchLabFeeSplit(amount, { protocol: 2500n, platform: 7500n, creator: 5000n, share: 1000n });
    expect(withShare.total).toBe(16_000_000n);
    expect(withShare.creatorFee).toBe(5_000_000n);
    // Rounding: total rounds UP, parts round DOWN, protocol absorbs the remainder.
    const odd = launchLabFeeSplit(333n, { protocol: 2500n, platform: 7500n, creator: 5000n });
    expect(odd.total).toBe(5n); // ceil(4.995)
    expect(odd.creatorFee).toBe(1n); // floor(5 × 5000 / 15000)
    expect(odd.platformFee).toBe(2n);
    expect(odd.protocolFee).toBe(2n);
    expect(odd.total).toBe(odd.creatorFee + odd.platformFee + odd.protocolFee);
  });

  test("the provider attributes exactly TradeEvent.creator_fee (cross-checked with the vault transfer), never a recomputation", async () => {
    const { tx, d, acc } = mainnetTrade();
    const accounts = new Map(Object.entries<any>(acc.accounts).map(([a, v]) => [a, { owner: v.owner, data: Buffer.from(v.data, "base64"), lamports: 1, executable: false }]));
    const rpc: any = { getAccountInfo: async (a: string) => ({ slot: 1, value: accounts.get(a) ?? null }) };
    const p = new RaydiumLaunchLabProvider(rpc, { poolAddress: acc.pool, tokenMint: acc.baseMint, role: "creator", expected: { ...NONE, launchlabCreatorFeeRate: 500 } });
    const info = await p.load();
    expect(info.allocation!.verification).toBe("verified");
    const s = p.parseTransaction(tx).swaps[0]!;
    expect(s.eligibleFee).toBe(toBig(d.creator_fee));
    expect(s.totalFee - s.eligibleFee).toBe(toBig(d.protocol_fee) + toBig(d.platform_fee) + toBig(d.share_fee));
  });
});

describe("Forgepad allocation report (operator-readable)", () => {
  async function loaded(expected: Partial<ExpectedAllocation>) {
    const acc = fixture("launchlab-accounts.json");
    const accounts = new Map(Object.entries<any>(acc.accounts).map(([a, v]) => [a, { owner: v.owner, data: Buffer.from(v.data, "base64"), lamports: 1, executable: false }]));
    const rpc: any = { getAccountInfo: async (a: string) => ({ slot: 1, value: accounts.get(a) ?? null }) };
    const p = new RaydiumLaunchLabProvider(rpc, { poolAddress: acc.pool, tokenMint: acc.baseMint, role: "creator", expected: { ...NONE, ...expected } });
    const info = await p.load();
    return buildAllocationReport(info, { ...NONE, ...expected }, p.lpCheck);
  }

  test("Forgepad's intended LaunchLab targets checked against a real platform config are a MISMATCH (never assumed)", async () => {
    const intended = Object.fromEntries(FORGEPAD_INTENDED.raydium_launchlab.map((t) => [t.key, t.value]));
    expect(intended).toEqual({ launchlabCreatorFeeRate: 5000, launchlabCreatorLpScale: 500000 });
    const r = await loaded(intended);
    const rate = r.rows.find((x) => x.parameter.startsWith("creator_fee_rate"))!;
    expect(rate.onChain).toBe("500");
    expect(rate.declared).toBe(5000);
    expect(rate.verification).toBe("mismatch");
    expect(rate.distributable).toBe(false);
    const scale = r.rows.find((x) => x.parameter.startsWith("creator_scale"))!;
    expect(scale.onChain).toBe("100000");
    expect(scale.verification).toBe("mismatch");
    expect(scale.notes.join(" ")).toContain("2026-08-17");
    expect(r.outcome).toBe("mismatch");
    expect(r.beneficiary).toBe(r.creator);
    expect(r.feeMints[0]!.mint).toBe("So11111111111111111111111111111111111111112");
    expect(renderAllocationReport(r)).toContain("OUTCOME: MISMATCH");
  });

  test("absent declarations are reported as not_declared — never as verified, never distributable", async () => {
    const r = await loaded({});
    expect(r.rows.every((x) => x.verification === "not_declared" && !x.distributable)).toBe(true);
    expect(r.outcome).toBe("not_declared");
    expect(r.missing.some((m) => m.includes("EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE"))).toBe(true);
    expect(r.bases.every((b) => !b.distributable)).toBe(true);
  });

  test("declarations equal to the chain verify; the on-chain value stays the accounting value", async () => {
    const r = await loaded({ launchlabCreatorFeeRate: 500, launchlabCreatorLpScale: 100000 });
    expect(r.rows.map((x) => x.verification)).toEqual(["verified", "verified"]);
    expect(r.outcome).toBe("verified");
    expect(r.rows[0]!.matchesIntended).toBe(false); // verified against the declaration, still ≠ Forgepad's 5000 target
  });
});
