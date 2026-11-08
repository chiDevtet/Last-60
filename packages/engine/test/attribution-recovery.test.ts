/**
 * Operator recovery of unresolved Forge creator-distribution attributions (docs/REWARD_FUNDING.md §15).
 * Recovery is permission to RE-RUN the normal attribution, never to override it: a leg becomes payable
 * only if `attributeForgeDistribution` now links it, every attempt is audited append-only, and the
 * original unresolved decision is preserved verbatim.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { big, dec } from "../src/db/decimal";
import type { Models } from "../src/db/models";
import { WSOL_MINT } from "../src/accounting/revenueStreams";
import { forgeLaunchContextOf } from "../src/revenue/ingest";
import { recoverAttribution, RecoveryError, type RecoveryDeps } from "../src/recovery/attributionRecovery";
import { addr, splTransferChecked } from "./revenueTx";
import { freshDb, startDb, stopDb } from "./harness";
import { ACT, CREATOR, FORGE, ingest, runtime, TOKEN } from "./revenueLaunch";
import { fixtureLaunch, forgeSplit, harvestTx, markCovered, payoutTx, syntheticLaunch, type Launch } from "./forgeFlow";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const Q = 1_000_001n;
const TK = 77_000_003n;
const half = (x: bigint) => x / 2n;
const okRpc = { getSlot: async () => ACT + 1_000_000, getSignatureStatuses: async (s: string[]) => s.map(() => ({ slot: ACT, confirmations: null, err: null, confirmationStatus: "finalized" }) as any) };
const deps = (db: Models, l: Launch, o: Partial<RecoveryDeps> = {}): RecoveryDeps => ({ db, provider: l.p, runtime: runtime(), rpc: okRpc, enabled: true, ...o });
const attrs = (db: Models, q: Record<string, unknown> = {}) => db.FundingAttribution.find(q).sort({ ordinal: 1 }).lean() as Promise<any[]>;
const original = (a: any) => ({ status: a.status, reasons: a.reasons, candidates: a.candidates, evidence: a.evidence, evaluatedAt: a.evaluatedAt?.toISOString?.() ?? null, evaluations: a.evaluations, collectionKey: a.collectionKey, payoutEligible: a.payoutEligible });

/**
 * PR #8 scenario 3b: indexing claimed completeness but the payout's harvest was missing (an indexing
 * gap) → both legs unresolved `no_preceding_harvest`. Then the missing harvest is ingested.
 */
async function gapScenario(o: { sol?: bigint; token?: bigint; ingestHarvest?: boolean } = {}) {
  const db = await freshDb();
  const l = await fixtureLaunch();
  await markCovered(db, l, ACT + 1_000);
  const split = forgeSplit(Q, TK);
  const d = payoutTx(l, { slot: ACT + 7, sol: o.sol ?? split.sol, token: o.token ?? split.token });
  await ingest(db, l.p, d);
  const un = await attrs(db);
  expect(un.map((a) => [a.status, a.reasons[0]])).toEqual([["unresolved", "no_preceding_harvest"], ["unresolved", "no_preceding_harvest"]]);
  const h = harvestTx(l, { slot: ACT + 5, quote: Q, token: TK });
  if (o.ingestHarvest !== false) await ingest(db, l.p, h);
  expect(await db.RewardFunding.countDocuments()).toBe(0); // the normal pass never revives a decided row
  return { db, l, d, h, sol: un[0], tok: un[1] };
}

describe("recovery re-runs the normal attribution", () => {
  test("a genuine unresolved attribution becomes linked only after the normal verification passes; the original decision is preserved", async () => {
    const { db, l, d, h, sol } = await gapScenario();
    const before = original(sol);
    const out = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "admin-wallet-1", note: "harvest backfilled after an RPC gap" });
    expect(out).toMatchObject({ outcome: "linked", payoutEligible: true, rewardFundingKey: sol.key, linkedHarvestSignature: h.signature, previousHarvestSignature: null, operator: "admin-wallet-1", failureReason: null });
    expect(out.original).toMatchObject({ status: "unresolved", reasons: ["no_preceding_harvest"], signature: d.signature });
    expect(out.evaluation).toMatchObject({ coveredThroughSlot: ACT + 1_000, distributionSlot: ACT + 7, attributionOutcome: "linked", coverageKeys: forgeLaunchContextOf(l.p, runtime())!.coverageKeys });
    expect(out.evaluation.algorithm).toContain("attributeForgeDistribution");
    expect(out.transactions).toMatchObject({ distribution: { signature: d.signature }, harvest: { signature: h.signature, slot: ACT + 5 } });
    const c: any = await db.RewardFunding.findOne({ key: sol.key }).lean();
    expect(c).toMatchObject({ correlationMethod: "forge_distribution_sequence", route: "forge_creator_distribution", collectionSignature: h.signature, destinationWallet: CREATOR, payoutEligible: true, fundingMint: WSOL_MINT });
    expect(big(c.creditableAmount)).toBe(half(Q));
    expect(c.attribution).toMatchObject({ harvestSignature: h.signature, recovery: { requestId: out.requestId, operator: "admin-wallet-1", originalReasons: ["no_preceding_harvest"] } });
    // The original unresolved decision is untouched; only the one-time recovery pointer is added.
    const after: any = await db.FundingAttribution.findOne({ key: sol.key }).lean();
    expect(original(after)).toEqual(before);
    expect(after.recovery).toMatchObject({ requestId: out.requestId, outcome: "linked", rewardFundingKey: sol.key, payoutEligible: true });
    // The sibling (token) leg was not selected: it stays unresolved and uncredited.
    expect(await db.RewardFunding.countDocuments()).toBe(1);
    // Audit rows are append-only.
    await expect(db.AttributionRecovery.updateOne({ requestId: out.requestId }, { $set: { outcome: "rejected" } }).exec()).rejects.toThrow(/append-only/);
    await expect(db.AttributionRecovery.deleteOne({ requestId: out.requestId }).exec()).rejects.toThrow(/append-only/);
  });

  test("insufficient evidence: the attribution stays unresolved, nothing is credited, the attempt is recorded", async () => {
    const { db, l, sol } = await gapScenario({ ingestHarvest: false });
    const out = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "op" });
    expect(out).toMatchObject({ outcome: "still_unresolved", resultReasons: ["no_preceding_harvest"], rewardFundingKey: null, payoutEligible: false });
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    expect(original((await attrs(db, { key: sol.key }))[0])).toEqual(original(sol));
    expect((await attrs(db, { key: sol.key }))[0].recovery).toBeNull();
    expect(await db.AttributionRecovery.countDocuments({ attributionKey: sol.key })).toBe(1);
  });

  test("incomplete indexing coverage or unfinalized evidence: refused, left unresolved", async () => {
    const { db, l, sol } = await gapScenario();
    const keys = forgeLaunchContextOf(l.p, runtime())!.coverageKeys;
    await db.WorkerState.updateMany({ _id: { $in: keys } }, { $set: { syncedThroughSlot: ACT + 6 } });
    const r1 = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "op" });
    expect(r1).toMatchObject({ outcome: "rejected" });
    expect(r1.failureReason).toContain("indexing_coverage_incomplete");
    await db.WorkerState.updateMany({ _id: { $in: keys } }, { $set: { syncedThroughSlot: ACT + 1_000 } });
    const r2 = await recoverAttribution(deps(db, l, { rpc: { ...okRpc, getSlot: async () => ACT + 6 } }), { attributionKey: sol.key, operator: "op" });
    expect(r2.failureReason).toContain("distribution_not_finalized");
    const r3 = await recoverAttribution(deps(db, l, { rpc: { ...okRpc, getSignatureStatuses: async (s: string[]) => s.map(() => ({ slot: 1, confirmations: 3, err: null, confirmationStatus: "confirmed" }) as any) } }), { attributionKey: sol.key, operator: "op" });
    expect(r3).toMatchObject({ outcome: "still_unresolved", failureReason: "linked_evidence_not_finalized" });
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    expect((await attrs(db, { key: sol.key }))[0]).toMatchObject({ status: "unresolved", recovery: null });
  });

  test("wrong launch: an attribution of another launch is refused", async () => {
    const { db, sol } = await gapScenario();
    const other = await syntheticLaunch();
    const r = await recoverAttribution({ db, provider: other.p, runtime: runtime(), rpc: okRpc, enabled: true }, { attributionKey: sol.key, operator: "op" });
    expect(r.outcome).toBe("rejected");
    expect(r.failureReason).toContain("wrong_launch");
    expect(await db.RewardFunding.countDocuments()).toBe(0);
  });

  test("wrong creator wallet, incorrect harvest sequence, invalid mint and out-of-bounds amounts stay unresolved", async () => {
    const still = async (setup: (db: Models, l: Launch) => Promise<void>) => {
      const db = await freshDb();
      const l = await fixtureLaunch();
      await markCovered(db, l, ACT + 1_000);
      await setup(db, l);
      const un = await attrs(db, { status: "unresolved" });
      expect(un.length).toBeGreaterThan(0);
      for (const a of un) {
        const r = await recoverAttribution(deps(db, l), { attributionKey: a.key, operator: "op" });
        expect(r.outcome).toBe("still_unresolved");
      }
      expect(await db.RewardFunding.countDocuments({ key: { $in: un.map((a) => a.key) } })).toBe(0);
      return un.map((a) => String(a.reasons[0]).split(":")[0]);
    };
    // Wrong creator wallet: Forge pays someone else.
    expect(await still(async (db, l) => {
      await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
      await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK), to: addr() }));
    })).toContain("recipient_not_launch_creator");
    // Incorrect harvest sequence: an earlier harvest was never paid.
    expect(await still(async (db, l) => {
      await ingest(db, l.p, harvestTx(l, { slot: ACT + 3, quote: Q, token: TK }));
      await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
      await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) }));
    })).toContain("previous_harvest_has_no_distribution");
    // Invalid mint: a foreign token leg in the payout.
    expect(await still(async (db, l) => {
      const foreign = addr();
      const src = getAssociatedTokenAddressSync(new PublicKey(foreign), new PublicKey(FORGE), true, new PublicKey(TOKEN)).toBase58();
      await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
      await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK), extra: [splTransferChecked(src, foreign, addr(), FORGE, 5n, 6)] }));
    })).toEqual(expect.arrayContaining([expect.stringMatching(/foreign|forge_outflow_to_non_creator/)]));
    // Amount outside the expected bound: the token leg exceeds the harvest's 50 %.
    expect(await still(async (db, l) => {
      await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }));
      await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, sol: half(Q), token: half(TK) + 1n }));
    })).toContain("anchor_leg_exceeds_allocation");
  });
});

describe("recovery safety", () => {
  test("duplicate requests: a repeated request id returns the recorded result; a new request after success is refused — one credit", async () => {
    const { db, l, sol } = await gapScenario();
    const a = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "op", requestId: "rr_retry-0001" });
    const b = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "op", requestId: "rr_retry-0001" });
    expect(b.requestId).toBe(a.requestId);
    expect(b.outcome).toBe("linked");
    expect(await db.AttributionRecovery.countDocuments({ requestId: "rr_retry-0001" })).toBe(1);
    const c = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "op" });
    expect(c).toMatchObject({ outcome: "rejected", failureReason: "already_recovered" });
    expect(await db.RewardFunding.countDocuments({ key: sol.key })).toBe(1);
    await expect(recoverAttribution(deps(db, l), { attributionKey: "other", operator: "op", requestId: "rr_retry-0001" })).rejects.toThrow(/reused/);
  });

  test("concurrent recovery attempts: exactly one credit, every attempt audited", async () => {
    const { db, l, sol } = await gapScenario();
    const out = await Promise.all(Array.from({ length: 4 }, (_, i) => recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: `op${i}` })));
    expect(out.filter((x) => x.outcome === "linked").length).toBe(1);
    expect(out.filter((x) => x.outcome === "rejected").length).toBe(3);
    expect(await db.RewardFunding.countDocuments({ key: sol.key })).toBe(1);
    expect(await db.AttributionRecovery.countDocuments({ attributionKey: sol.key })).toBe(4);
    expect(await db.TransferUse.countDocuments({ ref: sol.key })).toBe(1);
  });

  test("an existing reward-funding credit blocks recovery", async () => {
    const { db, l, sol } = await gapScenario();
    await db.RewardFunding.create({ key: sol.key, stream: "forge_platform_lp_last60_contribution", collectionKey: "c", correlationMethod: "forge_distribution_sequence", provider: "p", tokenMint: "m", sourcePool: "s", pool: "s", signature: "x", ordinal: 0, slot: 1, collectionSlot: 1, fundingMint: WSOL_MINT, observedAmount: dec(1n), creditableAmount: dec(0n), excessAmount: dec(0n), status: "unresolved", payoutEligible: false, policy: { v: 1 }, snapshot: { v: 1 } });
    const r = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "op" });
    expect(r).toMatchObject({ outcome: "rejected", failureReason: "existing_reward_funding_credit" });
  });

  test("operator identity is required; no amount override and no payout-eligibility bypass", async () => {
    const { db, l, sol } = await gapScenario();
    await expect(recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "" })).rejects.toThrow(RecoveryError);
    for (const field of [{ amount: "999999999" }, { payoutEligible: true }, { collectionKey: "x" }, { status: "linked" }, { correlationMethod: "memo" }]) {
      const r = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "op", ...(field as any) });
      expect(r.outcome).toBe("rejected");
      expect(r.failureReason).toContain("override_fields_not_allowed");
    }
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    expect((await attrs(db, { key: sol.key }))[0].recovery).toBeNull();
  });

  test("approval is not verification: a recovered leg above the expected allocation is linked but never payable", async () => {
    const { db, l, sol, tok } = await gapScenario({ sol: half(Q) + 1n });
    const r = await recoverAttribution(deps(db, l), { attributionKey: sol.key, operator: "op" });
    expect(r).toMatchObject({ outcome: "linked_not_payable", payoutEligible: false });
    const c: any = await db.RewardFunding.findOne({ key: sol.key }).lean();
    expect([c.payoutEligible, big(c.creditableAmount), big(c.excessAmount)]).toEqual([false, 0n, 1n]); // only the portion above the harvest's 50 % is excess
    expect((await recoverAttribution(deps(db, l), { attributionKey: tok.key, operator: "op" })).outcome).toBe("linked"); // the exact token leg verifies on its own
  });

  test("disabled by default; only unresolved Forge attributions are eligible", async () => {
    const { db, l, sol } = await gapScenario();
    expect(await recoverAttribution(deps(db, l, { enabled: false }), { attributionKey: sol.key, operator: "op" })).toMatchObject({ outcome: "rejected", failureReason: expect.stringContaining("recovery_disabled") });
    expect(await recoverAttribution(deps(db, l), { attributionKey: "missing", operator: "op" })).toMatchObject({ outcome: "rejected", failureReason: "unknown_attribution" });
    expect(await db.AttributionRecovery.countDocuments({ outcome: "rejected" })).toBe(2);
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    // A linked (normally attributed) row is never "recovered".
    const db2 = await freshDb();
    const l2 = await fixtureLaunch();
    await markCovered(db2, l2, ACT + 1_000);
    await ingest(db2, l2.p, harvestTx(l2, { slot: ACT + 5, quote: Q, token: TK }));
    await ingest(db2, l2.p, payoutTx(l2, { slot: ACT + 7, ...forgeSplit(Q, TK) }));
    const linked = (await attrs(db2))[0];
    expect(linked.status).toBe("linked");
    expect((await recoverAttribution(deps(db2, l2), { attributionKey: linked.key, operator: "op" })).failureReason).toContain("not_unresolved");
  });
});
