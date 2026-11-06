/**
 * PR #7 — regression tests for the APPROVED economic model (docs/REWARD_FUNDING.md §1):
 *
 *   bonding curve   creator fee 0.50 % of volume; of what is COLLECTED: 75 % Last-60, 25 % creator
 *   post-migration  CPMM creator fee 0.05 % of volume (minus the protocol share): 100 % creator, 0 % Last-60
 *   post-migration  Forge platform Fee Key LP fees; of what is CLAIMED: 50 % the CREATOR'S allocation,
 *                   dedicated to Last-60 buyer rewards; 50 % retained by Forge
 *
 * Only actual, finalized, correlated transfers into a configured Last-60 funding destination fund
 * rewards, once, capped at the expected allocation, under forge_phase_aware_v2.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { big, dec } from "../src/db/decimal";
import {
  APPROVED_FEE_RATES,
  APPROVED_SHARES,
  capCreditsPerCollection,
  correlateTransfer,
  expectedSplit,
  makeFundingPolicy,
  reconcileCollection,
  STREAM_INFO,
  WSOL_MINT,
  type CollectionFact,
  type TransferFact,
} from "../src/accounting/revenueStreams";
import { reconcileFunding } from "../src/revenue/ingest";
import { buildRevenueReport } from "../src/revenue/report";
import { addr, buildTx, memo, sig, splTransferChecked, systemTransfer } from "./revenueTx";
import { freshDb, rig, SOL, startDb, stopDb, T0, wallet } from "./harness";
import { ACT, bondingClaimIx, CREATOR, DEST, FORGE, ingest, launchRef, llFx, lpClaimIx, policyV2, providerOf, runtime } from "./revenueLaunch";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const oneCredit = async (db: any) => (await db.RewardFunding.findOne({}).lean()) as any;

// ── 1. the approved percentages, pure ───────────────────────────────────────────────────────

describe("approved model — pure", () => {
  test("bonding curve: 0.50 % creator fee on volume, then 75 % Last-60 / 25 % creator of what is COLLECTED", () => {
    expect(APPROVED_FEE_RATES).toEqual({ bondingCreatorFeeRate: 5_000, cpmmCreatorFeeRate: 500 });
    const volume = 1_000n * SOL;
    const charged = (volume * BigInt(APPROVED_FEE_RATES.bondingCreatorFeeRate)) / 1_000_000n; // 5 SOL charged
    expect(charged).toBe(5n * SOL);
    // Only what the creator actually collected is split (e.g. 4 SOL collected so far, not 5).
    expect(expectedSplit(4n * SOL, APPROVED_SHARES.bondingCreatorFeeLast60Bps)).toEqual({ last60: 3n * SOL, retained: 1n * SOL });
    expect(expectedSplit(4n * SOL, APPROVED_SHARES.bondingCreatorFeeLast60Bps).last60).not.toBe((volume * 75n) / 100n); // never from volume
  });

  test("post-migration Forge LP: 50 % creator allocation → Last-60, 50 % Forge; CPMM creator fees 0 %", () => {
    expect(expectedSplit(2n * SOL + 1n, APPROVED_SHARES.forgeLpLast60Bps)).toEqual({ last60: SOL, retained: SOL + 1n });
    expect(STREAM_INFO.forge_platform_lp_last60_contribution).toMatchObject({ allocationOwner: "creator", custodian: "forge", beneficiary: "last60" });
    expect(STREAM_INFO.forge_platform_lp_retained).toMatchObject({ allocationOwner: "forge", rewardEligible: false });
    expect(STREAM_INFO.cpmm_creator_trading_fee).toMatchObject({ allocationOwner: "creator", rewardEligible: false });
    const cpmm: CollectionFact = { key: "cp", stream: "cpmm_creator_trading_fee", signature: "S", slot: 1, ordinal: 1, asset: WSOL_MINT, recipient: "C", gross: 1_000n, expectedLast60: null, linked: 0n, verified: true };
    const t: TransferFact = { key: "t", signature: "S", slot: 1, ordinal: 2, asset: WSOL_MINT, sourceOwner: "C", destinationOwner: "D", amount: 1n, memoClaimSignature: null };
    expect(correlateTransfer(t, [cpmm], "strict").linked).toBe(false);
    expect(correlateTransfer({ ...t, signature: "X", memoClaimSignature: "S" }, [cpmm], "strict")).toEqual({ linked: false, reason: "memo_names_unknown_claim" });
    expect(reconcileCollection(cpmm, [{ key: "t", amount: 1n, slot: 1, ordinal: 2 }]).status).toBe("not_applicable");
  });

  test("the shares are fixed under the approved policy", () => {
    expect(() => makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: 1, bondingCreatorFeeLast60Bps: 7_500, forgeLpLast60Bps: 5_001 })).toThrow("approved model");
    expect(() => makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: 1, bondingCreatorFeeLast60Bps: 10_000, forgeLpLast60Bps: 5_000 })).toThrow("approved model");
    expect(policyV2().bondingCreatorFeeLast60Bps).toBe(7_500);
    expect(policyV2().forgeLpLast60Bps).toBe(5_000);
  });

  test("rounding and dust: the contribution floors; the residual stays with the retaining party", () => {
    expect(expectedSplit(1n, 7_500)).toEqual({ last60: 0n, retained: 1n });
    expect(expectedSplit(3n, 7_500)).toEqual({ last60: 2n, retained: 1n });
    expect(expectedSplit(3n, 5_000)).toEqual({ last60: 1n, retained: 2n });
    expect(expectedSplit(0n, 5_000)).toEqual({ last60: 0n, retained: 0n });
    // A distributor that rounds UP sends 1 unit too many: recorded as excess, never creditable.
    const r = reconcileCollection({ gross: 3n, expectedLast60: 1n, verified: true }, [{ key: "t", amount: 2n, slot: 1, ordinal: 1 }]);
    expect([r.status, r.creditable, r.excess]).toEqual(["excess", 1n, 1n]);
  });

  test("per-claim consumption cap: consumed credits count first; nothing above the expected allocation is ever consumable", () => {
    const c = (key: string, creditable: bigint, consumed = false, slot = 10) => ({ key, collectionKey: "K", creditable, slot, ordinal: 1, consumed });
    let res = capCreditsPerCollection([c("a", 500n), c("b", 500n, false, 11)], new Map([["K", 500n]]));
    expect([...res.allowed]).toEqual(["a"]);
    expect(res.blocked[0]).toMatchObject({ key: "b" });
    expect(res.blocked[0]!.reason).toContain("over_allocation_guard");
    res = capCreditsPerCollection([c("old", 300n, true, 50), c("new", 300n, false, 5)], new Map([["K", 500n]]));
    expect(res.allowed.size).toBe(0); // the already-consumed 300 leaves only 200
    res = capCreditsPerCollection([c("x", 1n)], new Map());
    expect(res.blocked[0]!.reason).toBe("no_reconciliation_row_for_claim");
  });
});

// ── 2. bonding curve, end to end ────────────────────────────────────────────────────────────

describe("bonding-curve creator fee 0.50 % → 75 % Last-60 / 25 % creator", () => {
  test("a collected fee with the creator's 75 % in the SAME transaction: full funding contribution record", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = bondingClaimIx(p, 1_000_003n);
    const tx = buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(CREATOR, DEST, 750_002n)], tokens: claim.tokens });
    await ingest(db, p, tx);
    const c = await oneCredit(db);
    expect(c).toMatchObject({
      stream: "bonding_curve_last60_reward_contribution",
      tokenMint: p.info().tokenMint,
      sourcePool: llFx.bondingPool,
      launchPhase: "bonding_curve",
      collectionSignature: tx.signature,
      signature: tx.signature,
      slot: ACT + 5,
      sourceWallet: CREATOR,
      destinationWallet: DEST,
      creator: CREATOR,
      allocationOwner: "creator",
      policyVersion: "forge_phase_aware_v2",
      correlationMethod: "same_transaction",
      status: "reconciled",
      payoutEligible: true,
    });
    expect([c.collectedAmount, c.expectedAllocation, c.observedAmount, c.creditableAmount, c.excessAmount].map(big)).toEqual([1_000_003n, 750_002n, 750_002n, 750_002n, 0n]);
    const rec: any = await db.RevenueReconciliation.findOne({ key: c.collectionKey }).lean();
    expect([rec.expectedRetained, rec.impliedRetained].map(big)).toEqual([250_001n, 250_001n]); // creator's 25 % (+ dust)
  });

  test("the creator keeping everything funds nothing; a Forge transfer is never the creator's bonding contribution", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = bondingClaimIx(p, 1_000_000n);
    const tx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, tx);
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [memo(`last60:v1:${tx.signature}`), systemTransfer(FORGE, DEST, 750_000n)] }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    const rec: any = await db.RevenueReconciliation.findOne({}).lean();
    expect([rec.status, big(rec.untransferred)]).toEqual(["awaiting_distribution", 750_000n]);
  });
});

// ── 3. Forge platform LP: the creator's 50 % allocation ────────────────────────────────────

describe("Forge platform LP fees → creator's 50 % allocation to Last-60, 50 % Forge", () => {
  test("two legs claimed, contributions routed directly from the Fee Key holder with a memo: attributed to the creator, per mint", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx({ amount0: 1_000_001n, amount1: 77n });
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, claimTx);
    const src = addr();
    const dst = addr();
    const dist = buildTx({ slot: ACT + 7, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 500_000n), splTransferChecked(src, claim.token1Mint, dst, FORGE, 38n, 6)], tokens: { [src]: { owner: FORGE, mint: claim.token1Mint, decimals: 6 }, [dst]: { owner: DEST, mint: claim.token1Mint, decimals: 6 } } });
    expect((await ingest(db, p, dist)).newCredits).toBe(2);
    const credits: any[] = await db.RewardFunding.find({}).sort({ ordinal: 1 }).lean();
    for (const c of credits) expect(c).toMatchObject({ stream: "forge_platform_lp_last60_contribution", launchPhase: "post_migration", creator: CREATOR, allocationOwner: "creator", sourceWallet: FORGE, destinationWallet: DEST, collectionSignature: claimTx.signature, correlationMethod: "memo", payoutEligible: true });
    expect(credits.map((c) => [c.fundingMint, big(c.collectedAmount), big(c.expectedAllocation), big(c.creditableAmount)])).toEqual([
      [WSOL_MINT, 1_000_001n, 500_000n, 500_000n],
      [claim.token1Mint, 77n, 38n, 38n],
    ]);
    const recs: any[] = await db.RevenueReconciliation.find({}).lean();
    for (const r of recs) expect(r.status).toBe("reconciled");
    // Forge retains 50 % (plus the rounding residual): implied, never assumed observed.
    expect(recs.map((r) => big(r.impliedRetained)).sort()).toEqual([39n, 500_001n].sort());
    const report = await buildRevenueReport(db, { sourcePool: llFx.bondingPool, policy: policyV2() });
    expect(report.postMigration.forgePlatformLp[WSOL_MINT]).toMatchObject({ grossClaimed: "1000001", last60ExpectedContribution: "500000", forgeRetainedExpected: "500001", forgeRetainedObserved: null });
  });

  test("a creator-wallet transfer is NOT the creator's LP allocation: it never satisfies a Forge LP claim", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, claimTx);
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(CREATOR, DEST, 500_000n)] }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    expect(((await db.RevenueReconciliation.findOne({}).lean()) as any).status).toBe("awaiting_distribution");
  });

  test("incorrect beneficiary: LP fees paid to a wallet other than the platform Fee Key owner never fund", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const other = addr();
    const claim = lpClaimIx({ payTo: other });
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: claim.tokens }));
    const col: any = await db.RevenueEvent.findOne({ kind: "collection" }).lean();
    expect(col.status).toBe("unresolved");
    expect(col.snapshot.problems.join(" ")).toContain("not the platform NFT wallet");
    // The transfer comes from FORGE, but the claim's recipient is `other`: not linked, never funded.
    expect(await db.RewardFunding.countDocuments({ payoutEligible: true })).toBe(0);
  });
});

// ── 4. destinations, mints, partial, duplicates, ordering, failures ─────────────────────────

describe("transfer evidence", () => {
  test("missing or incorrect funding destination: no inflow, nothing funded", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, addr(), 500_000n)], tokens: claim.tokens }));
    expect(await db.RevenueEvent.countDocuments({ kind: "funding_inflow" })).toBe(0);
    const db2 = await freshDb();
    const c2 = lpClaimIx();
    await ingest(db2, p, buildTx({ slot: ACT + 5, ixs: [c2.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: c2.tokens }), runtime({ fundingDestinations: [] }));
    expect(await db2.RevenueEvent.countDocuments({ kind: "funding_inflow" })).toBe(0);
    expect(((await db2.RevenueReconciliation.findOne({}).lean()) as any).status).toBe("awaiting_distribution");
  });

  test("incorrect token mint: a transfer of another mint never satisfies a claim (no conversion)", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, claimTx);
    const src = addr();
    const dst = addr();
    const mint = Keypair.generate().publicKey.toBase58();
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [memo(`last60:v1:${claimTx.signature}`), splTransferChecked(src, mint, dst, FORGE, 500_000n)], tokens: { [src]: { owner: FORGE, mint }, [dst]: { owner: DEST, mint } } }));
    // TransferChecked whose mint disagrees with the destination account is not even an inflow.
    await ingest(db, p, buildTx({ slot: ACT + 7, ixs: [memo(`last60:v1:${claimTx.signature}`), splTransferChecked(src, WSOL_MINT, dst, FORGE, 500_000n)], tokens: { [src]: { owner: FORGE, mint }, [dst]: { owner: DEST, mint } } }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    expect(await db.RevenueEvent.countDocuments({ kind: "funding_inflow" })).toBe(1);
  });

  test("partial transfers, then completion; dust above the allocation is excess and never payable", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx({ amount0: 1_000_001n });
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 300_000n)], tokens: claim.tokens });
    await ingest(db, p, claimTx);
    let rec: any = await db.RevenueReconciliation.findOne({}).lean();
    expect([rec.status, big(rec.untransferred)]).toEqual(["partial", 200_000n]);
    await ingest(db, p, buildTx({ slot: ACT + 9, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 200_001n)] }));
    rec = await db.RevenueReconciliation.findOne({}).lean();
    expect([rec.status, big(rec.actualLast60), big(rec.creditable), big(rec.excess)]).toEqual(["excess", 500_001n, 500_000n, 1n]);
  });

  test("duplicate claims and transfers (re-indexing, restarts, a second payment) never add funding", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    const dist = buildTx({ slot: ACT + 6, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 500_000n)] });
    for (let i = 0; i < 3; i++) {
      await ingest(db, await providerOf(), claimTx);
      await ingest(db, await providerOf(), dist);
    }
    // A duplicate PAYMENT (a second, distinct transfer naming the same claim) is excess.
    await ingest(db, p, buildTx({ slot: ACT + 8, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 500_000n)] }));
    const credits: any[] = await db.RewardFunding.find({}).sort({ slot: 1 }).lean();
    expect(credits.map((c) => [big(c.creditableAmount), c.payoutEligible])).toEqual([[500_000n, true], [0n, false]]);
    expect(await db.RevenueEvent.countDocuments()).toBe(3);
  });

  test("transfer observed before its claim is linked once the claim arrives", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 500_000n)] }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    await ingest(db, p, claimTx);
    expect((await oneCredit(db)).payoutEligible).toBe(true);
  });

  test("a memo naming a LATER claim never links (the transfer cannot distribute fees not yet claimed)", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 9, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 500_000n)] }));
    await ingest(db, p, claimTx);
    expect(await db.RewardFunding.countDocuments()).toBe(0);
  });

  test("failed transactions are never revenue: a failed claim or a failed distribution records nothing", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const failedClaim = buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: claim.tokens, err: { InstructionError: [0, "Custom"] } });
    expect(await ingest(db, p, failedClaim)).toEqual({ newEvents: 0, newCredits: 0 });
    const ok = lpClaimIx();
    const okTx = buildTx({ slot: ACT + 6, ixs: [ok.ix], tokens: ok.tokens });
    await ingest(db, p, okTx);
    await ingest(db, p, buildTx({ slot: ACT + 7, ixs: [memo(`last60:v1:${okTx.signature}`), systemTransfer(FORGE, DEST, 500_000n)], err: { InstructionError: [1, "InsufficientFunds"] } }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
  });

  test("an amount-only (exclusive_window) link is recorded but never payable", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const r = runtime({ correlationMode: "exclusive_window" });
    const claim = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens }), r);
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [systemTransfer(FORGE, DEST, 500_000n)] }), r);
    const c = await oneCredit(db);
    expect([c.correlationMethod, c.payoutEligible, big(c.creditableAmount)]).toEqual(["exclusive_window", false, 0n]);
  });
});

// ── 5. activation slot, migration boundary, history ─────────────────────────────────────────

describe("activation slot, migration boundary and historical records", () => {
  test("claims at or before the activation slot never fund, even when distributed after it", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, claimTx);
    await ingest(db, p, buildTx({ slot: ACT + 1, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 500_000n)] }));
    const c = await oneCredit(db);
    expect(c.payoutEligible).toBe(false);
    expect(c.ineligibleReason).toContain(`before_policy_activation_slot_${ACT}`);
    // First slot after activation: funded.
    const c2 = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 1, ixs: [c2.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: c2.tokens }));
    expect(await db.RewardFunding.countDocuments({ payoutEligible: true })).toBe(1);
  });

  test("migration boundary: a residual bonding claim after graduation stays a bonding-curve stream (75 %), never Forge LP", async () => {
    const db = await freshDb();
    const p = await providerOf(); // graduated: CPMM destination attached
    const claim = bondingClaimIx(p, 400n);
    await ingest(db, p, buildTx({ slot: ACT + 50, ixs: [claim.ix, systemTransfer(CREATOR, DEST, 300n)], tokens: claim.tokens }));
    const c = await oneCredit(db);
    expect(c).toMatchObject({ stream: "bonding_curve_last60_reward_contribution", launchPhase: "bonding_curve", payoutEligible: true });
    expect(big(c.expectedAllocation)).toBe(300n);
  });

  test("historical records: v1 / legacy credits keep their snapshot, are never reclassified and never become payable", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const v1 = makeFundingPolicy({ version: "forge_phase_aware_v1", activationSlot: ACT, ...APPROVED_SHARES });
    const claim = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: claim.tokens }), runtime({ policy: v1 }));
    const c = await oneCredit(db);
    expect([c.payoutEligible, c.policy.version]).toEqual([false, "forge_phase_aware_v1"]);
    expect(c.ineligibleReason).toContain("policy_forge_phase_aware_v1_retired");
    // Re-running reconciliation under the approved policy never rewrites the stored credit.
    expect(await reconcileFunding(db, launchRef(p), runtime())).toBe(0);
    const again = await oneCredit(db);
    expect([again.payoutEligible, again.policy.version, big(again.creditableAmount)]).toEqual([false, "forge_phase_aware_v1", 0n]);
    await expect(db.RewardFunding.updateOne({ key: c.key }, { $set: { payoutEligible: true } }).exec()).rejects.toThrow("immutable");
  });

  test("idempotent reconciliation: repeated passes converge to the same rows and add nothing", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 400_000n)], tokens: claim.tokens }));
    const snap = async () => ({ credits: await db.RewardFunding.find({}, { _id: 0, createdAt: 0 }).lean(), recs: await db.RevenueReconciliation.find({}, { _id: 0, updatedAt: 0 }).lean() });
    const before = await snap();
    for (let i = 0; i < 3; i++) expect(await reconcileFunding(db, launchRef(p), runtime())).toBe(0);
    expect(await snap()).toEqual(before);
  });
});

// ── 6. rounds: finality of transfer AND claim, per-claim cap, payout accounting ─────────────

describe("round consumption under forge_phase_aware_v2", () => {
  const W = 240_000;
  const EXEC = T0 + W + 30_000;
  async function round(setup: (r: Awaited<ReturnType<typeof rig>>, sigs: string[]) => Promise<void>) {
    const r = await rig({ env: { REWARD_FUNDING_POLICY: "forge_phase_aware_v2", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "0", LAST60_FUNDING_DESTINATIONS: DEST, FORGE_PLATFORM_LP_BENEFICIARY: FORGE } });
    await r.worker.scheduler.tick(r.clock.now());
    const sigs: string[] = [];
    for (const w of Array.from({ length: 6 }, wallet)) {
      sigs.push(r.trade({ trader: w, quote: SOL / 10n }));
      r.chain.advance(2);
    }
    await setup(r, sigs);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(EXEC);
    await r.worker.scheduler.tick(r.clock.now());
    return { r, round: (await r.db.Round.findOne({ roundNumber: 1 }).lean()) as any };
  }
  const credit = (r: any, o: { key: string; col: string; transferSig: string; claimSig: string; amount: bigint; expected?: bigint; method?: string; slot?: number; policyVersion?: string }) =>
    Promise.all([
      r.db.RevenueReconciliation.updateOne({ key: o.col }, { $setOnInsert: { key: o.col, stream: "forge_platform_lp_fee_collection", status: "reconciled", expectedLast60: dec(o.expected ?? o.amount) } }, { upsert: true }),
      r.db.RewardFunding.create({ key: o.key, stream: "forge_platform_lp_last60_contribution", collectionKey: o.col, collectionSignature: o.claimSig, correlationMethod: o.method ?? "memo", provider: "mock", tokenMint: "m", sourcePool: "p", pool: "p", signature: o.transferSig, ordinal: 1, slot: o.slot ?? 5, collectionSlot: 4, fundingMint: WSOL_MINT, observedAmount: dec(o.amount), creditableAmount: dec(o.amount), excessAmount: dec(0n), status: "reconciled", payoutEligible: true, creator: CREATOR, allocationOwner: "creator", policyVersion: o.policyVersion ?? "forge_phase_aware_v2", policy: { ...r.cfg.revenue.policy, v: 1, version: o.policyVersion ?? "forge_phase_aware_v2" }, snapshot: { v: 1 } }),
    ]);

  test("both the transfer and the original claim must be finalized and successful", async () => {
    const { r, round: rd } = await round(async (r, sigs) => {
      const failed = r.trade({ trader: wallet(), quote: 1n, failed: true });
      await credit(r, { key: "ok", col: "c1", transferSig: sigs[1]!, claimSig: sigs[0]!, amount: 300_000_000n });
      await credit(r, { key: "claimUnknown", col: "c2", transferSig: sigs[2]!, claimSig: sig(), amount: 100_000_000n }); // claim forked out / never seen
      await credit(r, { key: "claimFailed", col: "c3", transferSig: sigs[3]!, claimSig: failed, amount: 100_000_000n });
      r.chain.advance(40);
      const late = r.trade({ trader: wallet(), kind: "sell", quote: 1n }); // claim not yet finalized
      await credit(r, { key: "claimUnfinal", col: "c4", transferSig: sigs[4]!, claimSig: late, amount: 100_000_000n });
    });
    expect(big(rd.funding)).toBe(300_000_000n);
    expect(rd.fundingBreakdown).toMatchObject({ credits: 1, pendingFinality: 3 });
    expect((await r.db.RewardFunding.find({ roundNumber: 1 }).lean()).map((c: any) => c.key)).toEqual(["ok"]);
    expect((await r.worker.reconciler.ledger()).problems).toEqual([]);
  });

  test("over-allocation guard: two credits for one claim (concurrent reconciliation) never fund more than its expected allocation", async () => {
    const { r, round: rd } = await round(async (r, sigs) => {
      await credit(r, { key: "first", col: "K", transferSig: sigs[1]!, claimSig: sigs[0]!, amount: 500_000_000n, slot: 5 });
      await credit(r, { key: "dup", col: "K", transferSig: sigs[2]!, claimSig: sigs[0]!, amount: 500_000_000n, expected: 500_000_000n, slot: 6 });
      r.chain.advance(40);
    });
    expect(big(rd.funding)).toBe(500_000_000n);
    expect(rd.fundingBreakdown).toMatchObject({ credits: 1, heldByAllocationGuard: 1 });
    expect(await r.db.RewardFunding.countDocuments({ key: "dup", roundNumber: null })).toBe(1);
    expect((await r.worker.reconciler.ledger()).problems).toEqual([]);
  });

  test("retired-policy and amount-only credits are never consumed; payout accounting balances (REWARD_PERCENTAGE not applied)", async () => {
    const { r, round: rd } = await round(async (r, sigs) => {
      await credit(r, { key: "v2", col: "a", transferSig: sigs[1]!, claimSig: sigs[1]!, amount: 200_000_000n, method: "same_transaction" });
      await credit(r, { key: "v1", col: "b", transferSig: sigs[2]!, claimSig: sigs[2]!, amount: 900_000_000n, method: "same_transaction", policyVersion: "forge_phase_aware_v1" });
      await credit(r, { key: "window", col: "c", transferSig: sigs[3]!, claimSig: sigs[0]!, amount: 900_000_000n, method: "exclusive_window" });
      r.chain.advance(40);
    });
    expect(big(rd.funding)).toBe(200_000_000n);
    expect(big(rd.reward)).toBe(200_000_000n);
    expect(big(rd.perRecipient) * BigInt(rd.recipientCount) + big(rd.dust)).toBe(200_000_000n);
    expect(await r.db.RewardFunding.countDocuments({ key: { $in: ["v1", "window"] }, roundNumber: null })).toBe(2);
    const fl: any[] = await r.db.LedgerEntry.find({ roundNumber: 1, type: "FUNDING_CREDITED" }).lean();
    expect(fl.map((l) => big(l.amount))).toEqual([200_000_000n]);
    expect((await r.worker.reconciler.ledger()).problems).toEqual([]);
  });

  test("the reconciler flags a claim whose consumed funding exceeds its expected allocation", async () => {
    const { r } = await round(async (r, sigs) => {
      await credit(r, { key: "k1", col: "Z", transferSig: sigs[1]!, claimSig: sigs[0]!, amount: 100_000_000n });
      r.chain.advance(40);
    });
    await r.db.RevenueReconciliation.updateOne({ key: "Z" }, { $set: { expectedLast60: dec(1n) } }); // e.g. a later, smaller recomputation
    expect((await r.worker.reconciler.ledger()).problems.join("\n")).toContain("exceeds its expected Last-60 allocation");
  });
});
