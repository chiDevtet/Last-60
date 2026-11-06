/**
 * Post-PR #3 hardening, on a real MongoDB replica set (runs in CI):
 *   - the role / beneficiary / provider guard covers swaps AND non-swap fee attributions (LP
 *     checkpoints, fee collections), legacy rows, and every change path (settings API, indexer
 *     attachment, rewards-worker provider load);
 *   - fee records are immutable (basis, amounts, eligibility);
 *   - only verified, final, snapshot-carrying, creator-allocated amounts are distributable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { dec } from "../src/db/decimal";
import { makeBasis, snapshotOf, type NormalizedAttribution } from "../src/accounting/attribution";
import { MOCK_CREATOR, MOCK_POOL } from "../src/providers/mock/MockProvider";
import { persistAttributions, SNAPSHOT_UNAVAILABLE } from "../src/indexer/ingest";
import { periodFees } from "../src/rewards/selection";
import { Indexer } from "../src/indexer/Indexer";
import { RewardsWorker } from "../src/rewards/RewardsWorker";
import { SettingsValidationError } from "../src/config/runtime";
import { rig, SOL, startDb, stopDb, wallet, type Rig } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const WSOL = "So11111111111111111111111111111111111111112";
const DEST = Keypair.generate().publicKey.toBase58();
const BOND = makeBasis({ provider: "mock", pool: MOCK_POOL, phase: "bonding_curve", role: "creator", beneficiary: MOCK_CREATOR, params: { eligibleFee: "instruction data" }, source: "mock instruction data", verification: "verified", problems: [] });
const LP = makeBasis({ provider: "mock", pool: DEST, phase: "migrated_lp", role: "creator", beneficiary: MOCK_CREATOR, params: { positions: "pos" }, source: "test", verification: "verified", problems: [] });
const COLLECT = makeBasis({ provider: "mock", pool: DEST, phase: "post_migration_trading", role: "creator", beneficiary: MOCK_CREATOR, params: { poolCreator: MOCK_CREATOR }, source: "test", verification: "verified", problems: [] });
const UNDECLARED = makeBasis({ provider: "mock", pool: DEST, phase: "migrated_lp", role: "creator", beneficiary: MOCK_CREATOR, params: { positions: "other" }, source: "test", verification: "not_declared", problems: [] });
const INFO: any = { poolAddress: MOCK_POOL, allocation: BOND, destination: { allocation: COLLECT, lpAllocation: LP } };

function attribution(o: Partial<NormalizedAttribution> & { key: string; slot: number; creatorAmount: bigint }): NormalizedAttribution {
  return { kind: "position_checkpoint", phase: "migrated_lp", provider: "mock", sourcePool: MOCK_POOL, destinationPool: DEST, beneficiary: MOCK_CREATOR, feeMint: WSOL, grossAmount: o.creatorAmount, excludedAmount: 0n, excludedReason: null, signature: null, blockTime: null, evidence: {}, status: "observed", payoutEligible: true, basisId: LP.id, ...o };
}

async function swapRow(r: Rig, o: { sig: string; slot: number; fee: bigint; basis?: any; basisId?: string | null; feeStatus?: string }) {
  await r.db.Swap.create({
    signature: o.sig, eventIndex: 0, provider: "mock", pool: MOCK_POOL, sourcePool: MOCK_POOL, tokenMint: "m", quoteMint: WSOL, side: "buy", trader: wallet(), traderSource: "payer",
    quoteAmount: dec(SOL), baseAmount: dec(1n), totalFee: dec(o.fee * 2n), eligibleFee: dec(o.fee), eligibleFeeMint: WSOL, slot: o.slot, commitment: "finalized", source: "indexer",
    beneficiary: MOCK_CREATOR, basisId: o.basisId === undefined ? BOND.id : o.basisId, basis: o.basis === undefined ? snapshotOf(BOND, MOCK_POOL) : o.basis, ...(o.feeStatus ? { feeStatus: o.feeStatus } : {}),
  });
}

async function roleChange(r: Rig, patch: Record<string, unknown>) {
  const v = (await r.settings.raw()).version;
  try {
    await r.settings.update(patch, { actor: "t", expectedVersion: v });
    return null;
  } catch (e) {
    if (e instanceof SettingsValidationError) return e.problems.join(" ");
    throw e;
  }
}

describe("role-change guard covers every historical fee record, not only swaps", () => {
  test("historical swaps under the creator role block a role change", async () => {
    const r = await rig();
    await swapRow(r, { sig: "s", slot: 5, fee: 1n });
    expect(await roleChange(r, { poolAddress: MOCK_POOL, feeBeneficiaryRole: "partner" })).toContain('attributed under role "creator"');
  });

  test("LP position checkpoints with NO swaps block a role change", async () => {
    const r = await rig();
    await persistAttributions(r.db, [attribution({ key: "cp:1", slot: 9, creatorAmount: 10n })], INFO);
    expect(await r.db.Swap.countDocuments({})).toBe(0);
    expect(await roleChange(r, { poolAddress: MOCK_POOL, feeBeneficiaryRole: "partner" })).toContain("fee_attributions");
  });

  test("fee collections with NO swaps block a role change", async () => {
    const r = await rig();
    await persistAttributions(r.db, [attribution({ key: "creator_fee_collection:sig:2:m", kind: "creator_fee_collection", phase: "post_migration_trading", basisId: COLLECT.id, slot: 9, creatorAmount: 10n, status: "collected" })], INFO);
    expect(await roleChange(r, { poolAddress: MOCK_POOL, feeBeneficiaryRole: "partner" })).toContain('attributed under role "creator"');
  });

  test("legacy records without a basis snapshot block a role change", async () => {
    const r = await rig();
    await r.db.FeeAttribution.collection.insertOne({ key: "legacy", kind: "position_checkpoint", provider: "mock", phase: "migrated_lp", sourcePool: MOCK_POOL, destinationPool: DEST, pool: DEST, beneficiary: MOCK_CREATOR, feeMint: WSOL, creatorAmount: dec(1n), excludedAmount: dec(0n), slot: 3, status: "observed", payoutEligible: true, basisId: "unknown" });
    expect(await roleChange(r, { poolAddress: MOCK_POOL, feeBeneficiaryRole: "partner" })).toContain("legacy");
  });

  test("a genuinely new pool accepts a role change", async () => {
    const r = await rig();
    await swapRow(r, { sig: "s", slot: 5, fee: 1n }); // history on ANOTHER pool
    const fresh = Keypair.generate().publicKey.toBase58();
    expect(await roleChange(r, { poolAddress: fresh, feeBeneficiaryRole: "partner" })).toBeNull();
  });

  test("worker attachment (indexer AND rewards worker) refuses a conflicting beneficiary wallet", async () => {
    const r = await rig();
    const other = wallet();
    await persistAttributions(r.db, [attribution({ key: "cp:x", slot: 4, creatorAmount: 5n })], INFO);
    await r.db.FeeAttribution.collection.updateOne({ key: "cp:x" }, { $set: { beneficiary: other, "basis.beneficiary": other } });
    const idx = new Indexer({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, wsFactory: null });
    await expect(idx.init()).rejects.toThrow(/beneficiary/);
    const w = new RewardsWorker({ db: r.db, cfg: r.cfg, settings: r.settings, payer: r.payer, claimer: null, rpc: r.chain, clock: r.clock });
    await expect(w.ensureProvider(await r.settings.get(true))).rejects.toThrow(/beneficiary/);
  });

  test("worker attachment refuses checkpoints recorded under another role; accepts consistent history", async () => {
    const r = await rig();
    await persistAttributions(r.db, [attribution({ key: "cp:ok", slot: 4, creatorAmount: 5n })], INFO);
    const w = new RewardsWorker({ db: r.db, cfg: r.cfg, settings: r.settings, payer: r.payer, claimer: null, rpc: r.chain, clock: r.clock });
    await w.ensureProvider(await r.settings.get(true)); // creator role, same beneficiary: allowed
    await r.db.FeeAttribution.collection.updateOne({ key: "cp:ok" }, { $set: { "basis.role": "partner" } });
    const idx = new Indexer({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, wsFactory: null });
    await expect(idx.init()).rejects.toThrow(/attributed under role "partner"/);
  });
});

describe("fee records are immutable", () => {
  test("the basis, amounts and eligibility of swaps and attributions cannot be rewritten", async () => {
    const r = await rig();
    await swapRow(r, { sig: "s", slot: 5, fee: 1n });
    await persistAttributions(r.db, [attribution({ key: "cp:1", slot: 9, creatorAmount: 10n })], INFO);
    await expect(r.db.Swap.updateOne({ signature: "s" }, { $set: { "basis.role": "partner" } })).rejects.toThrow(/immutable/);
    await expect(r.db.Swap.updateMany({}, { $set: { payoutEligible: true, eligibleFee: dec(9n) } })).rejects.toThrow(/immutable/);
    await expect(r.db.FeeAttribution.updateOne({ key: "cp:1" }, { $set: { creatorAmount: dec(99n) } })).rejects.toThrow(/immutable/);
    await expect(r.db.FeeAttribution.updateMany({}, { $unset: { basis: 1 } })).rejects.toThrow(/immutable/);
    // bookkeeping fields stay writable
    await r.db.FeeAttribution.updateMany({ key: "cp:1" }, { $set: { roundNumber: 1 } });
    const a: any = await r.db.FeeAttribution.findOne({ key: "cp:1" }).lean();
    expect(a.roundNumber).toBe(1);
    expect(a.basis).toEqual(snapshotOf(LP, MOCK_POOL));
  });

  test("a record whose basis cannot be resolved is stored but never payable", async () => {
    const r = await rig();
    await persistAttributions(r.db, [attribution({ key: "cp:?", slot: 9, creatorAmount: 10n, basisId: "not-a-basis" })], INFO);
    const a: any = await r.db.FeeAttribution.findOne({ key: "cp:?" }).lean();
    expect(a.basis).toBeNull();
    expect(a.payoutEligible).toBe(false);
    expect(a.excludedReason).toBe(SNAPSHOT_UNAVAILABLE);
  });
});

describe("only verified, final, creator-allocated amounts are distributable", () => {
  const period = { pool: [MOCK_POOL, DEST], afterSlot: 0, periodStartAt: null, snapshotSlot: 100 };
  test("legacy, estimated, unresolved and undeclared amounts are reported but never paid", async () => {
    const r = await rig();
    await swapRow(r, { sig: "ok", slot: 10, fee: 100n });
    await swapRow(r, { sig: "legacy", slot: 11, fee: 7n, basis: null, basisId: null });
    await swapRow(r, { sig: "partial", slot: 12, fee: 3n, basis: { role: "creator" } });
    await swapRow(r, { sig: "est", slot: 13, fee: 11n, feeStatus: "estimated" });
    await persistAttributions(r.db, [
      attribution({ key: "cp:ok", slot: 20, creatorAmount: 50n }),
      attribution({ key: "cp:undeclared", slot: 21, creatorAmount: 40n, basisId: UNDECLARED.id }),
      attribution({ key: "cp:unresolved", slot: 22, creatorAmount: 30n, status: "unresolved" }),
      attribution({ key: "cp:other-mint", slot: 23, creatorAmount: 9n, feeMint: "Base1111111111111111111111111111111111111111" }),
    ], { ...INFO, destination: { allocation: COLLECT, lpAllocation: LP, extra: UNDECLARED } });
    // UNDECLARED is not in INFO's bases → no snapshot → never payable; give it one explicitly:
    await r.db.FeeAttribution.collection.updateOne({ key: "cp:undeclared" }, { $set: { basis: snapshotOf(UNDECLARED, MOCK_POOL), payoutEligible: true, excludedReason: null, status: "observed" } });
    const f = await periodFees(r.db, period, WSOL);
    expect(f.payout).toBe(150n); // 100 (swap) + 50 (checkpoint)
    const reasons = Object.fromEntries(f.ineligible.map((x) => [x.reason, x.amount]));
    expect(reasons).toEqual({ legacy_record_without_allocation_snapshot: 10n, fee_status_estimated: 11n, allocation_not_declared_not_verified: 40n, fee_status_unresolved: 30n });
    expect(f.other).toEqual([{ mint: "Base1111111111111111111111111111111111111111", amount: 9n }]); // never converted into the payout asset
    // the same basis id verified now (e.g. the operator declared the matching value) becomes distributable
    const g = await periodFees(r.db, period, WSOL, { verifiedBasisIds: [UNDECLARED.id] });
    expect(g.payout).toBe(190n);
  });

  test("duplicate ingestion of a collection cannot be counted twice", async () => {
    const r = await rig();
    const a = attribution({ key: "creator_fee_collection:sig:2:m", kind: "creator_fee_collection", phase: "post_migration_trading", basisId: COLLECT.id, slot: 30, creatorAmount: 500n, status: "collected" });
    expect(await persistAttributions(r.db, [a, a], INFO)).toBe(1);
    expect(await persistAttributions(r.db, [{ ...a, creatorAmount: 900n }], INFO)).toBe(0);
    expect((await periodFees(r.db, period, WSOL)).payout).toBe(500n);
  });
});
