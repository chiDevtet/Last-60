/**
 * Regression tests for defects found in the production-readiness audit (see docs/AUDIT.md).
 * Each test reproduces a concrete failure scenario against the real MongoDB replica set and the
 * fault-injecting FakeChain. They were written first and observed to FAIL on the unfixed code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WSOL_MINT } from "@last60/shared";
import { big, dec } from "../src/db/decimal";
import { ingestRawTransaction } from "../src/indexer/ingest";
import { cursorId, readCursor, syncAddress } from "../src/indexer/signatureSync";
import { MockProvider, MOCK_CREATOR, MOCK_POOL } from "../src/providers/mock/MockProvider";
import { PublicKey } from "@solana/web3.js";
import { rig, SOL, startDb, stopDb, T0, wallet, type Rig } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const W = 240_000;
const ROUND = 300_000;
const execAt = (n: number) => T0 + (n - 1) * ROUND + W + 30_000; // rig's deterministic draw = 4:30

/** Drive round n from its start through execution (and optionally payout finalization). */
async function runRoundN(r: Rig, n: number, opts: { finalize?: boolean } = {}) {
  const start = T0 + (n - 1) * ROUND;
  r.clock.set(Math.max(r.clock.now(), start + 1_000));
  await r.worker.scheduler.tick(r.clock.now());
  r.clock.set(start + W);
  await r.worker.scheduler.tick(r.clock.now());
  r.clock.set(execAt(n));
  await r.worker.scheduler.tick(r.clock.now());
  await r.worker.payouts.processDue();
  if (opts.finalize !== false) {
    r.chain.advance(40);
    r.clock.set(r.clock.now() + 2_000);
    await r.worker.payouts.processDue();
  }
  return r.db.Round.findOne({ roundNumber: n }).lean() as Promise<any>;
}

describe("mainnet live-payout gate is enforced by the signing process", () => {
  test("a live override (admin API / direct DB write) cannot move funds when this process has ALLOW_MAINNET_PAYOUTS=false", async () => {
    // The rewards env says: mainnet, dry_run, mainnet payouts NOT allowed. A key is present (staged for go-live).
    const r = await rig({ env: { SOLANA_CLUSTER: "mainnet-beta", ALLOW_MAINNET_PAYOUTS: "false", PAYOUT_MODE: "dry_run" } });
    // The runtime override is validated only by the *API* process' environment (or not at all if written directly).
    await r.db.Settings.updateOne({ _id: "active" }, { $set: { "overrides.payoutMode": "live" }, $inc: { version: 1 } });
    for (let i = 0; i < 3; i++) {
      r.trade({ trader: wallet(), quote: SOL });
      r.chain.advance(1);
    }
    await runRoundN(r, 1);
    expect(r.chain.sent).toHaveLength(0); // nothing was ever broadcast
    const payouts: any[] = await r.db.Payout.find({}).lean();
    expect(payouts).toHaveLength(3);
    expect(payouts.every((p) => p.state === "pending")).toBe(true); // queued, not lost
  });

  test("switching payoutMode back to dry_run stops signing of already-queued live payouts", async () => {
    const r = await rig();
    for (let i = 0; i < 2; i++) {
      r.trade({ trader: wallet(), quote: SOL });
      r.chain.advance(1);
    }
    // Plan the round in live mode but do not process payouts yet.
    r.clock.set(T0 + 1_000);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(execAt(1));
    await r.worker.scheduler.tick(r.clock.now());
    expect(await r.db.Payout.countDocuments({ mode: "live", state: "pending" })).toBe(2);
    // Operator flips to dry_run (e.g. as an emergency measure).
    await r.db.Settings.updateOne({ _id: "active" }, { $set: { "overrides.payoutMode": "dry_run" }, $inc: { version: 1 } });
    await r.worker.payouts.processDue();
    expect(r.chain.sent).toHaveLength(0);
    expect(await r.db.Payout.countDocuments({ mode: "live", state: "pending" })).toBe(2);
  });
});

describe("snapshot slots are monotonic", () => {
  test("a lagging RPC slot can never re-open an already-paid period (no double payment, no rollover re-use)", async () => {
    const r = await rig();
    const A = wallet();
    r.trade({ trader: A, quote: SOL });
    r.chain.advance(20); // A's buy is a few slots older than round 1's snapshot
    const r1 = await runRoundN(r, 1);
    expect(r1.state).toBe("completed");
    expect(r.chain.transfersTo(A)).toHaveLength(1);

    // Round 2: B buys; the node answering getSlot is ~5 slots BEHIND round 1's snapshot.
    const B = wallet();
    r.clock.set(T0 + ROUND + 1_000);
    r.trade({ trader: B, quote: SOL });
    r.chain.advance(1);
    const realGetSlot = r.chain.getSlot.bind(r.chain);
    r.chain.getSlot = async (c = "confirmed") => (c === "finalized" ? realGetSlot(c) : r1.snapshotSlot - 5);
    await runRoundN(r, 2).catch(() => undefined);
    expect(r.chain.transfersTo(A)).toHaveLength(1); // A must not be paid twice for the same period

    // The RPC recovers: the round resumes with a correct, later snapshot and pays B only.
    r.chain.getSlot = realGetSlot;
    r.clock.set(r.clock.now() + 5_000);
    await r.worker.scheduler.tick(r.clock.now());
    await r.worker.payouts.processDue();
    r.chain.advance(40);
    r.clock.set(r.clock.now() + 2_000);
    await r.worker.payouts.processDue();
    const r2: any = await r.db.Round.findOne({ roundNumber: 2 }).lean();
    expect(r2.snapshotSlot).toBeGreaterThan(r1.snapshotSlot);
    expect(r2.prevSnapshotSlot).toBe(r1.snapshotSlot);
    expect(r.chain.transfersTo(A)).toHaveLength(1);
    expect(r.chain.transfersTo(B)).toHaveLength(1);
  });
});

describe("signature sync never skips a backlog larger than its cap", () => {
  test("the indexer ingests every transaction after its cursor even when the backlog exceeds the page cap", async () => {
    const r = await rig();
    r.trade({ trader: wallet(), quote: SOL, kind: "sell" });
    r.chain.advance(1);
    const key = cursorId("mock", MOCK_POOL, MOCK_POOL);
    const ctx = { db: r.db, provider: r.provider, minBuyQuote: 1n, rpc: r.chain };
    await syncAddress(ctx, MOCK_POOL, { cursorKey: key, source: "indexer", cap: 50_000, concurrency: 8 });
    expect(await r.db.Swap.countDocuments()).toBe(1);
    // Indexer was down; 2 500 transactions arrived (> one 1 000-signature page and > the cap).
    for (let i = 0; i < 2_500; i++) {
      r.trade({ trader: wallet(), quote: SOL / 100n, kind: "sell" });
      if (i % 10 === 0) r.chain.advance(1);
    }
    r.chain.advance(1);
    for (let pass = 0; pass < 6; pass++) {
      const s = await syncAddress(ctx, MOCK_POOL, { cursorKey: key, source: "indexer", cap: 1_000, concurrency: 8 });
      if (!s.more) break;
    }
    expect(await r.db.Swap.countDocuments()).toBe(2_501);
    expect((await readCursor(r.db, key))?.lastSlot).toBe(r.chain.slot - 1);
  }, 120_000);

  test("a truncated read-only catch-up is reported, so a snapshot is never taken on incomplete data", async () => {
    const r = await rig();
    for (let i = 0; i < 1_200; i++) r.trade({ trader: wallet(), quote: SOL / 100n, kind: "sell" });
    r.chain.advance(1);
    const ctx = { db: r.db, provider: r.provider, minBuyQuote: 1n, rpc: r.chain };
    const s: any = await syncAddress(ctx, MOCK_POOL, { untilSignature: null, source: "catchup", cap: 1_000, concurrency: 8, bounds: { afterSlot: 0 } });
    expect(s.truncated).toBe(true);
  }, 120_000);
});

describe("payout expiry decisions require an up-to-date status answer", () => {
  test("a lagging status node (null status) cannot cause a second transaction for a payout that landed", async () => {
    const r = await rig();
    const A = wallet();
    r.trade({ trader: A, quote: SOL });
    r.chain.advance(1);
    await runRoundN(r, 1, { finalize: false }); // broadcast; FakeChain lands it immediately
    expect(r.chain.transfersTo(A)).toHaveLength(1);
    const landedAt = r.chain.transfersTo(A)[0]!.slot;

    // A load-balanced RPC routes status queries to a node that has not seen the landing slot.
    const realStatuses = r.chain.getSignatureStatuses.bind(r.chain);
    const realCtx = (r.chain as any).getSignatureStatusesWithContext?.bind(r.chain);
    r.chain.getSignatureStatuses = async (sigs: string[]) => sigs.map(() => null);
    (r.chain as any).getSignatureStatusesWithContext = async (sigs: string[]) => ({ contextSlot: landedAt - 1, value: sigs.map(() => null) });
    r.chain.advance(400); // finalized height is now well past lastValidBlockHeight
    for (let i = 0; i < 4; i++) {
      r.clock.set(r.clock.now() + 70_000);
      await r.worker.payouts.processDue();
    }
    expect(r.chain.transfersTo(A)).toHaveLength(1); // never paid twice

    // The node catches up: the original transaction is confirmed.
    r.chain.getSignatureStatuses = realStatuses;
    if (realCtx) (r.chain as any).getSignatureStatusesWithContext = realCtx;
    r.clock.set(r.clock.now() + 70_000);
    await r.worker.payouts.processDue();
    const p: any = await r.db.Payout.findOne({ recipient: A }).lean();
    expect(p.state).toBe("confirmed");
    expect(r.chain.transfersTo(A)).toHaveLength(1);
  });
});

describe("fee claims", () => {
  test("a claim marked failed locally (ambiguous send error) is corrected to confirmed when it is seen on-chain", async () => {
    const r = await rig();
    const sig = r.chain.addMockTrade({ trader: MOCK_CREATOR, pool: MOCK_POOL, kind: "claim", quote: 5_000_000n });
    await r.db.FeeClaim.create({ signature: sig, provider: "mock", pool: MOCK_POOL, role: "creator", claimer: MOCK_CREATOR, quoteMint: WSOL_MINT, quoteAmount: dec(0n), baseAmount: dec(0n), source: "auto_claim", status: "failed", error: "injected timeout after accept" });
    await ingestRawTransaction({ db: r.db, provider: r.provider, minBuyQuote: 1n }, await r.chain.getTransactionRaw(sig), { source: "catchup", commitment: "confirmed" });
    const c: any = await r.db.FeeClaim.findOne({ signature: sig }).lean();
    expect(c.status).toBe("confirmed");
    expect(big(c.quoteAmount)).toBe(5_000_000n);
  });
});

describe("rewards loop liveness", () => {
  test("a slow fee claim cannot stall the scheduler (rounds would be missed)", async () => {
    const r = await rig();
    let ticks = 0;
    const tick = r.worker.scheduler.tick.bind(r.worker.scheduler);
    r.worker.scheduler.tick = async (now?: number) => {
      ticks++;
      return tick(now);
    };
    r.worker.fees.maybeClaim = () => new Promise<string | null>(() => undefined); // never settles
    const ctrl = new AbortController();
    const running = r.worker.run(ctrl.signal);
    await new Promise((res) => setTimeout(res, 500));
    ctrl.abort();
    r.worker.stop();
    await Promise.race([running, new Promise((res) => setTimeout(res, 2_000))]);
    expect(ticks).toBeGreaterThan(3);
  });
});

describe("provider / pool switching", () => {
  test("activity on the previous pool after the last snapshot is not silently dropped by a mid-period switch", async () => {
    const r = await rig();
    const A0 = wallet();
    r.trade({ trader: A0, quote: SOL });
    r.chain.advance(1);
    expect((await runRoundN(r, 1)).state).toBe("completed");

    // Round 2: A buys on the OLD pool (indexed), then the operator switches to a new pool where B buys.
    r.clock.set(T0 + ROUND + 1_000);
    const A = wallet();
    const sigA = r.trade({ trader: A, quote: SOL });
    r.chain.advance(1);
    await ingestRawTransaction({ db: r.db, provider: r.provider, minBuyQuote: 1n }, await r.chain.getTransactionRaw(sigA), { source: "indexer", commitment: "confirmed" });
    const P2 = new PublicKey(Buffer.alloc(32, 0x51)).toBase58();
    (r.worker as any).provider = new MockProvider({ poolAddress: P2 });
    const B = wallet();
    r.chain.addMockTrade({ trader: B, pool: P2, kind: "buy", quote: SOL, totalFee: SOL / 50n, eligibleFee: SOL / 100n });
    r.chain.advance(1);
    const r2 = await runRoundN(r, 2);
    expect(r2.config.pool).toBe(P2);
    expect(r2.config.previousPool).toBe(MOCK_POOL);
    expect(big(r2.fees)).toBe(2n * (SOL / 100n)); // both pools' eligible fees in the transition period
    expect(r.chain.transfersTo(A)).toHaveLength(1);
    expect(r.chain.transfersTo(B)).toHaveLength(1);
  });
});
