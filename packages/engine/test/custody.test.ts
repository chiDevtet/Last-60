/**
 * Physical custody of credited contributions (docs/REWARD_FUNDING.md §14). A custody transfer moves an
 * EXISTING contribution into the dedicated payout wallet; it is never a second contribution, never
 * credits more than the outstanding amount, and counts for rounds only once verified and finalized.
 * All transactions are synthetic (the real LaunchLab → CPMM fixture launch); no mainnet transaction.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import bs58 from "bs58";
import { big } from "../src/db/decimal";
import type { Models } from "../src/db/models";
import { WSOL_MINT } from "../src/accounting/revenueStreams";
import { SYSTEM_PROGRAM_ID } from "../src/revenue/decode";
import { reconcileFunding } from "../src/revenue/ingest";
import { bindCustodyTransfer, claimTransferUse, createCustodyRequest, custodyCoverage, custodyRequirement, refreshCustodyFinality, submitCustodySignature, transferKeyOf, verifyCustodyTransfer } from "../src/custody/custody";
import { buildFundingPipeline } from "../src/custody/report";
import { addr, buildTx, memo, opaque, sig, splTransfer, systemTransfer, MEMO, type Ix } from "./revenueTx";
import { freshDb, startDb, stopDb } from "./harness";
import { ACT, bondingClaimIx, CREATOR, DEST, ingest, launchRef, providerOf, runtime } from "./revenueLaunch";
import { fixtureLaunch, forgeSplit, harvestTx, markCovered, payoutTx } from "./forgeFlow";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const Q = 1_000_001n; // harvested WSOL leg → Forge pays the creator ⌊Q/2⌋ = 500 000 lamports
const TK = 77_000_003n;
const SOL_CREDIT = 500_000n;
const PAYOUT = addr(); // the dedicated payout wallet (throwaway address)
const CFG = { enabled: true, payoutWallet: PAYOUT };
const rt = (o: Record<string, unknown> = {}) => runtime({ fundingDestinations: [DEST, PAYOUT], custody: CFG, ...o });
const finalRpc = (state: "finalized" | "confirmed" | null, err: unknown = null) => ({ getSignatureStatuses: async (sigs: string[]) => sigs.map(() => (state ? ({ slot: ACT + 500, confirmations: null, err, confirmationStatus: state } as any) : null)) });

/** A Forge harvest + Forge's 50 % creator payout → one payable SOL credit custodied by the creator. */
async function forgeCredit() {
  const db = await freshDb();
  const l = await fixtureLaunch();
  await markCovered(db, l, ACT + 10_000);
  const r = rt();
  await ingest(db, l.p, harvestTx(l, { slot: ACT + 5, quote: Q, token: TK }), r);
  await ingest(db, l.p, payoutTx(l, { slot: ACT + 7, ...forgeSplit(Q, TK) }), r);
  const credit: any = await db.RewardFunding.findOne({ fundingMint: WSOL_MINT }).lean();
  return { db, l, r, credit };
}
const sweep = (o: { from?: string; to?: string; lamports: bigint; slot?: number; memoText?: string | null; err?: unknown; extra?: Ix[]; signature?: string }) =>
  buildTx({ signature: o.signature, slot: o.slot ?? ACT + 20, feePayer: o.from ?? CREATOR, err: o.err, ixs: [systemTransfer(o.from ?? CREATOR, o.to ?? PAYOUT, o.lamports), ...(o.memoText ? [memo(o.memoText)] : []), ...(o.extra ?? [])] });
const counts = async (db: Models) => ({ credits: await db.RewardFunding.countDocuments(), inflows: await db.RevenueEvent.countDocuments({ kind: "funding_inflow" }) });
const bind = (db: Models, custodyId: string, tx: ReturnType<typeof sweep>, o: { commitment?: "confirmed" | "finalized"; requireMemo?: boolean } = {}) =>
  bindCustodyTransfer(db, { custodyId, tx, commitment: o.commitment ?? "finalized", method: o.requireMemo === false ? "operator_signature" : "memo_observed", actor: "test", payoutWallet: PAYOUT, requireMemo: o.requireMemo ?? true });
/** A json-encoded getTransaction result for a creator → payout System transfer (operator-signature path). */
function rawTransfer(o: { signature: string; slot: number; from: string; to: string; lamports: bigint; memoText?: string; err?: unknown }) {
  const t = systemTransfer(o.from, o.to, o.lamports);
  const instructions = [{ programIdIndex: 2, accounts: [0, 1], data: bs58.encode(t.data) }, ...(o.memoText ? [{ programIdIndex: 3, accounts: [], data: bs58.encode(Buffer.from(o.memoText)) }] : [])];
  return { slot: o.slot, blockTime: 1_790_000_000, transaction: { signatures: [o.signature], message: { accountKeys: [o.from, o.to, SYSTEM_PROGRAM_ID, MEMO], header: { numRequiredSignatures: 1 }, instructions } }, meta: { err: o.err ?? null, fee: 5000, innerInstructions: [], preTokenBalances: [], postTokenBalances: [], preBalances: [], postBalances: [] } };
}

describe("custody requests", () => {
  test("a request names ONE contribution; amount, source and destination come from the record; duplicates and concurrent requests are refused", async () => {
    const { db, credit } = await forgeCredit();
    expect(custodyRequirement(credit, PAYOUT)).toMatchObject({ mode: "transfer", custodian: CREATOR, required: SOL_CREDIT });
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    expect(req).toMatchObject({ fundingKey: credit.key, sourceWallet: CREATOR, destinationWallet: PAYOUT, mint: WSOL_MINT, status: "requested" });
    expect(big(req.expectedAmount)).toBe(SOL_CREDIT);
    expect(req.memo).toBe(`last60:custody:v1:${req.custodyId}`);
    expect(req.instructions.text).toContain(`${SOL_CREDIT} lamports`);
    await expect(createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" })).rejects.toThrow(/open custody request already exists/);
    const db2 = (await forgeCredit()).db;
    const c2: any = await db2.RewardFunding.findOne({ fundingMint: WSOL_MINT }).lean();
    const out = await Promise.allSettled(Array.from({ length: 6 }, () => createCustodyRequest(db2, CFG, { fundingKey: c2.key, actor: "op" })));
    expect(out.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(await db2.CustodyTransfer.countDocuments({ status: "requested" })).toBe(1);
  });

  test("disabled by default, refused for non-SOL, unknown, direct or consumed contributions", async () => {
    const { db, credit } = await forgeCredit();
    await expect(createCustodyRequest(db, { enabled: false, payoutWallet: PAYOUT }, { fundingKey: credit.key, actor: "op" })).rejects.toThrow(/disabled/);
    await expect(createCustodyRequest(db, CFG, { fundingKey: "nope", actor: "op" })).rejects.toThrow(/unknown_contribution/);
    const tokenCredit: any = await db.RewardFunding.findOne({ fundingMint: { $ne: WSOL_MINT } }).lean();
    await expect(createCustodyRequest(db, CFG, { fundingKey: tokenCredit.key, actor: "op" })).rejects.toThrow(/custody_only_for_native_sol/);
    await db.RewardFunding.updateOne({ key: credit.key }, { $set: { roundNumber: 9 } });
    await expect(createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" })).rejects.toThrow(/already_consumed/);
  });
});

describe("custody transfers", () => {
  test("correct creator → payout transfer (memo, indexer path): bound, finalized, reconciled — and NOT a second reward-funding credit", async () => {
    const { db, l, r, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const before = await counts(db);
    const tx = sweep({ lamports: SOL_CREDIT, memoText: req.memo });
    await ingest(db, l.p, tx, r); // the indexer watches the payout wallet; the memo names the request
    let row: any = await db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean();
    expect(row).toMatchObject({ status: "awaiting_finality", confirmationStatus: "confirmed", method: "memo_observed", signature: tx.signature, transferKey: transferKeyOf(tx.signature, 0), reconciliation: "matched" });
    expect((await custodyCoverage(db, [credit], PAYOUT)).get(credit.key)).toMatchObject({ satisfied: false }); // not finalized → not liquidity
    expect(await refreshCustodyFinality(db, finalRpc("confirmed"))).toMatchObject({ finalized: 0 });
    expect(await refreshCustodyFinality(db, finalRpc("finalized"))).toMatchObject({ finalized: 1 });
    row = await db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean();
    expect(row).toMatchObject({ status: "reconciled", confirmationStatus: "finalized", fundingKey: credit.key, sourceWallet: CREATOR, destinationWallet: PAYOUT, mint: WSOL_MINT });
    expect([big(row.expectedAmount), big(row.observedAmount), big(row.creditedAmount), big(row.excessAmount)]).toEqual([SOL_CREDIT, SOL_CREDIT, SOL_CREDIT, 0n]);
    expect((await custodyCoverage(db, [credit], PAYOUT)).get(credit.key)).toMatchObject({ satisfied: true, custodied: SOL_CREDIT, signatures: [tx.signature] });
    expect(await counts(db)).toEqual(before); // no credit, no funding inflow from the sweep
    expect(await db.TransferUse.findOne({ key: transferKeyOf(tx.signature, 0) }).lean()).toMatchObject({ use: "custody_transfer", ref: req.custodyId });
    expect(row.history.map((h: any) => h.event)).toEqual(["requested", "bound_awaiting_finality", "finalized"]);
    // Re-indexing the same transaction: idempotent, nothing changes.
    await ingest(db, l.p, tx, r);
    await reconcileFunding(db, { ...launchRef(l.p) }, r);
    expect(await counts(db)).toEqual(before);
    expect(await db.CustodyTransfer.countDocuments({ signature: tx.signature })).toBe(1);
    // Immutable request facts.
    await expect(db.CustodyTransfer.updateOne({ custodyId: req.custodyId }, { $set: { expectedAmount: 1 } }).exec()).rejects.toThrow(/immutable/);
    await expect(db.TransferUse.updateOne({}, { $set: { use: "reward_funding" } }).exec()).rejects.toThrow(/append-only/);
  });

  test("operator-signature path: verified from the chain (finalized → reconciled; confirmed → awaiting finality; unknown → rejected)", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const s1 = sig();
    const missing = await submitCustodySignature(db, { getTransactionRaw: async () => null }, CFG, { custodyId: req.custodyId, signature: s1, actor: "op" });
    expect(missing).toMatchObject({ accepted: false, reason: "transaction_not_found_or_not_confirmed" });
    const raw = rawTransfer({ signature: s1, slot: ACT + 30, from: CREATOR, to: PAYOUT, lamports: SOL_CREDIT }); // no memo needed on this path
    const confirmedOnly = { getTransactionRaw: async (_s: string, c?: string) => (c === "confirmed" ? raw : null) };
    expect(await submitCustodySignature(db, confirmedOnly, CFG, { custodyId: req.custodyId, signature: s1, actor: "op" })).toMatchObject({ accepted: true, status: "awaiting_finality" });
    const db2 = (await forgeCredit()).db;
    const c2: any = await db2.RewardFunding.findOne({ fundingMint: WSOL_MINT }).lean();
    const req2 = await createCustodyRequest(db2, CFG, { fundingKey: c2.key, actor: "op" });
    const ok = await submitCustodySignature(db2, { getTransactionRaw: async () => raw }, CFG, { custodyId: req2.custodyId, signature: s1, actor: "op" });
    expect(ok).toMatchObject({ accepted: true, status: "reconciled", credited: SOL_CREDIT });
    expect(await db2.CustodyTransfer.findOne({ custodyId: req2.custodyId }).lean()).toMatchObject({ method: "operator_signature", confirmationStatus: "finalized" });
    await expect(submitCustodySignature(db2, { getTransactionRaw: async () => raw }, { enabled: false, payoutWallet: PAYOUT }, { custodyId: req2.custodyId, signature: s1, actor: "op" })).rejects.toThrow(/disabled/);
  });

  test("duplicate transaction signature: one transfer can never be bound twice or to two requests", async () => {
    const { db, l, r, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const part = sweep({ lamports: 200_000n }); // operator path: no memo, so only the transfer reservation can stop reuse
    expect(await bind(db, req.custodyId, part, { requireMemo: false })).toMatchObject({ accepted: true, status: "partial", credited: 200_000n });
    expect(await bind(db, req.custodyId, part, { requireMemo: false })).toMatchObject({ accepted: true, duplicate: true }); // retry of the same submission
    const req2 = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    expect(big(req2.expectedAmount)).toBe(300_000n);
    const again = await bind(db, req2.custodyId, part, { requireMemo: false });
    expect(again.accepted).toBe(false);
    expect((again as any).reason).toContain("transfer_already_used");
    await ingest(db, l.p, part, r);
    expect(await db.CustodyTransfer.countDocuments({ signature: part.signature })).toBe(1);
  });

  test("partial transfer: credited as observed, the round keeps waiting; the remainder completes custody", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    expect(await bind(db, req.custodyId, sweep({ lamports: 200_000n, memoText: req.memo }))).toMatchObject({ accepted: true, status: "partial", credited: 200_000n, excess: 0n });
    expect((await custodyCoverage(db, [credit], PAYOUT)).get(credit.key)).toMatchObject({ satisfied: false, custodied: 200_000n });
    const p1 = await buildFundingPipeline(db, { payoutWallet: PAYOUT, balance: 200_000n, reserveLamports: 0n });
    expect(p1.custody).toMatchObject({ verifiedReceivedByPayoutWallet: "200000", attributedAwaitingCustody: "300000", outstanding: "300000" });
    const req2 = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    expect(await bind(db, req2.custodyId, sweep({ lamports: 300_000n, memoText: req2.memo, slot: ACT + 25 }))).toMatchObject({ accepted: true, status: "reconciled", credited: 300_000n });
    expect((await custodyCoverage(db, [credit], PAYOUT)).get(credit.key)).toMatchObject({ satisfied: true, custodied: SOL_CREDIT });
    await expect(createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" })).rejects.toThrow(/fully_custodied/);
  });

  test("a transfer exceeding the outstanding contribution: only the outstanding amount is credited, the excess is recorded", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    expect(await bind(db, req.custodyId, sweep({ lamports: 900_000n, memoText: req.memo }))).toMatchObject({ accepted: true, status: "reconciled", credited: SOL_CREDIT, excess: 400_000n });
    expect(await db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean()).toMatchObject({ reconciliation: "excess" });
    const p = await buildFundingPipeline(db, { payoutWallet: PAYOUT, balance: 900_000n, reserveLamports: 0n });
    expect(p.liquidity).toMatchObject({ custodiedUnconsumed: "500000", unattributedSurplus: "400000", mismatch: false });
  });

  test("incorrect source, destination, mint and amount are rejected; the request stays open and the rejection is audited", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const reason = async (tx: ReturnType<typeof sweep>, requireMemo = true) => {
      const r = await bind(db, req.custodyId, tx, { requireMemo });
      expect(r.accepted).toBe(false);
      return (r as any).reason as string;
    };
    expect(await reason(sweep({ from: addr(), lamports: SOL_CREDIT, memoText: req.memo }))).toContain("incorrect_source_wallet");
    expect(await reason(sweep({ to: addr(), lamports: SOL_CREDIT, memoText: req.memo }))).toContain("incorrect_destination_wallet");
    const wsolAta = addr();
    const spl = buildTx({ slot: ACT + 20, feePayer: CREATOR, ixs: [splTransfer(addr(), wsolAta, CREATOR, SOL_CREDIT), memo(req.memo)], tokens: { [wsolAta]: { owner: PAYOUT, mint: WSOL_MINT } } });
    const m = await reason(spl);
    expect(m).toContain("incorrect_mint");
    expect(m).toContain("custody_transaction_not_transfer_only");
    expect(await reason(sweep({ lamports: 0n, memoText: req.memo }))).toContain("no_native_sol_transfer_to_payout_wallet"); // zero amount
    expect(await reason(sweep({ lamports: SOL_CREDIT, memoText: "last60:custody:v1:ct_AAAAAAAAAAAAAAAAAAAAAA" }))).toContain("memo_names_another_custody_request");
    expect(await reason(sweep({ lamports: SOL_CREDIT }))).toContain("custody_memo_missing"); // indexer path requires the memo
    expect(await reason(sweep({ lamports: SOL_CREDIT, slot: ACT + 7, memoText: req.memo }))).toContain("transfer_not_after_contribution");
    expect(await reason(sweep({ lamports: SOL_CREDIT, memoText: req.memo, extra: [opaque(addr(), [], Buffer.from([1]))] }))).toContain("custody_transaction_not_transfer_only");
    expect(await reason(sweep({ lamports: SOL_CREDIT, memoText: req.memo, extra: [systemTransfer(CREATOR, PAYOUT, 5n)] }))).toContain("multiple_transfers");
    const row: any = await db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean();
    expect(row.status).toBe("requested");
    expect(row.history.filter((h: any) => h.event === "submission_rejected").length).toBe(9);
    expect(await db.TransferUse.countDocuments()).toBe(2); // only the two credits' contribution transfers
  });

  test("an unrelated creator deposit into the payout wallet is never treated as custody or as a contribution", async () => {
    const { db, l, r, credit } = await forgeCredit();
    const before = await counts(db);
    await ingest(db, l.p, sweep({ lamports: SOL_CREDIT }), r); // no request, no memo
    await ingest(db, l.p, sweep({ lamports: SOL_CREDIT, slot: ACT + 21, memoText: "last60:custody:v1:ct_BBBBBBBBBBBBBBBBBBBBBB" }), r); // memo naming no request
    expect(await db.CustodyTransfer.countDocuments()).toBe(0);
    expect((await counts(db)).credits).toBe(before.credits);
    expect((await custodyCoverage(db, [credit], PAYOUT)).get(credit.key)).toMatchObject({ satisfied: false, reason: "awaiting_custody_transfer" });
    const p = await buildFundingPipeline(db, { payoutWallet: PAYOUT, balance: 2n * SOL_CREDIT, reserveLamports: 0n });
    expect(p.custody.verifiedReceivedByPayoutWallet).toBe("0"); // a balance increase is never evidence
    expect(p.custody.attributedAwaitingCustody).toBe(String(SOL_CREDIT));
  });

  test("transaction failure and non-finalized transfers never make funds available; the outstanding amount is restored", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    expect(await bind(db, req.custodyId, sweep({ lamports: SOL_CREDIT, memoText: req.memo, err: { InstructionError: [0, "Custom"] } }))).toMatchObject({ accepted: false, reason: "transaction_failed" });
    expect(await bind(db, req.custodyId, sweep({ lamports: SOL_CREDIT, memoText: req.memo }), { commitment: "confirmed" })).toMatchObject({ accepted: true, status: "awaiting_finality" });
    expect((await custodyCoverage(db, [credit], PAYOUT)).get(credit.key)!.satisfied).toBe(false);
    expect(await refreshCustodyFinality(db, finalRpc("finalized", { InstructionError: [0, "x"] }))).toMatchObject({ failed: 1 });
    expect(await db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean()).toMatchObject({ status: "failed", confirmationStatus: "failed" });
    const req2 = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    expect(big(req2.expectedAmount)).toBe(SOL_CREDIT); // the failed transfer credited nothing
    expect(await bind(db, req2.custodyId, sweep({ lamports: SOL_CREDIT, memoText: req2.memo, slot: ACT + 40 }), { commitment: "confirmed" })).toMatchObject({ accepted: true });
    expect(await refreshCustodyFinality(db, finalRpc(null), Date.now() + 60_000)).toMatchObject({ failed: 0 }); // unknown, recent: keep waiting
    expect(await refreshCustodyFinality(db, finalRpc(null), Date.now() + 3_600_000)).toMatchObject({ failed: 1 }); // never finalized → dropped
    expect((await custodyCoverage(db, [credit], PAYOUT)).get(credit.key)!.satisfied).toBe(false);
  });

  test("network fees are never counted: the credited amount is the transfer's lamports; the fee is recorded separately", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const tx = { ...sweep({ lamports: SOL_CREDIT, memoText: req.memo }), fee: 15_000n };
    await bind(db, req.custodyId, tx);
    const row: any = await db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean();
    expect([big(row.observedAmount), big(row.creditedAmount), big(row.networkFeeLamports), row.feePayer]).toEqual([SOL_CREDIT, SOL_CREDIT, 15_000n, CREATOR]);
  });

  test("concurrent sweep attempts against one request: exactly one transfer is bound", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const txs = Array.from({ length: 5 }, (_, i) => sweep({ lamports: SOL_CREDIT, memoText: req.memo, slot: ACT + 30 + i }));
    const out = await Promise.all(txs.map((t) => bind(db, req.custodyId, t)));
    expect(out.filter((x) => x.accepted).length).toBe(1);
    expect(await db.TransferUse.countDocuments({ use: "custody_transfer" })).toBe(1);
    expect((await custodyCoverage(db, [credit], PAYOUT)).get(credit.key)).toMatchObject({ satisfied: true, custodied: SOL_CREDIT });
  });

  test("retry after partial processing: a reservation left by a crash is re-entered by the same request, never by another use", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const tx = sweep({ lamports: SOL_CREDIT, memoText: req.memo });
    // Crash after the reservation, before the request was updated (outside a transaction).
    await claimTransferUse(db, { key: transferKeyOf(tx.signature, 0), use: "custody_transfer", ref: req.custodyId, signature: tx.signature, ordinal: 0 });
    expect(await claimTransferUse(db, { key: transferKeyOf(tx.signature, 0), use: "reward_funding", ref: "x", signature: tx.signature, ordinal: 0 })).toMatchObject({ ok: false });
    expect(await bind(db, req.custodyId, tx)).toMatchObject({ accepted: true, status: "reconciled" });
  });

  test("an expired or cancelled request can no longer bind a transfer", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, { ...CFG, requestTtlMs: 1 }, { fundingKey: credit.key, actor: "op", now: Date.now() - 10_000 });
    expect(await bind(db, req.custodyId, sweep({ lamports: SOL_CREDIT, memoText: req.memo }))).toMatchObject({ accepted: false, reason: "request_expired" });
    const req2 = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const { cancelCustodyRequest } = await import("../src/custody/custody");
    await cancelCustodyRequest(db, { custodyId: req2.custodyId, actor: "op", reason: "creator unreachable" });
    expect((await bind(db, req2.custodyId, sweep({ lamports: SOL_CREDIT, memoText: req2.memo })) as any).reason).toContain("request_not_open");
  });
});

describe("bonding-curve funding (75 %)", () => {
  const GROSS = 1_000_000n;
  const EXPECTED = 750_000n; // 75 % of the COLLECTED creator fee; 25 % stays with the creator
  async function bonding() {
    const db = await freshDb();
    const p = await providerOf();
    return { db, p };
  }

  test("75 % straight into the payout wallet (same transaction): one credit, custody proven by the transfer itself (no sweep)", async () => {
    const { db, p } = await bonding();
    const claim = bondingClaimIx(p, GROSS);
    await ingest(db, p, buildTx({ slot: ACT + 5, feePayer: CREATOR, ixs: [claim.ix, systemTransfer(CREATOR, PAYOUT, EXPECTED)], tokens: claim.tokens }), rt());
    const cs: any[] = await db.RewardFunding.find({}).lean();
    expect(cs.map((c) => [c.stream, c.correlationMethod, c.destinationWallet, big(c.expectedAllocation), big(c.creditableAmount), c.payoutEligible])).toEqual([["bonding_curve_last60_reward_contribution", "same_transaction", PAYOUT, EXPECTED, EXPECTED, true]]);
    const rec: any = await db.RevenueReconciliation.findOne({}).lean();
    expect([big(rec.gross), big(rec.expectedLast60), big(rec.expectedRetained), rec.status]).toEqual([GROSS, EXPECTED, GROSS - EXPECTED, "reconciled"]); // the 25 % creator revenue is excluded
    expect(custodyRequirement(cs[0], PAYOUT).mode).toBe("direct");
    expect((await custodyCoverage(db, cs, PAYOUT)).get(cs[0].key)).toMatchObject({ satisfied: true, mode: "direct" });
    await expect(createCustodyRequest(db, CFG, { fundingKey: cs[0].key, actor: "op" })).rejects.toThrow(/transferred directly into the payout wallet/);
  });

  test("the 25 % creator revenue is never credited: a transfer of the whole fee credits only 75 %, the rest is excess", async () => {
    const { db, p } = await bonding();
    const claim = bondingClaimIx(p, GROSS);
    await ingest(db, p, buildTx({ slot: ACT + 5, feePayer: CREATOR, ixs: [claim.ix, systemTransfer(CREATOR, PAYOUT, GROSS)], tokens: claim.tokens }), rt());
    const c: any = await db.RewardFunding.findOne({}).lean();
    expect([big(c.observedAmount), big(c.creditableAmount), big(c.excessAmount)]).toEqual([GROSS, EXPECTED, GROSS - EXPECTED]);
  });

  test("creator-mediated: the creator claims first, then sends 75 % with a last60:v1 memo into the payout wallet — direct custody, one credit", async () => {
    const { db, p } = await bonding();
    const claim = bondingClaimIx(p, GROSS);
    const ctx = buildTx({ slot: ACT + 5, feePayer: CREATOR, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, ctx, rt());
    await ingest(db, p, buildTx({ slot: ACT + 9, feePayer: CREATOR, ixs: [memo(`last60:v1:${ctx.signature}`), systemTransfer(CREATOR, PAYOUT, EXPECTED)] }), rt());
    const cs: any[] = await db.RewardFunding.find({}).lean();
    expect(cs.map((c) => [c.correlationMethod, c.destinationWallet, big(c.creditableAmount), c.payoutEligible])).toEqual([["memo", PAYOUT, EXPECTED, true]]);
    expect((await custodyCoverage(db, cs, PAYOUT)).get(cs[0].key)!.mode).toBe("direct");
  });

  test("contribution received at an intermediate funding destination: custody transfer required; the sweep never creates a second credit", async () => {
    const { db, p } = await bonding();
    const claim = bondingClaimIx(p, GROSS);
    await ingest(db, p, buildTx({ slot: ACT + 5, feePayer: CREATOR, ixs: [claim.ix, systemTransfer(CREATOR, DEST, EXPECTED)], tokens: claim.tokens }), rt());
    const credit: any = await db.RewardFunding.findOne({}).lean();
    expect(custodyRequirement(credit, PAYOUT)).toMatchObject({ mode: "transfer", custodian: DEST });
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    const before = await counts(db);
    const tx = sweep({ from: DEST, lamports: EXPECTED, memoText: req.memo });
    await ingest(db, p, tx, rt());
    expect(await counts(db)).toEqual(before);
    expect(await db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean()).toMatchObject({ status: "awaiting_finality", sourceWallet: DEST });
    // Also without a memo (operator path): DEST → PAYOUT is not a contribution (source is a destination).
    await ingest(db, p, sweep({ from: DEST, lamports: 1n, slot: ACT + 30 }), rt({ correlationMode: "exclusive_window" }));
    expect(await counts(db)).toEqual(before);
  });

  test("a creator transfer already credited as a contribution can never be re-used as custody (and vice versa)", async () => {
    // Forge-route credit custodied by the creator + a bonding claim of the same creator.
    const { db, l, credit } = await forgeCredit();
    const claim = bondingClaimIx(l.p, GROSS);
    await ingest(db, l.p, buildTx({ slot: ACT + 12, feePayer: CREATOR, ixs: [claim.ix], tokens: claim.tokens }), rt());
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    // (a) custody first (operator path, no memo), then reconciliation in exclusive_window mode: no credit.
    const tx = sweep({ lamports: SOL_CREDIT, slot: ACT + 20 });
    expect(await bind(db, req.custodyId, tx, { requireMemo: false })).toMatchObject({ accepted: true });
    const n = (await counts(db)).credits;
    await ingest(db, l.p, tx, rt({ correlationMode: "exclusive_window" }));
    expect((await counts(db)).credits).toBe(n); // the inflow is unlinked/refused: the transfer is custody
    // (b) a transfer credited first as a (non-payable, positional) contribution cannot become custody.
    const { db: db2, l: l2, credit: c2 } = await forgeCredit();
    const claim2 = bondingClaimIx(l2.p, GROSS);
    await ingest(db2, l2.p, buildTx({ slot: ACT + 12, feePayer: CREATOR, ixs: [claim2.ix], tokens: claim2.tokens }), rt());
    const tx2 = sweep({ lamports: SOL_CREDIT, slot: ACT + 20 });
    await ingest(db2, l2.p, tx2, rt({ correlationMode: "exclusive_window" }));
    expect(await db2.RewardFunding.countDocuments({ signature: tx2.signature })).toBe(1);
    const req2 = await createCustodyRequest(db2, CFG, { fundingKey: c2.key, actor: "op" });
    const r2 = await bind(db2, req2.custodyId, tx2, { requireMemo: false });
    expect(r2.accepted).toBe(false);
    expect((r2 as any).reason).toMatch(/transfer_already_(credited_as_contribution|used)/);
  });

  test("incorrect or incomplete funding stays ineligible: unlinked transfer → no credit; partial → only what was observed; unverified claim → never payable", async () => {
    const { db, p } = await bonding();
    const claim = bondingClaimIx(p, GROSS);
    const ctx = buildTx({ slot: ACT + 5, feePayer: CREATOR, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, ctx, rt());
    await ingest(db, p, buildTx({ slot: ACT + 9, feePayer: CREATOR, ixs: [systemTransfer(CREATOR, PAYOUT, EXPECTED)] }), rt()); // no memo
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    await ingest(db, p, buildTx({ slot: ACT + 11, feePayer: CREATOR, ixs: [memo(`last60:v1:${ctx.signature}`), systemTransfer(CREATOR, PAYOUT, 500_000n)] }), rt());
    const c: any = await db.RewardFunding.findOne({}).lean();
    expect(big(c.creditableAmount)).toBe(500_000n);
    expect((await db.RevenueReconciliation.findOne({}).lean() as any).status).toBe("partial");
    const db2 = await freshDb();
    const unverified = await providerOf({ verified: false });
    const claim2 = bondingClaimIx(unverified, GROSS);
    await ingest(db2, unverified, buildTx({ slot: ACT + 5, feePayer: CREATOR, ixs: [claim2.ix, systemTransfer(CREATOR, PAYOUT, EXPECTED)], tokens: claim2.tokens }), rt());
    const c2: any = await db2.RewardFunding.findOne({}).lean();
    expect(c2.payoutEligible).toBe(false);
    expect(custodyRequirement(c2, PAYOUT).mode).toBe("not_applicable");
  });
});

describe("liquidity reconciliation", () => {
  test("custodied contributions missing from the wallet are reported as a mismatch; an accounting credit is never liquidity", async () => {
    const { db, credit } = await forgeCredit();
    const req = await createCustodyRequest(db, CFG, { fundingKey: credit.key, actor: "op" });
    await bind(db, req.custodyId, sweep({ lamports: SOL_CREDIT, memoText: req.memo }));
    const short = await buildFundingPipeline(db, { payoutWallet: PAYOUT, balance: 100_000n, reserveLamports: 50_000n });
    expect(short.liquidity).toMatchObject({ custodiedUnconsumed: "500000", shortfall: "450000", mismatch: true });
    expect(short.custody.recentTransfers[0]).toMatchObject({ custodyId: req.custodyId, status: "reconciled", credited: "500000" });
    const ok = await buildFundingPipeline(db, { payoutWallet: PAYOUT, balance: 1_000_000n, reserveLamports: 50_000n });
    expect(ok.liquidity).toMatchObject({ mismatch: false, available: "950000", unattributedSurplus: "450000" });
    // The four stages are reported separately.
    expect(ok.attribution.payableSolAmount).toBe("500000");
    expect(ok.custody.verifiedReceivedByPayoutWallet).toBe("500000");
    expect(ok.rounds.consumedTotal).toBe("0");
    expect(ok.payouts.confirmed).toBe("0");
  });
});

describe("pure verification", () => {
  test("verifyCustodyTransfer never reads balances: only the instruction's lamports from the custodian to the payout wallet", () => {
    const req = { custodyId: "ct_AAAAAAAAAAAAAAAAAAAAAA", sourceWallet: CREATOR, destinationWallet: PAYOUT, mint: WSOL_MINT, contributionSlot: ACT };
    const ok = verifyCustodyTransfer(sweep({ lamports: 42n, memoText: `last60:custody:v1:${req.custodyId}` }), req, { payoutWallet: PAYOUT, requireMemo: true });
    expect(ok).toMatchObject({ ok: true, observed: 42n, memo: "match", ordinal: 0 });
    expect(verifyCustodyTransfer(sweep({ lamports: 42n }), req, { payoutWallet: addr(), requireMemo: false }).reasons[0]).toContain("payout_wallet_changed");
    expect(verifyCustodyTransfer(sweep({ lamports: 42n }), { ...req, mint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB" }, { payoutWallet: PAYOUT, requireMemo: false }).reasons).toContain("custody_only_for_native_sol");
  });
});
