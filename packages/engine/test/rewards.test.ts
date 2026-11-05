/**
 * Rewards engine integration tests: real MongoDB replica set + FakeChain + MockProvider.
 * These exercise the production scheduler and payout executor code paths end to end.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { big } from "../src/db/decimal";
import { RoundScheduler } from "../src/rewards/scheduler";
import { selectRecipients } from "../src/rewards/selection";
import { ingestRawTransaction } from "../src/indexer/ingest";
import { MOCK_POOL } from "../src/providers/mock/MockProvider";
import { Lease } from "../src/util/lease";
import { rig, SOL, startDb, stopDb, T0, wallet, type Rig } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const W = 240_000; // window start offset
const EXEC = T0 + W + 30_000; // rig's deterministic "random" picks 4:30

async function runRound(r: Rig, opts: { finalize?: boolean } = {}) {
  await r.worker.scheduler.tick(r.clock.now());
  r.clock.set(T0 + W);
  await r.worker.scheduler.tick(r.clock.now());
  r.clock.set(EXEC);
  await r.worker.scheduler.tick(r.clock.now());
  await r.worker.payouts.processDue();
  if (opts.finalize !== false) {
    r.chain.advance(40);
    await r.worker.payouts.processDue();
  }
  return r.db.Round.findOne({ roundNumber: 1 }).lean() as Promise<any>;
}

describe("unique buyer selection", () => {
  test("spec sequence A, B, A, C, D, E: each wallet once, ranked by its latest qualifying buy", async () => {
    const r = await rig();
    const [A, B, C, D, E, F] = Array.from({ length: 6 }, wallet);
    const seq: [string, bigint][] = [[A!, 100_000_000n], [B!, 50_000_000n], [A!, 200_000_000n], [C!, 150_000_000n], [D!, 80_000_000n], [E!, 50_000_000n], [F!, 40_000_000n]];
    for (const [w, q] of seq) {
      r.trade({ trader: w, quote: q });
      r.chain.advance(1);
    }
    const tx = await r.chain.getSignaturesForAddress(MOCK_POOL);
    for (const s of tx.reverse()) await ingestRawTransaction({ db: r.db, provider: r.provider, minBuyQuote: 50_000_000n }, await r.chain.getTransactionRaw(s.signature), { source: "indexer", commitment: "confirmed" });
    const sel = await selectRecipients(r.db, r.chain, { pool: MOCK_POOL, afterSlot: null, periodStartAt: null, snapshotSlot: r.chain.slot, minBuyQuote: 50_000_000n, buyerCount: 5, excluded: new Set() });
    // The brief lists "A, E, D, C, B", but by its own rule A's latest buy (3rd tx) is older than
    // C, D and E. The selected SET — and therefore every payout — is identical either way.
    expect(sel.recipients.map((x) => x.wallet)).toEqual([E, D, C, A, B]);
    expect(new Set(sel.recipients.map((x) => x.wallet))).toEqual(new Set([A, B, C, D, E]));
    expect(sel.eligibleBuyerCount).toBe(5); // F is below the 0.05 SOL minimum
    expect(sel.recipients.find((x) => x.wallet === A)!.quoteAmount).toBe(200_000_000n); // A counted once, latest buy
  });

  test("a wallet's repeat buy moves it to the front (A buys last → A, E, D, C, B)", async () => {
    const r = await rig();
    const [A, B, C, D, E] = Array.from({ length: 5 }, wallet);
    for (const [w, q] of [[A, 100_000_000n], [B, 50_000_000n], [C, 150_000_000n], [D, 80_000_000n], [E, 50_000_000n], [A, 200_000_000n]] as [string, bigint][]) {
      r.trade({ trader: w, quote: q });
      r.chain.advance(1);
    }
    for (const s of (await r.chain.getSignaturesForAddress(MOCK_POOL)).reverse()) await ingestRawTransaction({ db: r.db, provider: r.provider, minBuyQuote: 50_000_000n }, await r.chain.getTransactionRaw(s.signature), { source: "indexer", commitment: "confirmed" });
    const sel = await selectRecipients(r.db, r.chain, { pool: MOCK_POOL, afterSlot: null, periodStartAt: null, snapshotSlot: r.chain.slot, minBuyQuote: 50_000_000n, buyerCount: 5, excluded: new Set() });
    expect(sel.recipients.map((x) => x.wallet)).toEqual([A, E, D, C, B]);
  });

  test("buyer count limits the set to the most recent unique wallets", async () => {
    const r = await rig();
    const ws = Array.from({ length: 8 }, wallet);
    for (const w of ws) {
      r.trade({ trader: w, quote: SOL / 10n });
      r.chain.advance(1);
    }
    for (const s of (await r.chain.getSignaturesForAddress(MOCK_POOL)).reverse()) await ingestRawTransaction({ db: r.db, provider: r.provider, minBuyQuote: 1n }, await r.chain.getTransactionRaw(s.signature), { source: "indexer", commitment: "confirmed" });
    const sel = await selectRecipients(r.db, r.chain, { pool: MOCK_POOL, afterSlot: null, periodStartAt: null, snapshotSlot: r.chain.slot, minBuyQuote: 1n, buyerCount: 5, excluded: new Set() });
    expect(sel.recipients.map((x) => x.wallet)).toEqual(ws.slice(3).reverse());
    expect(sel.eligibleBuyerCount).toBe(8);
  });

  test("intra-slot ties at the cut-off are broken by the block's transaction order", async () => {
    const r = await rig();
    const ws = Array.from({ length: 4 }, wallet);
    for (const w of ws) r.trade({ trader: w, quote: SOL / 10n }); // all in ONE slot
    const sigs = await r.chain.getSignaturesForAddress(MOCK_POOL);
    for (const s of [...sigs].reverse()) await ingestRawTransaction({ db: r.db, provider: r.provider, minBuyQuote: 1n }, await r.chain.getTransactionRaw(s.signature), { source: "indexer", commitment: "confirmed" });
    const sel = await selectRecipients(r.db, r.chain, { pool: MOCK_POOL, afterSlot: null, periodStartAt: null, snapshotSlot: r.chain.slot, minBuyQuote: 1n, buyerCount: 2, excluded: new Set() });
    expect(sel.tieBreak).toBe("block_order");
    expect(sel.recipients.map((x) => x.wallet)).toEqual([ws[3], ws[2]]); // last two in block order
  });

  test("sells, failed transactions and excluded wallets never qualify", async () => {
    const r = await rig();
    const [A, B, C] = [wallet(), wallet(), wallet()];
    r.trade({ trader: A, quote: SOL, kind: "sell" });
    r.trade({ trader: B, quote: SOL, failed: true });
    r.trade({ trader: C, quote: SOL });
    const sigs = await r.chain.getSignaturesForAddress(MOCK_POOL);
    for (const s of sigs) await ingestRawTransaction({ db: r.db, provider: r.provider, minBuyQuote: 1n }, await r.chain.getTransactionRaw(s.signature), { source: "indexer", commitment: "confirmed" });
    const sel = await selectRecipients(r.db, r.chain, { pool: MOCK_POOL, afterSlot: null, periodStartAt: null, snapshotSlot: r.chain.slot, minBuyQuote: 1n, buyerCount: 5, excluded: new Set([C]) });
    expect(sel.recipients).toEqual([]);
    expect(await r.db.Swap.countDocuments({ side: "buy" })).toBe(1); // only C's buy; B's failed tx ignored
  });
});

describe("round lifecycle (live mode)", () => {
  test("five-minute round: schedule → snapshot → 75% split → individual transfers → finalized", async () => {
    const r = await rig();
    const buyers = Array.from({ length: 7 }, wallet);
    await r.worker.scheduler.tick(r.clock.now());
    for (const [i, w] of buyers.entries()) {
      r.trade({ trader: w, quote: SOL / 10n + BigInt(i) * 10_000_000n }); // 0.10, 0.11, …
      r.chain.advance(2);
    }
    // Before the window: no execute time exists yet.
    let round: any = await r.db.Round.findOne({ roundNumber: 1 }).select("+executeAtCipher").lean();
    expect(round.state).toBe("open");
    expect(round.executeAtCipher).toBeNull();

    // Window opens: a time is drawn, sealed, and survives a restart unchanged.
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    round = await r.db.Round.findOne({ roundNumber: 1 }).select("+executeAtCipher").lean();
    expect(round.state).toBe("scheduled");
    expect(round.executeAtCipher).toMatch(/^v1\./);
    expect(JSON.stringify(round)).not.toContain(String(EXEC)); // never stored in plaintext
    const restarted = r.newWorker("test-b").scheduler;
    await restarted.ensureGenesis(r.clock.now());
    expect(await restarted.ensureExecuteAt(round.roundIndex, r.clock.now() + 5000)).toBe(EXEC);

    // One ms before the instant: nothing happens.
    r.clock.set(EXEC - 1);
    await r.worker.scheduler.tick(r.clock.now());
    expect((await r.db.Round.findOne({ roundNumber: 1 }).lean() as any).state).toBe("scheduled");

    // At the instant: snapshot + allocation.
    r.clock.set(EXEC);
    await r.worker.scheduler.tick(r.clock.now());
    round = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(round.state).toBe("paying");
    const totalQuote = buyers.reduce((s, _, i) => s + SOL / 10n + BigInt(i) * 10_000_000n, 0n);
    const fees = totalQuote / 100n; // harness: 1% of quote is eligible (sum of per-trade floors)
    expect(big(round.fees)).toBe(fees);
    expect(big(round.reward)).toBe((fees * 7500n) / 10_000n);
    expect(round.recipientCount).toBe(5);
    const payouts: any[] = await r.db.Payout.find({ roundNumber: 1 }).sort({ position: 1 }).lean();
    expect(payouts.map((p) => p.recipient)).toEqual(buyers.slice(2).reverse()); // most recent five
    const per = big(round.perRecipient);

    // Submit: transfers land, but success is recorded only at the required commitment.
    await r.worker.payouts.processDue();
    expect(r.chain.transfers.length).toBe(5);
    expect(await r.db.Payout.countDocuments({ state: "submitted" })).toBe(5);
    await r.worker.payouts.processDue();
    expect(await r.db.Payout.countDocuments({ state: "confirmed" })).toBe(0); // confirmed ≠ finalized
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    expect(await r.db.Payout.countDocuments({ state: "confirmed" })).toBe(5);
    round = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(round.state).toBe("completed");
    expect(big(round.paid)).toBe(per * 5n);
    for (const p of payouts) {
      const t = r.chain.transfersTo(p.recipient);
      expect(t.length).toBe(1);
      expect(t[0]!.lamports).toBe(per);
      expect(t[0]!.from).toBe(r.payer.publicKey.toBase58());
    }
    // Ledger invariants and terminal privacy.
    const recon = await r.worker.reconciler.ledger();
    expect(recon.problems).toEqual([]);
    const events: any[] = await r.db.TerminalEvent.find().sort({ seq: 1 }).lean();
    const types = events.map((e) => e.type);
    expect(types).toContain("ACCOUNTING");
    expect(types.filter((t) => t === "CONFIRMED").length).toBe(5);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(String(EXEC));
    expect(dump).not.toContain(new Date(EXEC).toISOString());
    expect(dump).not.toMatch(/execute|delay|candidate/i);
  });

  test("the same round can never execute twice, even with two concurrent workers", async () => {
    const r = await rig();
    await r.worker.scheduler.tick(r.clock.now());
    const buyers = Array.from({ length: 5 }, wallet);
    for (const w of buyers) r.trade({ trader: w, quote: SOL });
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(EXEC);
    const other = r.newWorker("test-b");
    const round: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    await Promise.all([r.worker.scheduler.execute(round._id, EXEC), other.scheduler.execute(round._id, EXEC), r.worker.scheduler.tick(EXEC), other.scheduler.tick(EXEC)]);
    expect(await r.db.Payout.countDocuments({ roundNumber: 1 })).toBe(5);
    expect(await r.db.LedgerEntry.countDocuments({ type: "FEE_ACCRUED", roundNumber: 1 })).toBe(1);
    // Two executors racing over the same payouts still send each transfer once.
    await Promise.all([r.worker.payouts.processDue(), other.payouts.processDue(), r.worker.payouts.processDue()]);
    r.chain.advance(40);
    await Promise.all([r.worker.payouts.processDue(), other.payouts.processDue()]);
    expect(r.chain.transfers.length).toBe(5);
    expect(new Set(r.chain.transfers.map((t) => t.to)).size).toBe(5);
    expect(await r.db.Payout.countDocuments({ state: "confirmed" })).toBe(5);
  });

  test("crash mid-snapshot: recovery reuses the persisted snapshot slot (deterministic)", async () => {
    const r = await rig();
    await r.worker.scheduler.tick(r.clock.now());
    const early = wallet();
    r.trade({ trader: early, quote: SOL });
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(EXEC);
    const orig = r.chain.getSignaturesForAddress.bind(r.chain);
    r.chain.getSignaturesForAddress = async () => {
      throw new Error("RPC down");
    };
    await expect(r.worker.scheduler.tick(EXEC)).rejects.toThrow(/RPC down/);
    let round: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(round.state).toBe("snapshotting");
    const slot = round.snapshotSlot;
    expect(slot).toBe(r.chain.slot);
    // A buy after the snapshot slot must NOT be included when the round is recovered.
    r.chain.getSignaturesForAddress = orig;
    r.chain.advance(5);
    r.trade({ trader: wallet(), quote: SOL });
    r.clock.set(EXEC + 5_000);
    await r.worker.scheduler.tick(r.clock.now());
    round = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(round.state).toBe("paying");
    expect(round.snapshotSlot).toBe(slot);
    const p: any[] = await r.db.Payout.find({ roundNumber: 1 }).lean();
    expect(p.map((x) => x.recipient)).toEqual([early]);
  });

  test("no qualifying buyers: nothing paid, skipped round recorded, reward rolls into the next round", async () => {
    const r = await rig();
    await r.worker.scheduler.tick(r.clock.now());
    r.trade({ trader: wallet(), quote: SOL, kind: "sell" }); // fees but no buyers
    const round = await runRound(r);
    expect(round.state).toBe("rolled_over");
    expect(round.recipientCount).toBe(0);
    const fees = SOL / 100n;
    expect(big(round.rolloverOut)).toBe((fees * 7500n) / 10_000n);
    expect(r.chain.transfers.length).toBe(0);
    // Next round: one buyer receives this round's reward plus the rollover.
    const buyer = wallet();
    r.chain.advance(1);
    r.trade({ trader: buyer, quote: SOL });
    r.clock.set(T0 + 300_000 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(T0 + 300_000 + W + 30_000);
    await r.worker.scheduler.tick(r.clock.now());
    const r2: any = await r.db.Round.findOne({ roundNumber: 2 }).lean();
    expect(big(r2.rolloverIn)).toBe(big(round.rolloverOut));
    expect(big(r2.reward)).toBe((fees * 7500n) / 10_000n * 2n);
    expect(r2.prevSnapshotSlot).toBe(round.snapshotSlot);
    expect((await r.worker.reconciler.ledger()).problems).toEqual([]);
  });

  test("insufficient payout wallet balance: payouts wait, nothing is partially sent, then complete when funded", async () => {
    const r = await rig({ balance: 1_000_000n });
    await r.worker.scheduler.tick(r.clock.now());
    r.trade({ trader: wallet(), quote: 10n * SOL });
    const round = await runRound(r);
    expect(round.state).toBe("awaiting_funds");
    expect(r.chain.sent.length).toBe(0);
    const evs = await r.db.TerminalEvent.countDocuments({ type: "WARN", message: /insufficient/ });
    expect(evs).toBe(1);
    r.chain.setBalance(r.payer.publicKey.toBase58(), 10n * SOL);
    r.clock.set(r.clock.now() + 16_000);
    await r.worker.payouts.processDue();
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    expect((await r.db.Round.findOne({ roundNumber: 1 }).lean() as any).state).toBe("completed");
    expect(r.chain.transfers.length).toBe(1);
  });
});

describe("payout failure handling and idempotency", () => {
  async function oneBuyerRound(r: Rig) {
    await r.worker.scheduler.tick(r.clock.now());
    const buyer = wallet();
    r.trade({ trader: buyer, quote: 10n * SOL });
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(EXEC);
    await r.worker.scheduler.tick(r.clock.now());
    return buyer;
  }

  test("dropped transaction: waits for blockhash expiry, then re-signs — recipient paid exactly once", async () => {
    const r = await rig();
    const buyer = await oneBuyerRound(r);
    r.chain.sendFaults = ["drop"];
    await r.worker.payouts.processDue(); // submitted, silently dropped
    await r.worker.payouts.processDue(); // unknown, blockhash still valid → rebroadcast same bytes
    let p: any = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("submitted");
    expect(p.attempts.length).toBe(1);
    expect(new Set(r.chain.sent.map((s) => s.signature)).size).toBe(1); // rebroadcast = same signature
    r.chain.advance(200); // finalized height passes lastValidBlockHeight
    r.clock.set(r.clock.now() + 80_000);
    await r.worker.payouts.processDue();
    p = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("pending");
    expect(p.attempts[0].outcome).toBe("expired");
    r.clock.set(r.clock.now() + 10_000);
    await r.worker.payouts.processDue();
    r.chain.advance(40);
    r.clock.set(r.clock.now() + 2_000);
    await r.worker.payouts.processDue();
    p = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("confirmed");
    expect(p.attempts.map((a: any) => a.outcome)).toEqual(["expired", "confirmed"]);
    expect(r.chain.transfersTo(buyer).length).toBe(1);
  });

  test("transaction that lands with an error is retried only after the failure is finalized", async () => {
    const r = await rig();
    const buyer = await oneBuyerRound(r);
    r.chain.sendFaults = ["fail"];
    await r.worker.payouts.processDue();
    await r.worker.payouts.processDue();
    expect(((await r.db.Payout.findOne({}).lean()) as any).state).toBe("submitted"); // not finalized yet → wait
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    expect(((await r.db.Payout.findOne({}).lean()) as any).state).toBe("pending");
    r.clock.set(r.clock.now() + 10_000);
    await r.worker.payouts.processDue();
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    expect(((await r.db.Payout.findOne({}).lean()) as any).state).toBe("confirmed");
    expect(r.chain.transfersTo(buyer).length).toBe(1);
  });

  test("RPC times out after accepting the transaction: detected as landed, never re-signed", async () => {
    const r = await rig();
    const buyer = await oneBuyerRound(r);
    r.chain.sendFaults = ["timeout_after_accept"];
    await r.worker.payouts.processDue();
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    const p: any = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("confirmed");
    expect(p.attempts.length).toBe(1);
    expect(r.chain.transfersTo(buyer).length).toBe(1);
  });

  test("transient send failure is recovered by rebroadcasting identical bytes", async () => {
    const r = await rig();
    const buyer = await oneBuyerRound(r);
    r.chain.sendFaults = ["rpc_error"];
    await r.worker.payouts.processDue();
    r.clock.set(r.clock.now() + 3_000);
    await r.worker.payouts.processDue(); // rebroadcast lands
    r.chain.advance(40);
    r.clock.set(r.clock.now() + 2_000);
    await r.worker.payouts.processDue();
    const p: any = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("confirmed");
    expect(p.attempts.length).toBe(1);
    expect(r.chain.transfersTo(buyer).length).toBe(1);
  });

  test("max attempts → failed (recoverable) → operator requeue → paid once", async () => {
    const r = await rig({ env: { PAYOUT_MAX_ATTEMPTS: "2" } });
    const buyer = await oneBuyerRound(r);
    r.chain.sendFaults = ["fail", "fail"];
    for (let i = 0; i < 2; i++) {
      await r.worker.payouts.processDue();
      r.chain.advance(40);
      await r.worker.payouts.processDue();
      r.clock.set(r.clock.now() + 20_000);
    }
    let p: any = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("failed");
    expect(((await r.db.Round.findOne({ roundNumber: 1 }).lean()) as any).state).toBe("attention");
    expect(await r.db.LedgerEntry.countDocuments({ type: "PAYOUT_FAILED" })).toBe(1);
    expect(r.chain.transfersTo(buyer).length).toBe(0);
    expect(await r.worker.payouts.requeueFailed(String(p._id), "admin")).toBe(true);
    await r.worker.payouts.processDue();
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    p = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("confirmed");
    expect(r.chain.transfersTo(buyer).length).toBe(1);
    expect(((await r.db.Round.findOne({ roundNumber: 1 }).lean()) as any).state).toBe("completed");
  });

  test("worker crash after signing but before persisting never broadcasts; the row is safely retried", async () => {
    const r = await rig();
    await oneBuyerRound(r);
    // Simulate a crash that left a row in `signing` with an expired lock.
    await r.db.Payout.updateOne({}, { $set: { state: "signing", lock: { owner: "dead", token: "x", expiresAt: new Date(r.clock.now() - 1) } } });
    await r.worker.payouts.processDue();
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    expect(((await r.db.Payout.findOne({}).lean()) as any).state).toBe("confirmed");
    expect(r.chain.transfers.length).toBe(1);
  });

  test("database uniqueness makes a duplicate payout row impossible", async () => {
    const r = await rig();
    await oneBuyerRound(r);
    const p: any = await r.db.Payout.findOne({}).lean();
    await expect(r.db.Payout.create({ roundNumber: p.roundNumber, recipient: p.recipient, position: 9, amount: p.amount, mint: p.mint, mode: "live" })).rejects.toThrow(/duplicate key/);
  });

  test("refuses to sign when the loaded key differs from the configured payout public key", async () => {
    const r = await rig();
    await oneBuyerRound(r);
    await r.db.Settings.updateOne({ _id: "active" }, { $set: { "overrides.expectedPayoutPublicKey": wallet() } });
    await r.worker.payouts.processDue();
    const p: any = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("pending");
    expect(p.lastError).toMatch(/does not match/);
    expect(r.chain.sent.length).toBe(0);
  });
});

describe("modes, windows and leadership", () => {
  test("dry-run never signs or sends, and says so publicly", async () => {
    const r = await rig({ env: { PAYOUT_MODE: "dry_run" } });
    await r.worker.scheduler.tick(r.clock.now());
    r.trade({ trader: wallet(), quote: SOL });
    const round = await runRound(r);
    expect(round.state).toBe("completed");
    expect(round.dryRun).toBe(true);
    expect(r.chain.sent.length).toBe(0);
    expect(await r.db.Payout.countDocuments({ state: "simulated" })).toBe(1);
    expect(await r.db.TerminalEvent.countDocuments({ message: /DRY-RUN/ })).toBe(1);
    expect(await r.db.LedgerEntry.countDocuments({ type: "PAYOUT_CONFIRMED" })).toBe(0);
  });

  test("engine down for a whole window: round marked missed, its buys and fees carry forward", async () => {
    const r = await rig();
    await r.worker.scheduler.tick(r.clock.now()); // round 1 created, then the engine "dies"
    const buyer = wallet();
    r.trade({ trader: buyer, quote: SOL });
    const R3 = T0 + 600_000;
    r.clock.set(R3 + 1_000);
    await r.worker.scheduler.tick(r.clock.now());
    expect(((await r.db.Round.findOne({ roundNumber: 1 }).lean()) as any).state).toBe("missed");
    expect(((await r.db.Round.findOne({ roundNumber: 2 }).lean()) as any).state).toBe("missed");
    r.clock.set(R3 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(R3 + W + 30_000);
    await r.worker.scheduler.tick(r.clock.now());
    const r3: any = await r.db.Round.findOne({ roundNumber: 3 }).lean();
    expect(r3.state).toBe("paying");
    expect(big(r3.fees)).toBe(SOL / 100n);
    expect(((await r.db.Payout.findOne({ roundNumber: 3 }).lean()) as any).recipient).toBe(buyer);
  });

  test("late start inside the window executes in the remaining window, past the window it is missed", async () => {
    const r = await rig({ random: (min, max) => max - 1 });
    r.clock.set(T0 + W + 50_000); // engine boots 10s before round end
    await r.worker.scheduler.tick(r.clock.now());
    const round: any = await r.db.Round.findOne({ roundNumber: 1 }).select("+executeAtCipher").lean();
    expect(round.state).toBe("scheduled");
    const at = await r.worker.scheduler.ensureExecuteAt(round.roundIndex, r.clock.now());
    expect(at).toBeGreaterThanOrEqual(T0 + W + 50_000);
    expect(at).toBeLessThan(T0 + 300_000);
  });

  test("only one leader holds a lease; a stale leader's lease can be taken over after expiry", async () => {
    const r = await rig();
    const a = new Lease(r.db, "rewards-test", "A", 10_000);
    const b = new Lease(r.db, "rewards-test", "B", 10_000);
    expect(await a.tryAcquire(1_000)).toBe(true);
    expect(await b.tryAcquire(2_000)).toBe(false);
    expect(await a.tryAcquire(5_000)).toBe(true); // renewal
    expect(await b.tryAcquire(20_000)).toBe(true); // A expired
    expect(await a.tryAcquire(21_000)).toBe(false);
    expect(a.fencingToken).toBeNull();
  });

  test("schedule changes that would renumber history are refused", async () => {
    const r = await rig();
    await r.worker.scheduler.tick(r.clock.now());
    const s = new RoundScheduler({ ...(r.worker.scheduler as any).d, cfg: { ...r.cfg, schedule: { ...r.cfg.schedule, roundDurationMs: 600_000 } } });
    await expect(s.ensureGenesis(r.clock.now())).rejects.toThrow(/renumber/);
  });
});
