/**
 * Bonding-curve creator-fee attribution on real mainnet transactions:
 *   - every fee record carries gross / creator-allocated / excluded amounts, the allocation basis,
 *     evidence and payout eligibility;
 *   - protocol / partner / platform shares are excluded, never attributed;
 *   - a declared allocation that contradicts the chain is flagged, recorded, and NOT payable — the
 *     declared value is never substituted;
 *   - LaunchLab's creator_fee_rate is a FEE RATE on trade value, not a share of the fee;
 *   - U4: claims are measured per claim instruction (claim + trade in one transaction, several
 *     claims, shared creator vault).
 */
import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { normalizeTransaction, tokenAccountDelta } from "../src/chain/tx";
import { AnchorEventDecoder, toAddr, toBig } from "../src/chain/anchorEvents";
import { MeteoraDBCProvider, DBC_PROGRAM_ID } from "../src/providers/meteora/MeteoraDBCProvider";
import { RaydiumLaunchLabProvider, LAUNCHLAB_PROGRAM_ID, decodeLaunchLabPlatformConfig } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import dbcIdl from "../src/providers/meteora/idl/dynamic_bonding_curve.json";
import llIdl from "../src/providers/raydium/idl/raydium_launchpad.json";
import type { ExpectedAllocation } from "../src/config/env";
import { basisDistributable, basisPayable } from "../src/accounting/attribution";

const FIX = join(import.meta.dir, "fixtures/mainnet");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const SPL = TOKEN_PROGRAM_ID.toBase58();
const NONE: ExpectedAllocation = { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: null };
const SYS = "11111111111111111111111111111111";

function dbcFor(raw: any, pct: number, opts: { role?: "creator" | "partner"; expected?: Partial<ExpectedAllocation> } = {}) {
  const tx = normalizeTransaction(raw);
  const ev = new AnchorEventDecoder(DBC_PROGRAM_ID, dbcIdl as any).decodeAll(tx).find((e) => e.name === "EvtSwap3")!;
  const parent = ev.parent!;
  const p = new MeteoraDBCProvider(null, { poolAddress: toAddr(ev.data.pool), tokenMint: parent.accounts[7]!, role: opts.role ?? "creator", expected: { ...NONE, ...opts.expected } });
  p.hydrate(
    { config: toAddr(ev.data.config), creator: SYS, baseMint: parent.accounts[7]!, baseVault: parent.accounts[5]!, quoteVault: parent.accounts[6]!, isMigrated: false, migrationProgress: 0, creatorQuoteFee: 0n, creatorBaseFee: 0n, partnerQuoteFee: 0n, partnerBaseFee: 0n, transferHook: false },
    { quoteMint: parent.accounts[8]!, feeClaimer: SYS, collectFeeMode: 0, creatorTradingFeePercentage: pct, migrationOption: 1, lp: { creatorLiquidity: 50, creatorPermanentLocked: 25, creatorVesting: 0, partnerLiquidity: 25, partnerPermanentLocked: 0, partnerVesting: 0 } },
    { baseDecimals: 6, quoteDecimals: 9, baseTokenProgram: SPL, quoteTokenProgram: SPL },
  );
  return { p, tx, ev };
}

describe("Meteora DBC bonding-curve allocation", () => {
  test("only the creator's configured share of the LP trading fee is attributed; protocol + partner + referral are excluded", () => {
    const { p, tx, ev } = dbcFor(fixture("dbc-buy-direct.json"), 75);
    const s = p.parseTransaction(tx).swaps[0]!;
    const tradingFee = toBig(ev.data.trading_fee);
    const gross = tradingFee + toBig(ev.data.protocol_fee) + toBig(ev.data.referral_fee);
    expect(s.totalFee).toBe(gross);
    expect(s.eligibleFee).toBe((tradingFee * 75n) / 100n); // program formula, rounding down
    expect(s.excludedFee).toBe(gross - s.eligibleFee);
    expect(s.excludedReason).toBe("not_beneficiary_share");
    expect(s.eligibleFee).toBeLessThan(gross); // never the whole pool fee
    expect(s.feePhase).toBe("bonding_curve");
    expect(s.payoutEligible).toBe(true);
    expect(s.basisId).toBe(p.info().allocation!.id);
    expect(p.info().allocation!.params.creatorTradingFeePercentage).toBe(75);
  });

  test("the partner role gets exactly the complement; the two never overlap", () => {
    const creator = dbcFor(fixture("dbc-buy-direct.json"), 75).p;
    const partner = dbcFor(fixture("dbc-buy-direct.json"), 75, { role: "partner" }).p;
    const tx = normalizeTransaction(fixture("dbc-buy-direct.json"));
    const a = creator.parseTransaction(tx).swaps[0]!;
    const b = partner.parseTransaction(tx).swaps[0]!;
    const ev = new AnchorEventDecoder(DBC_PROGRAM_ID, dbcIdl as any).decodeAll(tx).find((e) => e.name === "EvtSwap3")!;
    expect(a.eligibleFee + b.eligibleFee).toBe(toBig(ev.data.trading_fee));
    expect(a.basisId).not.toBe(b.basisId);
  });

  test("a declared allocation matching the chain is verified", () => {
    const { p, tx } = dbcFor(fixture("dbc-buy-direct.json"), 75, { expected: { dbcCreatorTradingFeePercentage: 75, dbcCreatorLpPercentage: 75 } });
    expect(p.info().allocation!.verification).toBe("verified");
    expect(p.lpCheck.verification).toBe("verified");
    expect(p.parseTransaction(tx).swaps[0]!.payoutEligible).toBe(true);
  });

  test("a mismatching declaration flags the pool and makes the fee ineligible — the on-chain value stays the record, nothing is substituted", () => {
    const { p, tx, ev } = dbcFor(fixture("dbc-buy-direct.json"), 44, { expected: { dbcCreatorTradingFeePercentage: 75, dbcCreatorLpPercentage: 60 } });
    const info = p.info();
    expect(info.allocation!.verification).toBe("mismatch");
    expect(info.warnings!.some((w) => w.startsWith("ALLOCATION MISMATCH: creator_trading_fee_percentage is 44 on-chain but 75"))).toBe(true);
    expect(info.warnings!.some((w) => w.includes("creator LP percentage is 75 on-chain but 60"))).toBe(true);
    const s = p.parseTransaction(tx).swaps[0]!;
    expect(s.eligibleFee).toBe((toBig(ev.data.trading_fee) * 44n) / 100n); // chain truth, not 75%
    expect(s.payoutEligible).toBe(false);
    expect(s.feeStatus).toBe("unresolved");
    expect(s.excludedReason).toContain("allocation_mismatch");
  });

  test("an undeclared allocation is accounted from chain, warned about, and NOT distributable", () => {
    const { p } = dbcFor(fixture("dbc-buy-direct.json"), 75);
    expect(p.info().allocation!.verification).toBe("not_declared");
    expect(p.info().warnings!.some((w) => /not declared/i.test(w) && /NOT distributed/.test(w))).toBe(true);
    // not_declared is never presented as verified and never distributed
    expect(basisDistributable(p.info().allocation)).toBe(false);
    expect(basisPayable(p.info().allocation!)).toBe(true); // recorded as eligible-in-principle at ingestion
  });

  test("the allocation basis changes when the on-chain parameters change (history keeps its own basis)", () => {
    const a = dbcFor(fixture("dbc-buy-direct.json"), 75).p.info().allocation!;
    const b = dbcFor(fixture("dbc-buy-direct.json"), 50).p.info().allocation!;
    expect(a.id).not.toBe(b.id);
  });
});

describe("Raydium LaunchLab bonding-curve allocation", () => {
  async function loaded(role: "creator" | "platform" = "creator", expected: Partial<ExpectedAllocation> = {}) {
    const f = fixture("launchlab-accounts.json");
    const accounts = new Map(Object.entries<any>(f.accounts).map(([a, v]) => [a, { owner: v.owner, data: Buffer.from(v.data, "base64"), lamports: 1, executable: false }]));
    const rpc: any = { getAccountInfo: async (a: string) => ({ slot: 1, value: accounts.get(a) ?? null }) };
    const p = new RaydiumLaunchLabProvider(rpc, { poolAddress: f.pool, tokenMint: f.baseMint, role, expected: { ...NONE, ...expected } });
    return { p, info: await p.load(), f };
  }

  test("creator_fee_rate is a FEE RATE on trade value (millionths), not a share of the fee", async () => {
    const { p, info } = await loaded();
    const tx = normalizeTransaction(fixture("launchlab-buy-creatorfee.json"));
    const ev = new AnchorEventDecoder(LAUNCHLAB_PROGRAM_ID, llIdl as any).decodeAll(tx).find((e) => e.name === "TradeEvent")!;
    const d: any = ev.data;
    const rate = BigInt(info.feeParams.creatorFeeRate as string);
    expect(rate).toBeGreaterThan(0n);
    const amountIn = toBig(d.amount_in);
    const creatorFee = toBig(d.creator_fee);
    const total = toBig(d.protocol_fee) + toBig(d.platform_fee) + toBig(d.creator_fee) + toBig(d.share_fee);
    // ≈ amount × rate / 1e6 (the program charges ceil(amount × Σrates / 1e6) and splits it pro rata)
    const asRate = (amountIn * rate) / 1_000_000n;
    expect(creatorFee >= asRate - 2n && creatorFee <= asRate + 2n).toBe(true);
    // …and NOT rate-as-percentage-of-the-total-fee
    expect(creatorFee).not.toBe((total * rate) / 1_000_000n);
    const s = p.parseTransaction(tx).swaps[0]!;
    expect(s.eligibleFee).toBe(creatorFee);
    expect(s.excludedFee).toBe(total - creatorFee); // protocol + platform + share fees
    expect(s.evidence!.vaultInflow).toBe(creatorFee.toString()); // event cross-checked against the vault transfer
    expect(s.payoutEligible).toBe(true);
  });

  test("a declared creator fee rate that differs from the platform config makes bonding fees ineligible", async () => {
    const { p, info } = await loaded("creator", { launchlabCreatorFeeRate: 1 });
    expect(info.allocation!.verification).toBe("mismatch");
    const s = p.parseTransaction(normalizeTransaction(fixture("launchlab-buy-creatorfee.json"))).swaps[0]!;
    expect(s.payoutEligible).toBe(false);
    expect(s.eligibleFee).toBeGreaterThan(0n); // still recorded, from chain
  });

  test("the declared rate matching the chain is verified", async () => {
    const f = fixture("launchlab-accounts.json");
    const pool = (await loaded()).info;
    const pc = decodeLaunchLabPlatformConfig(Buffer.from(f.accounts[pool.accounts.platformConfig!].data, "base64"));
    // The rate alone is not enough: the platform identity must be declared too.
    expect((await loaded("creator", { launchlabCreatorFeeRate: Number(pc.creatorFeeRate) })).info.allocation!.verification).toBe("not_declared");
    const { info } = await loaded("creator", { launchlabCreatorFeeRate: Number(pc.creatorFeeRate), launchlabPlatformConfig: pool.accounts.platformConfig! });
    expect(info.allocation!.verification).toBe("verified");
  });

  test("shared creator vault: another pool's deposit is recorded as excluded, never attributed to this pool", async () => {
    const { info } = await loaded();
    // Same creator + quote mint, different pool → same vault PDA.
    const other = new RaydiumLaunchLabProvider(null, { poolAddress: "So11111111111111111111111111111111111111112", tokenMint: info.tokenMint, role: "creator" });
    const f = fixture("launchlab-accounts.json");
    const pc = decodeLaunchLabPlatformConfig(Buffer.from(f.accounts[info.accounts.platformConfig!].data, "base64"));
    other.hydrate({ status: 0, baseDecimals: 6, quoteDecimals: 9, platformFeeAccrued: 0n, globalConfig: info.accounts.globalConfig!, platformConfig: info.accounts.platformConfig!, baseMint: info.tokenMint, quoteMint: info.quoteMint, baseVault: SYS, quoteVault: SYS, creator: info.creator }, pc, { baseTokenProgram: SPL, quoteTokenProgram: SPL });
    expect(other.info().accounts.creatorFeeVault).toBe(info.accounts.creatorFeeVault!);
    const tx = normalizeTransaction(fixture("launchlab-buy-creatorfee.json"));
    const parsed = other.parseTransaction(tx);
    expect(parsed.swaps).toEqual([]);
    expect(parsed.attributions).toHaveLength(1);
    const a = parsed.attributions![0]!;
    expect(a.kind).toBe("shared_vault_inflow");
    expect(a.creatorAmount).toBe(0n);
    expect(a.excludedAmount).toBe(tokenAccountDelta(tx, info.accounts.creatorFeeVault!));
    expect(a.excludedReason).toBe("shared_vault_other_pool");
    expect(a.payoutEligible).toBe(false);
  });

  // ── U4 ────────────────────────────────────────────────────────────────────────────────────
  function claimProvider(raw: any) {
    const tx = normalizeTransaction(raw);
    const ix = tx.instructions.find((i) => i.programId === LAUNCHLAB_PROGRAM_ID)!;
    const creator = ix.accounts[0]!;
    const p = new RaydiumLaunchLabProvider(null, { poolAddress: SYS, tokenMint: SYS, role: "creator" });
    p.hydrate({ status: 0, baseDecimals: 6, quoteDecimals: 9, platformFeeAccrued: 0n, globalConfig: creator, platformConfig: creator, baseMint: SYS, quoteMint: ix.accounts[4]!, baseVault: creator, quoteVault: creator, creator }, { platformFeeWallet: creator, feeRate: 0n, creatorFeeRate: 0n }, { baseTokenProgram: SPL, quoteTokenProgram: SPL });
    return { p, vault: ix.accounts[2]!, tx };
  }
  const transferData = (amount: bigint) => {
    const d = Buffer.alloc(9);
    d[0] = 3;
    d.writeBigUInt64LE(amount, 1);
    return bs58.encode(d);
  };

  test("claim + vault deposit in ONE transaction: the claim is what the claim instruction moved, not the net vault change", () => {
    const raw = fixture("launchlab-claim-creator.json");
    // Append a deposit of 1 000 into the vault (account #1) from the recipient ATA (#2), like a trade's creator fee.
    raw.transaction.message.instructions.push({ programIdIndex: 9, accounts: [2, 1, 0], data: transferData(1000n), stackHeight: 1 });
    raw.meta.postTokenBalances[0].uiTokenAmount.amount = "1000";
    const { p, vault, tx } = claimProvider(raw);
    const claims = p.parseTransaction(tx).claims;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.quoteAmount).toBe(2_805_410n);
    expect(-tokenAccountDelta(tx, vault)).toBe(2_804_410n); // the old net-delta method would under-record
    expect(claims[0]!.evidence!.vault).toBe(vault);
  });

  test("two claim instructions in one transaction are two claims with their own amounts", () => {
    const raw = fixture("launchlab-claim-creator.json");
    const msg = raw.transaction.message;
    msg.instructions.push(structuredClone(msg.instructions[2]));
    raw.meta.innerInstructions.push({ index: msg.instructions.length - 1, instructions: [{ accounts: [1, 8, 2, 4], data: bs58.encode(Buffer.concat([Buffer.from([12]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(777n); return b; })(), Buffer.from([9])])), programIdIndex: 9, stackHeight: 2 }] });
    raw.meta.preTokenBalances[0].uiTokenAmount.amount = String(2_805_410 + 777);
    const { p, tx } = claimProvider(raw);
    expect(p.parseTransaction(tx).claims.map((c) => c.quoteAmount)).toEqual([2_805_410n, 777n]);
  });
});
