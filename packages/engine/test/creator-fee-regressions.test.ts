/**
 * Regressions for the creator-fee accounting round (docs/AUDIT.md U1–U8, migration continuity) on a
 * real MongoDB replica set with the fault-injecting FakeChain. No real keys, no mainnet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { big, dec } from "../src/db/decimal";
import { MOCK_POOL } from "../src/providers/mock/MockProvider";
import { persistAttributions } from "../src/indexer/ingest";
import { periodFees } from "../src/rewards/selection";
import { PayoutExecutor, repairPayoutLedger } from "../src/rewards/payouts";
import { Reconciler } from "../src/rewards/reconciliation";
import { Indexer } from "../src/indexer/Indexer";
import { SettingsValidationError } from "../src/config/runtime";
import { PublicData } from "../src/public/publicData";
import { TerminalWriter } from "../src/terminal/terminal";
import type { NormalizedAttribution } from "../src/accounting/attribution";
import { rig, SOL, startDb, stopDb, T0, wallet, type Rig } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const WSOL = "So11111111111111111111111111111111111111112";
const DEST = Keypair.generate().publicKey.toBase58();

function attribution(o: Partial<NormalizedAttribution> & { key: string; slot: number; creatorAmount: bigint }): NormalizedAttribution {
  return {
    kind: "position_checkpoint",
    phase: "migrated_lp",
    provider: "meteora_dbc",
    sourcePool: MOCK_POOL,
    destinationPool: DEST,
    beneficiary: wallet(),
    feeMint: WSOL,
    grossAmount: o.creatorAmount,
    excludedAmount: 0n,
    excludedReason: null,
    signature: null,
    blockTime: null,
    evidence: {},
    status: "observed",
    payoutEligible: true,
    basisId: "b1",
    ...o,
  };
}

async function swapRow(r: Rig, o: { sig: string; slot: number; pool?: string; fee: bigint; eligible?: boolean | null; trader?: string }) {
  await r.db.Swap.create({
    signature: o.sig, eventIndex: 0, provider: "mock", pool: o.pool ?? MOCK_POOL, tokenMint: "m", quoteMint: WSOL, side: "buy", trader: o.trader ?? wallet(), traderSource: "payer",
    quoteAmount: dec(SOL), baseAmount: dec(1n), totalFee: dec(o.fee * 2n), eligibleFee: dec(o.fee), eligibleFeeMint: WSOL, slot: o.slot, commitment: "finalized", source: "indexer",
    ...(o.eligible === null ? {} : { payoutEligible: o.eligible ?? true, excludedReason: o.eligible === false ? "allocation_mismatch: test" : null }),
    basis: { role: "creator" },
  });
}

describe("migration continuity: bonding curve → verified destination", () => {
  test("consecutive periods split bonding and destination fees by slot with no gap, no overlap, no double count", async () => {
    const r = await rig();
    await swapRow(r, { sig: "s1", slot: 100, fee: 1_000n });
    await swapRow(r, { sig: "s2", slot: 200, fee: 2_000n }); // the final bonding-curve trade
    // the destination's first trades + the creator's LP growth (migration at slot 205)
    await swapRow(r, { sig: "d1", slot: 210, pool: DEST, fee: 0n });
    await persistAttributions(r.db, [attribution({ key: "cp:1", slot: 250, creatorAmount: 700n }), attribution({ key: "cp:2", slot: 300, creatorAmount: 300n })]);
    const pools = [MOCK_POOL, DEST];
    const p1 = await periodFees(r.db, { pool: pools, afterSlot: 0, periodStartAt: null, snapshotSlot: 205 }, WSOL);
    const p2 = await periodFees(r.db, { pool: pools, afterSlot: 205, periodStartAt: null, snapshotSlot: 300 }, WSOL);
    expect(p1.payout).toBe(3_000n);
    expect(p2.payout).toBe(1_000n);
    expect(p1.byPhase).toEqual({ bonding_curve: "3000" });
    expect(p2.byPhase).toEqual({ migrated_lp: "1000" });
    const whole = await periodFees(r.db, { pool: pools, afterSlot: 0, periodStartAt: null, snapshotSlot: 300 }, WSOL);
    expect(whole.payout).toBe(p1.payout + p2.payout);
  });

  test("re-processing is idempotent: attributions and collections are keyed, the first observation wins", async () => {
    const r = await rig();
    const a = attribution({ key: "collect:sig:3:mint", kind: "creator_fee_collection", phase: "post_migration_trading", slot: 400, creatorAmount: 5_000n, status: "collected" });
    expect(await persistAttributions(r.db, [a])).toBe(1);
    expect(await persistAttributions(r.db, [a, { ...a, creatorAmount: 9_999n }])).toBe(0); // duplicate ingestion, even with a different value
    expect(await r.db.FeeAttribution.countDocuments({})).toBe(1);
    expect((await periodFees(r.db, { pool: DEST, afterSlot: 0, periodStartAt: null, snapshotSlot: 500 }, WSOL)).payout).toBe(5_000n);
  });

  test("ineligible (unproven / mismatching) creator allocations are reported but never distributed; gross fees are never used", async () => {
    const r = await rig();
    await swapRow(r, { sig: "ok", slot: 10, fee: 100n });
    await swapRow(r, { sig: "bad", slot: 11, fee: 50n, eligible: false });
    await swapRow(r, { sig: "legacy", slot: 12, fee: 7n, eligible: null }); // written before attribution fields existed
    await persistAttributions(r.db, [attribution({ key: "u1", slot: 13, creatorAmount: 40n, payoutEligible: false, status: "unresolved", excludedReason: "position NFT holder could not be resolved", destinationPool: null })]);
    const f = await periodFees(r.db, { pool: MOCK_POOL, afterSlot: 0, periodStartAt: null, snapshotSlot: 20 }, WSOL);
    expect(f.payout).toBe(107n); // eligibleFee only — never totalFee (which is 2× here)
    expect(f.ineligible.reduce((s, x) => s + x.amount, 0n)).toBe(90n);
    expect(f.ineligible.map((x) => x.reason).sort()).toEqual(["allocation_mismatch: test", "position NFT holder could not be resolved"]);
  });

  test("a round over a migrated launch records the destination checkpoint once, at the snapshot slot, and pays only eligible creator fees", async () => {
    const r = await rig();
    const calls: number[] = [];
    // The provider exposes a verified destination and a checkpointed entitlement.
    const p: any = r.provider;
    const base = p.info.bind(p);
    p.info = () => ({ ...base(), accountingPools: [MOCK_POOL, DEST] });
    p.checkpoint = async (slot: number, previous: (k: string) => Promise<any>) => {
      calls.push(slot);
      const prev = await previous("dammv2:pos:mint");
      const cumulative = 12_345n;
      const delta = cumulative - (prev?.cumulative ?? 0n);
      return delta ? [attribution({ key: `dammv2-cp:pos:${WSOL}:${slot}`, slot, creatorAmount: delta, evidence: { checkpointKey: "dammv2:pos:mint", cumulative: cumulative.toString() } })] : [];
    };
    const buyer = wallet();
    await r.worker.scheduler.tick(r.clock.now());
    r.trade({ trader: buyer, quote: SOL });
    r.chain.advance(2);
    r.clock.set(T0 + 240_000);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(T0 + 240_000 + 30_000);
    await r.worker.scheduler.tick(r.clock.now());
    const round: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(calls).toEqual([round.snapshotSlot]);
    const cp: any = await r.db.FeeAttribution.findOne({ key: `dammv2-cp:pos:${WSOL}:${round.snapshotSlot}` }).lean();
    expect(cp.slot).toBe(round.snapshotSlot);
    expect(cp.roundNumber).toBe(1);
    expect(big(round.fees)).toBe(SOL / 100n + 12_345n); // bonding-curve creator fee + LP growth
    expect(round.feeBreakdown.byPhase).toEqual({ bonding_curve: String(SOL / 100n), migrated_lp: "12345" });
    expect(round.config.pools).toEqual([MOCK_POOL, DEST]);
  });
});

describe("U1 — fee beneficiary role changes", () => {
  test("changing the role on a pool with records attributed under another role is refused", async () => {
    const r = await rig();
    await swapRow(r, { sig: "x", slot: 5, fee: 1n });
    const v = (await r.settings.raw()).version;
    let err: unknown = null;
    try {
      await r.settings.update({ poolAddress: MOCK_POOL, feeBeneficiaryRole: "partner" }, { actor: "t", expectedVersion: v });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SettingsValidationError);
    expect((err as SettingsValidationError).problems.join(" ")).toContain('attributed under role "creator"');
    // Keeping the role (or a pool without records) is fine.
    await r.settings.update({ poolAddress: MOCK_POOL }, { actor: "t", expectedVersion: v });
  });

  test("the indexer refuses to attach when the environment role conflicts with stored records", async () => {
    const r = await rig();
    // Records written while the pool was indexed for the partner; the provider now reports "creator"
    // (e.g. FEE_BENEFICIARY_ROLE changed in the environment, bypassing the settings store).
    await swapRow(r, { sig: "y", slot: 5, fee: 1n });
    await r.db.Swap.updateOne({ signature: "y" }, { $set: { "basis.role": "partner" } });
    const idx = new Indexer({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, wsFactory: null });
    await expect(idx.init()).rejects.toThrow(/already has fee records attributed under role "partner"/);
  });
});

describe("U2 — payout confirmation is atomic and recoverable", () => {
  async function submittedPayout(r: Rig) {
    const sig = r.trade({ trader: wallet(), quote: SOL }); // any landed transaction serves as the "transfer"
    r.chain.advance(100);
    const recipient = wallet();
    const p = await r.db.Payout.create({ roundNumber: 1, recipient, position: 0, amount: dec(5_000_000n), mint: WSOL, mode: "live", state: "submitted", attemptCount: 1, current: { signature: sig, blockhash: "x", lastValidBlockHeight: r.chain.slot + 1000, createdAt: new Date() }, attempts: [{ n: 1, signature: sig, outcome: "in_flight" }] });
    return { p, sig, recipient };
  }
  const executor = (r: Rig) => new PayoutExecutor({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, payer: r.payer, terminal: new TerminalWriter(r.db, 1), clock: r.clock });

  test("a crash between the payout update and the ledger write leaves NOTHING half-done; the retry completes exactly once", async () => {
    const r = await rig();
    const { p, recipient } = await submittedPayout(r);
    const orig = r.db.LedgerEntry.updateOne.bind(r.db.LedgerEntry);
    let fail = true;
    (r.db.LedgerEntry as any).updateOne = (...a: any[]) => {
      if (fail && String(a[0]?.key).startsWith("PAYOUT_CONFIRMED")) {
        fail = false;
        throw new Error("simulated crash");
      }
      return (orig as any)(...a);
    };
    await executor(r).processDue();
    let row: any = await r.db.Payout.findById(p._id).lean();
    expect(row.state).toBe("submitted"); // rolled back with the failed ledger write
    expect(await r.db.LedgerEntry.countDocuments({ key: `PAYOUT_CONFIRMED:${p._id}` })).toBe(0);
    await r.db.Payout.updateOne({ _id: p._id }, { $set: { nextAttemptAt: new Date(0) } });
    await executor(r).processDue();
    await executor(r).processDue();
    row = await r.db.Payout.findById(p._id).lean();
    expect(row.state).toBe("confirmed");
    expect(row.ledgerApplied).toBe(true);
    expect(await r.db.LedgerEntry.countDocuments({ key: `PAYOUT_CONFIRMED:${p._id}` })).toBe(1);
    const stats: any = await r.db.BuyerActivity.findOne({ wallet: recipient }).lean();
    expect(stats.roundsWon).toBe(1);
    expect(big(stats.rewardsReceived)).toBe(5_000_000n);
  });

  test("legacy confirmed payouts without ledger entries are repaired once (idempotent)", async () => {
    const r = await rig();
    const recipient = wallet();
    const legacy = await r.db.Payout.create({ roundNumber: 2, recipient, position: 0, amount: dec(7n), mint: WSOL, mode: "live", state: "confirmed", confirmedSignature: "sigL" });
    await r.db.Payout.collection.updateOne({ _id: legacy._id }, { $unset: { ledgerApplied: 1 } });
    const done = await r.db.Payout.create({ roundNumber: 2, recipient: wallet(), position: 1, amount: dec(9n), mint: WSOL, mode: "live", state: "confirmed", confirmedSignature: "sigD" });
    await r.db.Payout.collection.updateOne({ _id: done._id }, { $unset: { ledgerApplied: 1 } });
    await r.db.LedgerEntry.create({ key: `PAYOUT_CONFIRMED:${done._id}`, type: "PAYOUT_CONFIRMED", roundNumber: 2, amount: dec(9n), mint: WSOL });
    expect(await repairPayoutLedger(r.db)).toEqual({ repaired: 1, marked: 1 });
    expect(await repairPayoutLedger(r.db)).toEqual({ repaired: 0, marked: 0 });
    expect(await r.db.LedgerEntry.countDocuments({ type: "PAYOUT_CONFIRMED" })).toBe(2);
    expect(((await r.db.BuyerActivity.findOne({ wallet: recipient }).lean()) as any).roundsWon).toBe(1);
  });
});

describe("U3 — finality and dropped transactions", () => {
  const indexer = (r: Rig) => new Indexer({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, wsFactory: null });

  test("a lagging RPC node answering null never gets a real transaction dropped", async () => {
    const r = await rig({ env: { INDEXER_DROP_AFTER_SECONDS: "30" } });
    r.chain.finalityLag = 1_000; // the transaction is not finalized yet
    const keep = wallet();
    r.trade({ trader: keep, quote: SOL });
    const idx = indexer(r);
    await idx.init();
    await idx.pollOnce();
    r.chain.advance(400);
    r.chain.statusContextLag = 800; // backend far behind: "unknown" for everything recent
    for (const t of [60_000, 120_000, 180_000]) await idx.finalityPass(Date.now() + t);
    expect(((await r.db.Swap.findOne({ trader: keep }).lean()) as any).status).toBe("active");
  });

  test("dropped rows no longer occupy the oldest-first window: newer swaps are still promoted", async () => {
    const r = await rig();
    const idx = indexer(r);
    await idx.init();
    await r.db.Swap.insertMany(Array.from({ length: 300 }, (_, i) => ({ signature: `old${i}`, eventIndex: 0, provider: "mock", pool: MOCK_POOL, tokenMint: "m", quoteMint: WSOL, side: "buy", trader: wallet(), traderSource: "payer", quoteAmount: dec(1n), baseAmount: dec(1n), totalFee: dec(0n), eligibleFee: dec(0n), eligibleFeeMint: WSOL, slot: i, commitment: "confirmed", status: "dropped", source: "indexer", ingestedAt: new Date(0) })));
    r.trade({ trader: wallet(), quote: SOL });
    await idx.pollOnce();
    r.chain.advance(100);
    await idx.finalityPass(Date.now() + 60_000);
    expect(await r.db.Swap.countDocuments({ status: "active", commitment: "finalized" })).toBe(1);
  });
});

describe("U5 — funds preflight under concurrency", () => {
  test("two workers cannot both rely on the same balance: only what is funded is signed", async () => {
    const r = await rig({ balance: 15_000_000n }); // covers one 10M payout (+fees), not two
    await r.db.Payout.insertMany([0, 1].map((i) => ({ roundNumber: 1, recipient: wallet(), position: i, amount: dec(10_000_000n), mint: WSOL, mode: "live", state: "pending" })));
    const b = r.newWorker("test-b");
    // Concurrent passes (retrying until one gets through): never more than one payout is signed.
    for (let i = 0; i < 10 && !(await r.db.Payout.exists({ state: "submitted" })); i++) {
      await Promise.all([r.worker.payouts.processDue(), b.payouts.processDue()]);
      expect(await r.db.Payout.countDocuments({ state: { $in: ["signing", "submitted"] } })).toBeLessThanOrEqual(1);
      r.clock.set(r.clock.now() + 21_000);
    }
    const rows: any[] = await r.db.Payout.find({}).lean();
    expect(rows.filter((x) => x.state === "submitted").length).toBe(1);
    const waiting = rows.find((x) => x.state === "pending")!;
    expect(waiting.lastError).toMatch(/insufficient SOL .* fund it with at least \d+ lamports/);
    expect(r.chain.transfers.length).toBe(1);
  });

  test("SPL payouts check the token balance and SOL for fees + recipient token-account rent", async () => {
    const r = await rig({ balance: 1_000_000n });
    const mint = Keypair.generate().publicKey.toBase58();
    const ex = new PayoutExecutor({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, payer: r.payer, terminal: new TerminalWriter(r.db, 1), clock: r.clock, tokenInfo: async () => ({ program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 6 }) });
    await r.db.Payout.create({ roundNumber: 1, recipient: wallet(), position: 0, amount: dec(500n), mint, mode: "live", state: "pending" });
    await ex.processDue();
    let row: any = await r.db.Payout.findOne({}).lean();
    expect(row.state).toBe("pending");
    expect(row.lastError).toContain(`insufficient ${mint}`);
    // fund the token account: now SOL for fees/rent is the limit
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { PublicKey } = await import("@solana/web3.js");
    r.chain.tokenBalances.set(getAssociatedTokenAddressSync(new PublicKey(mint), r.payer.publicKey).toBase58(), 10_000n);
    await r.db.Payout.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await ex.processDue();
    row = await r.db.Payout.findOne({}).lean();
    expect(row.state).toBe("pending");
    expect(row.lastError).toMatch(/insufficient SOL for fees\/rent .*recipient token-account rent [1-9]/);
  });
});

describe("U8 — payout asset decimals", () => {
  test("an SPL payout asset reports the mint's on-chain decimals, not 9", async () => {
    const r = await rig();
    const mint = Keypair.generate().publicKey.toBase58();
    await r.db.Pool.create({ key: `mock:${MOCK_POOL}`, provider: "mock", poolAddress: MOCK_POOL, tokenMint: "t", quoteMint: mint, quoteDecimals: 6 });
    const v = (await r.settings.raw()).version;
    await r.settings.update({ payoutAsset: mint, poolAddress: MOCK_POOL }, { actor: "t", expectedVersion: v });
    const data = new PublicData(r.db, r.cfg, r.settings, () => r.clock.now());
    expect((await data.rewardPool()).asset).toEqual({ symbol: "TOKEN", mint, decimals: 6 });
  });
});

describe("reconciliation", () => {
  const recon = (r: Rig) => new Reconciler({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, provider: () => r.provider, payoutWallet: null, terminal: new TerminalWriter(r.db, 1) });

  async function sharedVault(r: Rig, onChain: bigint) {
    const p: any = r.provider;
    p.id = "raydium_launchlab"; // exercise the non-mock path
    p.getFeeSourceState = async () => ({ slot: 1_000, unclaimedQuote: onChain, unclaimedBase: 0n, mayIncludeOtherPools: true, source: "vault" });
    await r.db.WorkerState.create({ _id: `cursor:mock:${MOCK_POOL}:${MOCK_POOL}`, cursor: { lastSignature: "x", lastSlot: 1, backfillComplete: true } });
    (r.chain as any).getSignaturesForAddress = async () => [];
    await swapRow(r, { sig: "mine", slot: 10, fee: 1_000n });
    await persistAttributions(r.db, [attribution({ key: "vault-inflow:o:1", kind: "shared_vault_inflow", phase: "bonding_curve", destinationPool: null, slot: 20, creatorAmount: 0n, excludedAmount: 4_000n, payoutEligible: false, excludedReason: "shared_vault_other_pool" })]);
  }

  test("shared creator vault: other pools' deposits are counted, so the comparison is exact", async () => {
    const r = await rig();
    await sharedVault(r, 5_000n);
    const res = await recon(r).feeSource();
    expect(res!.status).toBe("ok");
    expect(res!.expected).toBe(5_000n);
  });

  test("shared creator vault: other pools' fees can no longer mask an over-attribution", async () => {
    const r = await rig();
    await sharedVault(r, 4_500n); // chain holds less than this pool's fees + other pools' deposits
    const res = await recon(r).feeSource();
    expect(res!.status).toBe("over_attribution");
    expect(((await r.db.SystemState.findById("payout_halt").lean()) as any)?.value?.reason).toContain("over-attribution");
  });
});
