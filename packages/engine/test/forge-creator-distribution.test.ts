/**
 * Forge's EXISTING post-migration creator LP distribution, recognised by Last-60 without any Forgepad
 * change (docs/REWARD_FUNDING.md §4–§5). Forge harvests its platform Fee Key, then — in a separate,
 * memo-less transaction — pays the launch creator 50 % (SOL + the launch-token leg in kind). That 50 % is
 * the creator's allocation, dedicated to Last-60 buyer rewards. Last-60 must attribute each payout to
 * exactly one verified harvest of the right launch, or leave it unresolved — never by amount.
 *
 * Numbered comments refer to the required scenarios (1–25).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { normalizeTransaction } from "../src/chain/tx";
import { big, dec } from "../src/db/decimal";
import type { Models } from "../src/db/models";
import { APPROVED_SHARES, attributeForgeDistribution, makeFundingPolicy, STREAM_INFO, WSOL_MINT, type CollectionFact, type ForgeAttributionContext, type ForgeDistributionTx, type ForgeHarvestTx, type TransferFact } from "../src/accounting/revenueStreams";
import { forgeDistributionWatch, forgeLaunchContextOf, ingestRevenue, revenueWatchAddresses } from "../src/revenue/ingest";
import { buildRevenueReport, renderRevenueReport } from "../src/revenue/report";
import { coveredThroughSlot } from "../src/indexer/cursor";
import { cursorId, syncAddress } from "../src/indexer/signatureSync";
import { MOCK_POOL } from "../src/providers/mock/MockProvider";
import { addr, buildTx, memo, opaque, sig, systemTransfer } from "./revenueTx";
import { freshDb, rig, SOL, startDb, stopDb, T0, wallet } from "./harness";
import { ACT, cFx, CREATOR, DEST, FORGE, ingest, llFx, policyV2, runtime, TOKEN } from "./revenueLaunch";
import { fixtureLaunch, forgeAta, forgeSplit, harvestTx, markCovered, payoutTx, reconcile, syntheticLaunch, type Launch } from "./forgeFlow";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const Q = 1_000_001n; // harvested WSOL (quote) leg, lamports
const TK = 77_000_003n; // harvested launch-token leg, raw units
const credits = (db: Models, q: Record<string, unknown> = {}) => db.RewardFunding.find(q).sort({ slot: 1, ordinal: 1 }).lean() as Promise<any[]>;
const attributions = (db: Models, q: Record<string, unknown> = {}) => db.FundingAttribution.find(q).sort({ slot: 1, ordinal: 1 }).lean() as Promise<any[]>;
const payable = async (db: Models) => (await credits(db, { payoutEligible: true })).map((c) => [c.fundingMint, big(c.creditableAmount)]);
/** Every recorded-but-unresolved payout leg: never a payable credit (the core safety property). */
async function unresolvedNeverPayable(db: Models) {
  const un = await attributions(db, { status: { $ne: "linked" } });
  for (const a of un) expect(await db.RewardFunding.countDocuments({ key: a.key, payoutEligible: true })).toBe(0);
  return un;
}
async function setup(o: { cover?: number } = {}) {
  const db = await freshDb();
  const l = await fixtureLaunch();
  if (o.cover !== 0) await markCovered(db, l, o.cover ?? ACT + 1_000);
  return { db, l };
}

// ── pure attribution model ──────────────────────────────────────────────────────────────────

describe("attributeForgeDistribution — pure", () => {
  const leg = (key: string, asset: string, gross: bigint, slot: number, sig: string): CollectionFact => ({ key, stream: "forge_platform_lp_fee_collection", signature: sig, slot, ordinal: 1, asset, recipient: "F", gross, expectedLast60: gross / 2n, linked: 0n, verified: true });
  const H = (sig: string, slot: number, q = 1_000n, t = 500n): ForgeHarvestTx => ({ signature: sig, slot, legs: [leg(`${sig}:q`, WSOL_MINT, q, slot, sig), leg(`${sig}:t`, "TOK", t, slot, sig)] });
  const T = (key: string, asset: string, amount: bigint, slot: number, sig = "D"): TransferFact => ({ key, signature: sig, slot, ordinal: 1, asset, sourceOwner: "F", destinationOwner: "C", amount, memoClaimSignature: null });
  const D = (slot: number, sol = 500n, tok = 250n, o: Partial<ForgeDistributionTx> = {}): ForgeDistributionTx => ({ signature: "D", slot, anchored: true, problems: [], legs: [T("d:q", WSOL_MINT, sol, slot), T("d:t", "TOK", tok, slot)], ...o });
  const ctx = (o: Partial<ForgeAttributionContext> = {}): ForgeAttributionContext => ({ harvests: [H("H1", 10)], distributions: [], coveredThroughSlot: 100, windowTruncated: false, tokenAsset: "TOK", linkedElsewhere: new Map(), ...o });

  test("links the first anchored payout after the latest harvest; per-mint credits; never by amount", () => {
    const r = attributeForgeDistribution(D(12), ctx());
    expect(r).toMatchObject({ outcome: "linked", harvest: "H1", previousHarvest: null });
    if (r.outcome !== "linked") throw new Error();
    expect(r.legs.map((x) => [x.collectionKey, x.creditable, x.excess])).toEqual([["H1:q", 500n, 0n], ["H1:t", 250n, 0n]]);
  });

  test("pending until indexing covers the payout slot; fail closed on every ambiguity", () => {
    expect(attributeForgeDistribution(D(12), ctx({ coveredThroughSlot: 11 })).outcome).toBe("pending");
    expect(attributeForgeDistribution(D(12), ctx({ coveredThroughSlot: null })).outcome).toBe("pending");
    const un = (d: ForgeDistributionTx, c: Partial<ForgeAttributionContext>) => {
      const r = attributeForgeDistribution(d, ctx(c));
      expect(r.outcome).toBe("unresolved");
      return r.outcome === "unresolved" ? r.reasons[0]!.split(":")[0] : "";
    };
    expect(un(D(12, 500n, 250n, { problems: ["forge_outflow_to_non_creator: X"] }), {})).toBe("forge_outflow_to_non_creator");
    expect(un(D(12, 500n, 250n, { anchored: false }), {})).toBe("no_launch_anchor");
    expect(un(D(12), { windowTruncated: true })).toBe("candidate_window_too_large");
    expect(un(D(12), { harvests: [H("H1", 10), H("H2", 12)] })).toBe("harvest_in_same_slot_as_distribution");
    expect(un(D(12), { harvests: [] })).toBe("no_preceding_harvest");
    expect(un(D(12), { harvests: [H("H1", 10), H("H1b", 10)] })).toBe("multiple_harvests_in_candidate_slot");
    expect(un(D(12), { distributions: [{ ...D(11), signature: "D0" }] })).toBe("competing_distribution_since_harvest");
    expect(un(D(12), { distributions: [{ ...D(10), signature: "D0" }] })).toBe("competing_distribution_since_harvest"); // same slot as the harvest: order unknown
    expect(un(D(12), { distributions: [{ ...D(12), signature: "D0" }] })).toBe("competing_distribution_since_harvest");
    expect(un(D(12), { harvests: [H("H0", 5), H("H1", 10)] })).toBe("previous_harvest_has_no_distribution");
    expect(un(D(12, 500n, 251n), {})).toBe("anchor_leg_exceeds_allocation");
    expect(un(D(12), { harvests: [{ signature: "H1", slot: 10, legs: [leg("H1:q", WSOL_MINT, 1_000n, 10, "H1")] }] })).toBe("anchor_leg_not_collected_by_harvest");
  });

  test("alternation satisfied: H0 → D0 → H1 → D links D to H1 (identical amounts are irrelevant)", () => {
    const r = attributeForgeDistribution(D(12), ctx({ harvests: [H("H0", 5), H("H1", 10)], distributions: [{ ...D(7), signature: "D0" }] }));
    expect(r).toMatchObject({ outcome: "linked", harvest: "H1", previousHarvest: "H0" });
  });

  test("a SOL leg above 50 % is excess (never payable) while the exact token leg stays creditable; a converted SOL leg has no harvest leg", () => {
    const r = attributeForgeDistribution(D(12, 501n, 250n), ctx());
    if (r.outcome !== "linked") throw new Error(r.outcome);
    expect(r.legs.map((x) => [x.creditable, x.excess, x.reasons[0]?.split(":")[0] ?? null])).toEqual([[0n, 1n, "exceeds_expected_allocation"], [250n, 0n, null]]);
    const usd1: ForgeHarvestTx = { signature: "H1", slot: 10, legs: [leg("H1:q", "USD1", 1_000n, 10, "H1"), leg("H1:t", "TOK", 500n, 10, "H1")] };
    const c = attributeForgeDistribution(D(12), ctx({ harvests: [usd1] }));
    if (c.outcome !== "linked") throw new Error(c.outcome);
    expect(c.legs.map((x) => [x.collectionKey, x.creditable, x.reasons[0]?.split(":")[0] ?? null])).toEqual([[null, 0n, "asset_not_collected_by_harvest"], ["H1:t", 250n, null]]);
  });
});

// ── decoding Forge's payout transaction ─────────────────────────────────────────────────────

describe("decoding Forge's existing payout (Raypostmigration.js sendPayouts)", () => {
  test("the creator-50 % payout: SOL + token leg in kind, fee payer Forge, no memo → two forge_creator_distribution legs", async () => {
    const { db, l } = await setup();
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, sol: 500_000n, token: 38_500_001n }));
    const ev: any[] = await db.RevenueEvent.find({ kind: "funding_inflow" }).sort({ ordinal: 1 }).lean();
    expect(ev.map((e) => [e.route, e.feeMint, e.sourceOwner, e.destinationOwner, e.status, e.evidence.anchored])).toEqual([
      ["forge_creator_distribution", "native:SOL", FORGE, CREATOR, "observed", true],
      ["forge_creator_distribution", l.tokenMint, FORGE, CREATOR, "observed", true],
    ]);
    expect(ev[1].sourceAccount).toBe(forgeAta(l)); // the same ATA the harvest credits
    expect(ev.every((e) => e.payoutEligible === false)).toBe(true); // raw events are never payable
  });

  test("ATA rent top-up inside the ATA program is not a payout leg; a creator wallet listed as a funding destination still takes the Forge route", async () => {
    const { db, l } = await setup();
    const h = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
    await ingest(db, l.p, h);
    const d = payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) });
    // Inject the ATA program's inner rent transfer (Forge → the creator's new ATA address).
    const ataIx = d.instructions.find((ix) => ix.programId === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")!;
    const rent = { ...ataIx, ordinal: 99, innerIndex: 0, stackHeight: 2, programId: "11111111111111111111111111111111", accounts: [FORGE, ataIx.accounts[1]!], data: systemTransfer(FORGE, ataIx.accounts[1]!, 2_039_280n).data };
    const withRent = { ...d, instructions: [...d.instructions.slice(0, d.instructions.indexOf(ataIx) + 1), rent, ...d.instructions.slice(d.instructions.indexOf(ataIx) + 1)] };
    await ingestRevenue(db, withRent, l.p.parseTransaction(withRent), l.p, runtime({ fundingDestinations: [DEST, CREATOR] }), { commitment: "confirmed" });
    expect((await credits(db)).map((c) => [c.route, c.correlationMethod, c.payoutEligible])).toEqual([["forge_creator_distribution", "forge_distribution_sequence", true], ["forge_creator_distribution", "forge_distribution_sequence", true]]);
    expect(await db.RevenueEvent.countDocuments({ kind: "funding_inflow" })).toBe(2);
  });

  test("the indexer watches Forge's token account for the launch token from the migration slot", async () => {
    const { l } = await setup();
    const w = forgeDistributionWatch(l.p.info(), runtime());
    expect(w).toEqual([{ address: forgeAta(l), fromSlot: l.p.info().destination!.migrationSlot }]);
    expect(revenueWatchAddresses(runtime(), l.p.info())).toEqual([DEST, forgeAta(l)]);
    expect(forgeDistributionWatch(l.p.info(), runtime({ forgePlatformLpBeneficiary: null }))).toEqual([]);
    expect(forgeLaunchContextOf(l.p, runtime())!.coverageKeys).toEqual([cursorId("raydium_launchlab", llFx.bondingPool, l.p.info().destination!.pool), cursorId("raydium_launchlab", llFx.bondingPool, forgeAta(l))]);
  });
});

// ── 1–3: the basic flow ─────────────────────────────────────────────────────────────────────

describe("one launch, one harvest", () => {
  test("1. a harvest followed by Forge's 50 % creator payout: attributed, credited once, full contribution record", async () => {
    const { db, l } = await setup();
    const h = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
    await ingest(db, l.p, h);
    const d = payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) });
    expect((await ingest(db, l.p, d)).newCredits).toBe(2);
    const cs = await credits(db);
    for (const c of cs) {
      expect(c).toMatchObject({ stream: "forge_platform_lp_last60_contribution", route: "forge_creator_distribution", correlationMethod: "forge_distribution_sequence", launchPhase: "post_migration", collectionSignature: h.signature, signature: d.signature, sourceWallet: FORGE, destinationWallet: CREATOR, creator: CREATOR, allocationOwner: "creator", policyVersion: "forge_phase_aware_v2", status: "reconciled", payoutEligible: true, ineligibleReason: null });
      expect(c.attribution).toMatchObject({ method: "forge_distribution_sequence", harvestSignature: h.signature, distributionSignature: d.signature, previousHarvestSignature: null, anchorMint: l.tokenMint, forgeWallet: FORGE, creator: CREATOR });
      expect(c.snapshot).toMatchObject({ v: 1, stream: "forge_platform_lp_last60_contribution", verification: "verified" });
    }
    expect(STREAM_INFO.forge_platform_lp_last60_contribution).toMatchObject({ allocationOwner: "creator", custodian: "forge" });
    expect(cs.map((c) => [c.fundingMint, big(c.collectedAmount), big(c.expectedAllocation), big(c.observedAmount), big(c.creditableAmount), big(c.excessAmount)])).toEqual([
      [WSOL_MINT, Q, 500_000n, 500_000n, 500_000n, 0n],
      [l.tokenMint, TK, 38_500_001n, 38_500_001n, 38_500_001n, 0n],
    ]);
    const recs: any[] = await db.RevenueReconciliation.find({}).sort({ collectionOrdinal: 1 }).lean();
    expect(recs.map((r) => [r.status, big(r.impliedRetained)])).toEqual([["reconciled", 500_001n], ["reconciled", 38_500_002n]]); // Forge's 50 % (+ dust), implied
    expect((await attributions(db)).map((a) => [a.status, a.payoutEligible, a.collectionSignature])).toEqual([["linked", true, h.signature], ["linked", true, h.signature]]);
    // Immutable v1 snapshot / attribution.
    await expect(db.RewardFunding.updateOne({ key: cs[0].key }, { $set: { "attribution.harvestSignature": "x" } }).exec()).rejects.toThrow("immutable");
    await expect(db.RewardFunding.updateOne({ key: cs[0].key }, { $set: { correlationMethod: "memo" } }).exec()).rejects.toThrow("immutable");
    await expect(db.RevenueEvent.updateOne({ route: "forge_creator_distribution" }, { $set: { route: null } }).exec()).rejects.toThrow("immutable");
  });

  test("2. a harvest with no creator payout yet: awaiting distribution, nothing credited", async () => {
    const { db, l } = await setup();
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    const recs: any[] = await db.RevenueReconciliation.find({}).lean();
    expect(recs.map((r) => [r.status, big(r.untransferred)]).sort()).toEqual([["awaiting_distribution", 38_500_001n], ["awaiting_distribution", 500_000n]].sort());
  });

  test("3. a payout indexed before its harvest waits (pending) and is attributed once indexing covers it", async () => {
    const { db, l } = await setup({ cover: 0 });
    const h = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
    const d = payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) });
    await ingest(db, l.p, d); // websocket fast path saw the payout first; the pool backlog is not indexed
    expect((await attributions(db)).map((a) => a.status)).toEqual(["pending", "pending"]);
    expect((await attributions(db))[0].reasons[0]).toContain("indexing_not_complete_through_slot");
    await ingest(db, l.p, h);
    expect(await db.RewardFunding.countDocuments()).toBe(0); // still no coverage proof
    await markCovered(db, l, ACT + 7);
    expect(await reconcile(db, l)).toBe(2);
    expect(await payable(db)).toEqual([[WSOL_MINT, 500_000n], [l.tokenMint, 38_500_001n]]);
  });

  test("3b. coverage claims completeness but no harvest precedes the payout: unresolved, never payable", async () => {
    const { db, l } = await setup();
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) }));
    const un = await unresolvedNeverPayable(db);
    expect(un.map((a) => [a.status, a.reasons[0]])).toEqual([["unresolved", "no_preceding_harvest"], ["unresolved", "no_preceding_harvest"]]);
    // A harvest indexed later never revives a decided row (it would contradict the coverage proof).
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
  });
});

// ── 4–7: many launches, many claims ─────────────────────────────────────────────────────────

describe("many launches, creators and outstanding claims", () => {
  test("4. launches of different creators in the same window: each payout funds only its own launch", async () => {
    const { db, l: a } = await setup();
    const b = await syntheticLaunch();
    const c = await syntheticLaunch();
    for (const x of [b, c]) await markCovered(db, x, ACT + 1_000);
    const ha = harvestTx(a, { slot: ACT + 5, quote: Q, token: TK });
    const hb = harvestTx(b, { slot: ACT + 5, quote: 2_000_000n, token: 10n });
    const hc = harvestTx(c, { slot: ACT + 6, quote: 3_000_000n, token: 20n });
    const db_ = payoutTx(b, { slot: ACT + 7, ...forgeSplit(2_000_000n, 10n) });
    const dc = payoutTx(c, { slot: ACT + 7, ...forgeSplit(3_000_000n, 20n) });
    const da = payoutTx(a, { slot: ACT + 8, ...forgeSplit(Q, TK) });
    // Every launch's indexer sees every transaction it watches; ingest everything into every launch.
    for (const tx of [ha, hb, hc, db_, dc, da]) for (const x of [a, b, c]) await ingest(db, x.p, tx);
    for (const [x, h, d] of [[a, ha, da], [b, hb, db_], [c, hc, dc]] as const) {
      const cs = await credits(db, { sourcePool: x.p.info().poolAddress });
      expect(cs.map((k) => [k.collectionSignature, k.signature, k.creator, k.payoutEligible])).toEqual([[h.signature, d.signature, x.creator, true], [h.signature, d.signature, x.creator, true]]);
    }
    // Another creator's payout is not even revenue of this launch.
    expect(await db.RevenueEvent.countDocuments({ sourcePool: a.p.info().poolAddress, signature: { $in: [db_.signature, dc.signature] } })).toBe(0);
  });

  test("5. one creator, two launches: the token anchor separates them; the other launch's payout is never this launch's revenue", async () => {
    const { db, l: a } = await setup();
    const b = await syntheticLaunch({ creator: CREATOR });
    await markCovered(db, b, ACT + 1_000);
    const ha = harvestTx(a, { slot: ACT + 5, quote: Q, token: TK });
    const hb = harvestTx(b, { slot: ACT + 6, quote: Q, token: TK }); // same amounts on purpose
    const dB = payoutTx(b, { slot: ACT + 7, ...forgeSplit(Q, TK) }); // B's payout lands between A's harvest and A's payout
    const dA = payoutTx(a, { slot: ACT + 8, ...forgeSplit(Q, TK) });
    // A SOL-only Forge → creator transfer (no launch identity) in the same window.
    const solOnly = buildTx({ slot: ACT + 7, feePayer: FORGE, ixs: [systemTransfer(FORGE, CREATOR, 500_000n)] });
    for (const tx of [ha, hb, dB, solOnly, dA]) for (const x of [a, b]) await ingest(db, x.p, tx);
    const ca = await credits(db, { sourcePool: a.p.info().poolAddress });
    const cb = await credits(db, { sourcePool: b.p.info().poolAddress });
    expect(ca.map((k) => [k.collectionSignature, k.signature, k.payoutEligible])).toEqual([[ha.signature, dA.signature, true], [ha.signature, dA.signature, true]]);
    expect(cb.map((k) => [k.collectionSignature, k.signature, k.payoutEligible])).toEqual([[hb.signature, dB.signature, true], [hb.signature, dB.signature, true]]);
    expect(ca.map((k) => k.fundingMint)).toEqual([WSOL_MINT, a.tokenMint]);
    expect(cb.map((k) => k.fundingMint)).toEqual([WSOL_MINT, b.tokenMint]);
    // The other launch's anchored payout is not even recorded under this launch.
    expect(await db.RevenueEvent.countDocuments({ sourcePool: a.p.info().poolAddress, signature: dB.signature })).toBe(0);
    expect(await db.RevenueEvent.countDocuments({ sourcePool: b.p.info().poolAddress, signature: dA.signature })).toBe(0);
    // The SOL-only transfer is recorded once and never payable.
    const un = await unresolvedNeverPayable(db);
    expect(un.map((x) => [x.signature, x.reasons[0]!.split(":")[0]])).toEqual([[solOnly.signature, "no_launch_anchor"]]);
    expect(await db.RewardFunding.countDocuments({ payoutEligible: true })).toBe(4);
  });

  test("6. several harvests of one launch: alternating harvest → payout pairs each settle their own harvest; an unpaid harvest blocks the next payout", async () => {
    const { db, l } = await setup();
    const h1 = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
    const d1 = payoutTx(l, { slot: ACT + 6, ...forgeSplit(Q, TK) });
    const h2 = harvestTx(l, { slot: ACT + 9, quote: 3n * Q, token: 3n * TK });
    const d2 = payoutTx(l, { slot: ACT + 10, ...forgeSplit(3n * Q, 3n * TK) });
    for (const tx of [h1, d1, h2, d2]) await ingest(db, l.p, tx);
    expect((await credits(db)).map((c) => [c.signature, c.collectionSignature, c.payoutEligible])).toEqual([[d1.signature, h1.signature, true], [d1.signature, h1.signature, true], [d2.signature, h2.signature, true], [d2.signature, h2.signature, true]]);
    expect((await credits(db))[2].attribution.previousHarvestSignature).toBe(h1.signature);
    // Outstanding claims: h3 never paid (Forge payout_error is not retried), then h4 and a payout.
    const h3 = harvestTx(l, { slot: ACT + 20, quote: Q, token: TK });
    const h4 = harvestTx(l, { slot: ACT + 25, quote: Q, token: TK });
    const d4 = payoutTx(l, { slot: ACT + 26, ...forgeSplit(Q, TK) });
    for (const tx of [h3, h4, d4]) await ingest(db, l.p, tx);
    const un = await unresolvedNeverPayable(db);
    expect(un.map((a) => [a.signature, a.reasons[0]!.split(":")[0], a.candidates])).toEqual([[d4.signature, "previous_harvest_has_no_distribution", [h4.signature, h3.signature]], [d4.signature, "previous_harvest_has_no_distribution", [h4.signature, h3.signature]]]);
    const recs: any[] = await db.RevenueReconciliation.find({ collectionSignature: { $in: [h3.signature, h4.signature] } }).lean();
    expect(recs.every((r) => r.status === "awaiting_distribution")).toBe(true);
  });

  test("7. two claims with identical amounts are told apart by sequence, not amount; without sequence evidence neither is credited", async () => {
    const { db, l } = await setup({ cover: 0 });
    const h1 = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
    const h2 = harvestTx(l, { slot: ACT + 8, quote: Q, token: TK });
    const d1 = payoutTx(l, { slot: ACT + 6, ...forgeSplit(Q, TK) });
    const d2 = payoutTx(l, { slot: ACT + 9, ...forgeSplit(Q, TK) });
    for (const tx of [d2, h2, d1, h1]) await ingest(db, l.p, tx); // out of order, before indexing coverage
    await markCovered(db, l, ACT + 9);
    await reconcile(db, l);
    expect((await credits(db)).map((c) => [c.signature, c.collectionSignature])).toEqual([[d1.signature, h1.signature], [d1.signature, h1.signature], [d2.signature, h2.signature], [d2.signature, h2.signature]]);
    // Same amounts, but the first payout is missing: the remaining payout could settle either claim.
    const { db: db2, l: l2 } = await setup();
    for (const tx of [h1, h2, d2]) await ingest(db2, l2.p, tx);
    expect(await db2.RewardFunding.countDocuments()).toBe(0);
    expect((await unresolvedNeverPayable(db2)).map((a) => a.reasons[0]!.split(":")[0])).toEqual(["previous_harvest_has_no_distribution", "previous_harvest_has_no_distribution"]);
  });
});

// ── 8–13: wrong amounts, wallets, mints and ambiguity ───────────────────────────────────────

describe("evidence failures are recorded and never payable", () => {
  test("8. a payout above 50 %: the excess SOL leg is never payable; an excess token leg (exact in Forge's code) voids the attribution", async () => {
    const { db, l } = await setup();
    const h = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
    await ingest(db, l.p, h);
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, sol: 500_001n, token: 38_500_001n })); // SDK UI estimate above the measured claim
    const cs = await credits(db);
    expect(cs.map((c) => [c.fundingMint, c.payoutEligible, big(c.creditableAmount), big(c.excessAmount)])).toEqual([[WSOL_MINT, false, 0n, 1n], [l.tokenMint, true, 38_500_001n, 0n]]);
    expect(cs[0].ineligibleReason).toContain("exceeds_expected_allocation");
    const rec: any = await db.RevenueReconciliation.findOne({ asset: WSOL_MINT }).lean();
    expect([rec.status, big(rec.creditable), big(rec.excess)]).toEqual(["excess", 0n, 1n]);
    const { db: db2, l: l2 } = await setup();
    await ingest(db2, l2.p, h);
    await ingest(db2, l2.p, payoutTx(l2, { slot: ACT + 7, sol: 500_000n, token: 38_500_002n }));
    expect(await db2.RewardFunding.countDocuments()).toBe(0);
    expect((await unresolvedNeverPayable(db2))[0].reasons[0]).toContain("anchor_leg_exceeds_allocation");
  });

  test("9. a payment from the wrong source wallet is not a Forge distribution; a payout not paid by Forge is refused", async () => {
    const { db, l } = await setup();
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    const other = addr();
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK), from: other }));
    expect(await db.RevenueEvent.countDocuments({ kind: "funding_inflow" })).toBe(0);
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 8, ...forgeSplit(Q, TK), feePayer: other }));
    const un = await unresolvedNeverPayable(db);
    expect(un.length).toBe(2);
    expect(un[0].reasons[0]).toContain("fee_payer_not_forge_platform_wallet");
    // A declared Forge wallet that is not the platform NFT wallet never verifies the harvest either.
    const { db: db2, l: l2 } = await setup();
    const wrong = runtime({ forgePlatformLpBeneficiary: other });
    await ingest(db2, l2.p, harvestTx(l2, { slot: ACT + 5, quote: Q, token: TK }), wrong);
    await ingest(db2, l2.p, payoutTx(l2, { slot: ACT + 7, ...forgeSplit(Q, TK) }), wrong);
    expect(await db2.RewardFunding.countDocuments({ payoutEligible: true })).toBe(0);
  });

  test("10. a payout to a wallet that is not the launch creator: recorded (it carries the launch token), never payable", async () => {
    const { db, l } = await setup();
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    const other = addr();
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK), to: other }));
    const un = await unresolvedNeverPayable(db);
    expect(un.map((a) => [a.destinationOwner, a.reasons[0]!.split(":")[0]])).toEqual([[other, "recipient_not_launch_creator"], [other, "recipient_not_launch_creator"]]);
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    expect(((await db.RevenueReconciliation.findOne({ asset: WSOL_MINT }).lean()) as any).status).toBe("awaiting_distribution");
  });

  test("11. an unsupported mint paid to the creator never satisfies the claim (no conversion; it is not this launch's payout)", async () => {
    const { db, l } = await setup();
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    const usdc = Keypair.generate().publicKey.toBase58();
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, sol: 500_000n, token: 38_500_001n, mint: usdc }));
    expect(await db.RevenueEvent.countDocuments({ kind: "funding_inflow" })).toBe(0);
    // The same unsupported mint next to the launch token: recorded, unresolved, never payable.
    const x = payoutTx(l, { slot: ACT + 8, ...forgeSplit(Q, TK) });
    const extra = payoutTx(l, { slot: ACT + 8, token: 5n, mint: usdc });
    const mixed = buildTx({ slot: ACT + 8, feePayer: FORGE, ixs: [systemTransfer(FORGE, CREATOR, 500_000n), ...[...x.instructions, ...extra.instructions].filter((ix) => ix.programId !== "11111111111111111111111111111111").map((ix) => ({ programId: ix.programId, accounts: ix.accounts, data: ix.data }))], tokens: Object.fromEntries([...x.postTokenBalances, ...extra.postTokenBalances].map((b) => [b.account, { owner: b.owner!, mint: b.mint, decimals: b.decimals }])) });
    await ingest(db, l.p, mixed);
    const un = await unresolvedNeverPayable(db);
    expect(un.length).toBe(3);
    expect(un.every((a) => a.reasons.join(" ").includes("foreign_mint_leg"))).toBe(true);
    expect(await db.RewardFunding.countDocuments()).toBe(0);
  });

  test("12. non-LP payments from Forge's platform wallet (SOL only, or the 25/50/25 distributor mode) are never credited and never block the real payout", async () => {
    const { db, l } = await setup();
    const h = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
    await ingest(db, l.p, h);
    // e.g. a bonding platform-fee payout or recoverRaydiumFeePayout.js: SOL only, no launch identity.
    await ingest(db, l.p, buildTx({ slot: ACT + 6, feePayer: FORGE, ixs: [systemTransfer(FORGE, CREATOR, 500_000n)] }));
    const d = payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) });
    await ingest(db, l.p, d);
    expect((await credits(db)).map((c) => [c.signature, c.payoutEligible])).toEqual([[d.signature, true], [d.signature, true]]);
    const un = await unresolvedNeverPayable(db);
    expect(un.map((a) => a.reasons[0]!.split(":")[0])).toEqual(["no_launch_anchor"]);
    // The distributor mode (creator 25 %, Forge rewards distributor 50 %) is not the approved model.
    const { db: db2, l: l2 } = await setup();
    await ingest(db2, l2.p, h);
    await ingest(db2, l2.p, payoutTx(l2, { slot: ACT + 7, sol: 250_000n, token: 19_250_000n, distributor: { wallet: addr(), lamports: 500_000n } }));
    const un2 = await unresolvedNeverPayable(db2);
    expect(un2.length).toBe(3);
    expect(un2.every((a) => a.reasons.join(" ").includes("forge_outflow_to_non_creator") || a.reasons[0]!.startsWith("recipient_not_launch_creator"))).toBe(true);
    expect(await db2.RewardFunding.countDocuments()).toBe(0);
  });

  test("13. multiple candidate claims for one payout (same-slot harvests, harvest in the payout slot, extra programs): unresolved", async () => {
    const { db, l } = await setup();
    const lockB = l.spec.cpmm!.platformLocks![0]!.lockPda;
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK, lock: lockB }));
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) }));
    const un = await unresolvedNeverPayable(db);
    expect(un[0].reasons[0]).toBe("multiple_harvests_in_candidate_slot");
    expect(un[0].candidates.length).toBe(2);
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    const { db: db2, l: l2 } = await setup();
    await ingest(db2, l2.p, harvestTx(l2, { slot: ACT + 5, quote: Q, token: TK }));
    await ingest(db2, l2.p, harvestTx(l2, { slot: ACT + 7, quote: Q, token: TK }));
    await ingest(db2, l2.p, payoutTx(l2, { slot: ACT + 7, ...forgeSplit(Q, TK) }));
    expect((await unresolvedNeverPayable(db2))[0].reasons[0]).toContain("harvest_in_same_slot_as_distribution");
    expect(await db2.RewardFunding.countDocuments()).toBe(0);
    // A transaction that also calls another program (e.g. a swap) is not Forge's payout shape.
    const { db: db3, l: l3 } = await setup();
    await ingest(db3, l3.p, harvestTx(l3, { slot: ACT + 5, quote: Q, token: TK }));
    await ingest(db3, l3.p, payoutTx(l3, { slot: ACT + 7, ...forgeSplit(Q, TK), extra: [opaque(addr(), [FORGE], Buffer.from([9]))] }));
    expect((await unresolvedNeverPayable(db3))[0].reasons.join(" ")).toContain("unexpected_programs");
    expect(await db3.RewardFunding.countDocuments()).toBe(0);
  });
});

// ── 14–19: idempotency, concurrency, ordering, partial, multi-mint ──────────────────────────

describe("idempotency, concurrency and ordering", () => {
  test("14. duplicate ingestion (re-indexing, websocket + poll, restarts) adds nothing", async () => {
    const { db, l } = await setup();
    const h = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
    const d = payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) });
    for (let i = 0; i < 3; i++) {
      const p = (await fixtureLaunch()).p;
      await ingest(db, p, h);
      await ingest(db, p, d);
    }
    expect([await db.RevenueEvent.countDocuments(), await db.RewardFunding.countDocuments(), await db.FundingAttribution.countDocuments()]).toEqual([4, 2, 2]);
    expect(await payable(db)).toEqual([[WSOL_MINT, 500_000n], [l.tokenMint, 38_500_001n]]);
  });

  test("15. a worker restart in the middle of a pass converges to the same credits (none duplicated, none changed)", async () => {
    const { db, l } = await setup({ cover: 0 });
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) }));
    await markCovered(db, l, ACT + 100);
    await reconcile(db, l);
    const before = await db.RewardFunding.find({}, { _id: 0, createdAt: 0 }).sort({ key: 1 }).lean();
    // Crash after the first credit was written, before the second credit and the queue update.
    await db.RewardFunding.deleteOne({ key: (before[1] as any).key });
    await db.FundingAttribution.updateMany({}, { $set: { status: "pending" } });
    await reconcile(db, l);
    await reconcile(db, l);
    expect(await db.RewardFunding.find({}, { _id: 0, createdAt: 0 }).sort({ key: 1 }).lean()).toEqual(before);
    expect((await attributions(db)).map((a) => a.status)).toEqual(["linked", "linked"]);
  });

  test("16. concurrent reconciliation passes credit each leg exactly once", async () => {
    const { db, l } = await setup({ cover: 0 });
    const pairs = Array.from({ length: 4 }, (_, i) => [harvestTx(l, { slot: ACT + 10 + i * 10, quote: Q + BigInt(i), token: TK }), payoutTx(l, { slot: ACT + 12 + i * 10, ...forgeSplit(Q + BigInt(i), TK) })] as const);
    for (const [h, d] of pairs) {
      await ingest(db, l.p, h);
      await ingest(db, l.p, d);
    }
    await markCovered(db, l, ACT + 100);
    const results = await Promise.all(Array.from({ length: 6 }, () => reconcile(db, l)));
    expect(results.reduce((a, b) => a + b, 0)).toBe(8);
    const cs = await credits(db, { payoutEligible: true });
    expect(cs.length).toBe(8);
    expect(new Set(cs.map((c) => c.key)).size).toBe(8);
    for (const c of cs) expect(c.collectionSignature).toBe(pairs.find(([, d]) => d.signature === c.signature)![0].signature);
  });

  test("17. a partial payout is credited as observed (the rest stays untransferred); a second payout for the same harvest is unresolved", async () => {
    const { db, l } = await setup();
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, sol: 300_000n, token: 38_500_001n }));
    expect(await payable(db)).toEqual([[WSOL_MINT, 300_000n], [l.tokenMint, 38_500_001n]]);
    let rec: any = await db.RevenueReconciliation.findOne({ asset: WSOL_MINT }).lean();
    expect([rec.status, big(rec.untransferred)]).toEqual(["partial", 200_000n]);
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 9, sol: 200_000n, token: 1n }));
    expect((await unresolvedNeverPayable(db)).map((a) => a.reasons[0]!.split(":")[0])).toEqual(["competing_distribution_since_harvest", "competing_distribution_since_harvest"]);
    rec = await db.RevenueReconciliation.findOne({ asset: WSOL_MINT }).lean();
    expect(rec.status).toBe("partial");
  });

  test("18. multiple fee mints: per-mint credits; a non-SOL quote converted by Forge (Jupiter) is never credited as SOL", async () => {
    const usd1 = Keypair.generate().publicKey.toBase58();
    const db = await freshDb();
    const l = await syntheticLaunch({ quoteMint: usd1 });
    await markCovered(db, l, ACT + 1_000);
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: 5_000_000n, token: TK })); // 5 USD1 + token
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 9, sol: 9_000_000n, token: 38_500_001n })); // SOL from the swap + token in kind
    expect(await payable(db)).toEqual([[l.tokenMint, 38_500_001n]]);
    const un = await unresolvedNeverPayable(db);
    expect(un.map((a) => [a.asset, a.reasons[0]!.split(":")[0]])).toEqual([[WSOL_MINT, "asset_not_collected_by_harvest"]]);
    const rec: any = await db.RevenueReconciliation.findOne({ asset: usd1 }).lean();
    expect([rec.status, big(rec.untransferred)]).toEqual(["awaiting_distribution", 2_500_000n]); // USD1 never merged with SOL
  });

  test("19. out-of-order ingestion of several harvests and payouts converges to the chain-order attribution", async () => {
    const { db, l } = await setup({ cover: 0 });
    const txs = [harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }), payoutTx(l, { slot: ACT + 6, ...forgeSplit(Q, TK) }), harvestTx(l, { slot: ACT + 9, quote: 2n * Q, token: TK }), payoutTx(l, { slot: ACT + 11, ...forgeSplit(2n * Q, TK) }), harvestTx(l, { slot: ACT + 15, quote: 3n * Q, token: TK }), payoutTx(l, { slot: ACT + 16, ...forgeSplit(3n * Q, TK) })];
    for (const i of [5, 2, 0, 3, 1, 4]) await ingest(db, l.p, txs[i]!);
    await markCovered(db, l, ACT + 16);
    expect(await reconcile(db, l)).toBe(6);
    expect((await credits(db)).map((c) => [c.signature, c.collectionSignature])).toEqual([0, 0, 2, 2, 4, 4].map((i) => [txs[i + 1]!.signature, txs[i]!.signature]));
  });
});

// ── 20–21, 23–25: history, finality, double counting, CPMM, legacy policy ───────────────────

describe("history, double counting and other streams", () => {
  test("20. historical harvests / payouts without sufficient evidence never become payable", async () => {
    // (a) at or before the activation slot: recorded and linked, never payable, never rewritten.
    const { db, l } = await setup();
    await ingest(db, l.p, harvestTx(l, { slot: ACT - 3, quote: Q, token: TK }));
    await ingest(db, l.p, payoutTx(l, { slot: ACT - 1, ...forgeSplit(Q, TK) }));
    const cs = await credits(db);
    expect(cs.every((c) => !c.payoutEligible && String(c.ineligibleReason).includes(`before_policy_activation_slot_${ACT}`))).toBe(true);
    expect(await reconcile(db, l, runtime({ policy: policyV2(ACT - 10) }))).toBe(0); // a later, earlier activation never rewrites them
    expect((await credits(db)).every((c) => !c.payoutEligible)).toBe(true);
    // (b) a migration spec without platform-lock facts: the harvest is unresolved, so is any credit.
    const db2 = await freshDb();
    const l2 = await fixtureLaunch();
    l2.p.attach({ ...l2.spec, cpmm: { ...l2.spec.cpmm!, platformLocks: undefined, allPlatformLocks: undefined } });
    await markCovered(db2, l2, ACT + 1_000);
    await ingest(db2, l2.p, harvestTx(l2, { slot: ACT + 5, quote: Q, token: TK }));
    await ingest(db2, l2.p, payoutTx(l2, { slot: ACT + 7, ...forgeSplit(Q, TK) }));
    expect(await db2.RewardFunding.countDocuments({ payoutEligible: true })).toBe(0);
    expect(((await db2.RewardFunding.findOne({}).lean()) as any).ineligibleReason).toContain("collection_not_verified");
  });

  test("23. no double counting: the gross harvest is a collection, only the creator's observed 50 % is funding; Forge's 50 % is implied", async () => {
    const { db, l } = await setup();
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) }));
    const report = await buildRevenueReport(db, { sourcePool: llFx.bondingPool, policy: policyV2() });
    expect(report.postMigration.forgePlatformLp[WSOL_MINT]).toMatchObject({ grossClaimed: String(Q), last60ExpectedContribution: "500000", last60FundingReceived: "500000", last60FundingCreditable: "500000", forgeRetainedExpected: "500001", forgeRetainedImplied: "500001", forgeRetainedObserved: null });
    expect(report.buyerRewards.verifiedForgeLpFunding).toEqual({ [WSOL_MINT]: "500000", [l.tokenMint]: "38500001" });
    expect(report.buyerRewards.verifiedBondingCurveFunding).toEqual({});
    expect(report.buyerRewards.forgeCreatorDistributions).toMatchObject({ linked: 2, linkedPayable: 2, pending: 0, unresolved: 0 });
    expect(renderRevenueReport(report)).toContain("Forge creator distributions      linked 2 (payable 2)");
    // The collection rows themselves never carry credit; one credit per transfer leg only.
    expect(await db.RewardFunding.countDocuments({ key: { $regex: "^forge_platform_lp_fee_collection" } })).toBe(0);
    expect(await db.RewardFunding.countDocuments()).toBe(2);
  });

  test("24. CPMM creator trading fees are untouched: never a Forge distribution, never funding", async () => {
    const { db, l } = await setup();
    const real = normalizeTransaction(cFx.txs.collectCreatorFee);
    await markCovered(db, l, real.slot + 100);
    await ingestRevenue(db, real, l.p.parseTransaction(real), l.p, runtime(), { commitment: "finalized" });
    expect(await db.RevenueEvent.countDocuments({ route: "forge_creator_distribution" })).toBe(0);
    const e: any = await db.RevenueEvent.findOne({ stream: "cpmm_creator_trading_fee" }).lean();
    expect(e.beneficiary).toBe(CREATOR);
    // A Forge harvest + payout afterwards: credited to the Forge LP stream only, never to the CPMM fee.
    const h = harvestTx(l, { slot: real.slot + 5, quote: Q, token: TK });
    await ingest(db, l.p, h);
    await ingest(db, l.p, payoutTx(l, { slot: real.slot + 7, ...forgeSplit(Q, TK) }));
    const cs = await credits(db);
    expect(cs.length).toBe(2);
    expect(cs.every((c) => c.collectionSignature === h.signature && c.stream === "forge_platform_lp_last60_contribution")).toBe(true);
    expect(((await db.RevenueReconciliation.findOne({ key: e.key }).lean()) as any).status).toBe("not_applicable");
  });

  test("25. legacy policy unchanged: links are recorded for audit, never payable; a funding-destination memo transfer keeps its route", async () => {
    const legacy = makeFundingPolicy({ version: "legacy_creator_fee_v1", activationSlot: null, ...APPROVED_SHARES });
    const db = await freshDb();
    const l = await fixtureLaunch();
    const r = runtime({ policy: legacy });
    await markCovered(db, l, ACT + 1_000, r);
    await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }), r);
    await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) }), r);
    const cs = await credits(db);
    expect(cs.length).toBe(2);
    expect(cs.every((c) => !c.payoutEligible && String(c.ineligibleReason).includes("policy_legacy_creator_fee_v1_does_not_fund_from_contributions"))).toBe(true);
    // PR #7's explicit route is unaffected: a memo transfer into a funding destination stays last60_destination.
    const { db: db2, l: l2 } = await setup();
    const h = harvestTx(l2, { slot: ACT + 5, quote: Q, token: TK });
    await ingest(db2, l2.p, h);
    await ingest(db2, l2.p, buildTx({ slot: ACT + 7, feePayer: FORGE, ixs: [memo(`last60:v1:${h.signature}`), systemTransfer(FORGE, DEST, 500_000n)] }));
    const c2 = await credits(db2);
    expect(c2.map((c) => [c.route, c.correlationMethod, c.destinationWallet, c.payoutEligible])).toEqual([["last60_destination", "memo", DEST, true]]);
    expect(await db2.FundingAttribution.countDocuments()).toBe(0);
  });
});

// ── 21–22: rounds (finality and one-time consumption) ───────────────────────────────────────

describe("round consumption of Forge creator distributions", () => {
  const W = 240_000;
  const EXEC = T0 + W + 30_000;
  /**
   * A rewards rig whose chain runs at the fixture's slots: the harvest and payout signatures are real
   * signatures of that chain (so their finality is read from it), ingested through the real decoder.
   */
  async function roundRig(o: { finalizeHarvest?: boolean } = {}) {
    const r = await rig({ env: { REWARD_FUNDING_POLICY: "forge_phase_aware_v2", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: String(ACT), LAST60_FUNDING_DESTINATIONS: DEST, FORGE_PLATFORM_LP_BENEFICIARY: FORGE } });
    r.chain.slot = ACT + 50;
    await r.worker.scheduler.tick(r.clock.now());
    const l = await fixtureLaunch();
    await markCovered(r.db, l, ACT + 10_000);
    const buyers: string[] = [];
    for (const w of Array.from({ length: 6 }, wallet)) {
      buyers.push(r.trade({ trader: w, quote: SOL / 10n }));
      r.chain.advance(2);
    }
    const hSlot = r.chain.slot;
    const hSig = o.finalizeHarvest === false ? sig() : r.trade({ trader: wallet(), kind: "sell", quote: 1n }); // a chain signature (finality is read from the chain)
    r.chain.advance(2);
    const dSlot = r.chain.slot;
    const dSig = r.trade({ trader: wallet(), kind: "sell", quote: 1n });
    r.chain.advance(2);
    await ingest(r.db, l.p, harvestTx(l, { signature: hSig, slot: hSlot, quote: 2n * SOL, token: TK }));
    await ingest(r.db, l.p, payoutTx(l, { signature: dSig, slot: dSlot, ...forgeSplit(2n * SOL, TK) }));
    r.chain.advance(40);
    const run = async (start: number) => {
      await r.worker.scheduler.tick(r.clock.now());
      r.clock.set(start + W);
      await r.worker.scheduler.tick(r.clock.now());
      r.clock.set(start + W + 30_000);
      await r.worker.scheduler.tick(r.clock.now());
    };
    return { r, l, run };
  }

  test("22. the creator's SOL 50 % funds exactly one round (REWARD_PERCENTAGE not applied); the token leg is recorded, never consumed", async () => {
    const { r, l, run } = await roundRig();
    expect(await r.db.RewardFunding.countDocuments({ payoutEligible: true })).toBe(2);
    await run(T0);
    const r1: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(big(r1.funding)).toBe(SOL);
    expect(r1.fundingBreakdown).toMatchObject({ credits: 1, pendingFinality: 0 });
    expect(await r.db.RewardFunding.countDocuments({ fundingMint: WSOL_MINT, roundNumber: 1 })).toBe(1);
    expect(await r.db.RewardFunding.countDocuments({ fundingMint: l.tokenMint, roundNumber: null })).toBe(1);
    // Next round: nothing left to consume; re-reconciliation never re-credits.
    await reconcile(r.db, l);
    r.chain.advance(40);
    for (let i = 0; i < 3 && !(await r.db.Round.findOne({ roundNumber: 2, snapshotSlot: { $ne: null } }).lean()); i++) await run(r.clock.now());
    const r2: any = await r.db.Round.findOne({ roundNumber: 2 }).lean();
    if (r2?.snapshotSlot) expect(big(r2.funding ?? 0)).toBe(0n);
    expect(await r.db.RewardFunding.countDocuments({ roundNumber: { $ne: null } })).toBe(1);
    expect((await r.worker.reconciler.ledger()).problems).toEqual([]);
  });

  test("21. a harvest that has not reached finality (or never lands) never funds a round", async () => {
    const { r, run } = await roundRig({ finalizeHarvest: false });
    expect(await r.db.RewardFunding.countDocuments({ payoutEligible: true })).toBe(2); // attributed …
    await run(T0);
    const r1: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(big(r1.funding)).toBe(0n); // … but not consumable: the claim signature is not finalized
    expect(r1.fundingBreakdown).toMatchObject({ credits: 0, pendingFinality: 1 });
    expect(await r.db.RewardFunding.countDocuments({ roundNumber: { $ne: null } })).toBe(0);
  });
});

// ── indexing coverage (what makes out-of-order ingestion safe) ──────────────────────────────

describe("indexing coverage", () => {
  test("a complete, anchored poll pass records syncedThroughSlot; an incomplete pass never does", async () => {
    const r = await rig();
    for (let i = 0; i < 5; i++) {
      r.trade({ trader: wallet(), quote: SOL / 100n });
      r.chain.advance(1);
    }
    const key = cursorId("mock", MOCK_POOL, MOCK_POOL);
    const ctx = { db: r.db, provider: r.provider, minBuyQuote: 1n, rpc: r.chain };
    const s0 = await r.chain.getSlot("confirmed");
    const partial = await syncAddress(ctx, MOCK_POOL, { cursorKey: key, source: "indexer", cap: 50_000, concurrency: 2, maxPerPass: 2, coverageSlot: s0 });
    expect(partial.more).toBe(true);
    expect(((await r.db.WorkerState.findById(key).lean()) as any).syncedThroughSlot ?? null).toBeNull();
    const covPartial = await coveredThroughSlot(r.db, key);
    expect(covPartial).toBeLessThan(s0); // only what the cursor proves
    await syncAddress(ctx, MOCK_POOL, { cursorKey: key, source: "indexer", cap: 50_000, concurrency: 2, coverageSlot: s0 });
    expect(await coveredThroughSlot(r.db, key)).toBe(s0);
    // Monotonic: an older anchor never lowers it; no cursor → unknown.
    await syncAddress(ctx, MOCK_POOL, { cursorKey: key, source: "indexer", cap: 50_000, concurrency: 2, coverageSlot: s0 - 3 });
    expect(await coveredThroughSlot(r.db, key)).toBe(s0);
    expect(await coveredThroughSlot(r.db, "cursor:none")).toBeNull();
  });

  test("ATA derivation matches spl-token for the launch token program", async () => {
    const l = await fixtureLaunch();
    expect(forgeAta(l)).toBe(getAssociatedTokenAddressSync(new PublicKey(l.tokenMint), new PublicKey(FORGE), true, new PublicKey(TOKEN)).toBase58());
    expect(dec(1n)).toBeTruthy();
  });
});
