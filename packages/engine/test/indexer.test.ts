import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Indexer } from "../src/indexer/Indexer";
import { ingestRawTransaction } from "../src/indexer/ingest";
import { cursorId, readCursor } from "../src/indexer/signatureSync";
import { MOCK_POOL } from "../src/providers/mock/MockProvider";
import { selectRecipients } from "../src/rewards/selection";
import { rig, SOL, startDb, stopDb, wallet, type Rig } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

function indexer(r: Rig, instance = "idx-a") {
  return new Indexer({ db: r.db, cfg: { ...r.cfg, instanceId: instance }, settings: r.settings, rpc: r.chain, wsFactory: null });
}

describe("indexer", () => {
  test("backfills history, then picks up only new transactions from its persisted cursor", async () => {
    const r = await rig();
    for (let i = 0; i < 25; i++) {
      r.trade({ trader: wallet(), quote: SOL / 10n });
      r.chain.advance(1);
    }
    const idx = indexer(r);
    await idx.init();
    await idx.pollOnce();
    expect(await r.db.Swap.countDocuments()).toBe(25);
    const cur = await readCursor(r.db, cursorId("mock", MOCK_POOL, MOCK_POOL));
    expect(cur?.lastSlot).toBe(r.chain.slot - 1);

    // "Restart": a brand-new indexer instance resumes from the cursor; nothing is re-counted.
    r.trade({ trader: wallet(), quote: SOL / 10n });
    const idx2 = indexer(r, "idx-b");
    await idx2.init();
    expect(await idx2.pollOnce()).toBe(1);
    expect(await r.db.Swap.countDocuments()).toBe(26);
  });

  test("duplicate notifications and re-processing never double count", async () => {
    const r = await rig();
    const sig = r.trade({ trader: wallet(), quote: SOL });
    const raw = await r.chain.getTransactionRaw(sig);
    const ctx = { db: r.db, provider: r.provider, minBuyQuote: 1n, terminal: undefined };
    const results = await Promise.all(Array.from({ length: 6 }, () => ingestRawTransaction(ctx, raw, { source: "indexer", commitment: "confirmed" })));
    expect(results.reduce((s, x) => s + x.newSwaps, 0)).toBe(1);
    expect(await r.db.Swap.countDocuments()).toBe(1);
    const idx = indexer(r);
    await idx.init();
    await idx.pollOnce(); // the same tx again via polling
    expect(await r.db.Swap.countDocuments()).toBe(1);
    const act: any = await r.db.BuyerActivity.findOne({}).lean();
    expect(act.buyCount).toBe(1);
  });

  test("an RPC failure mid-sync leaves no gap: the cursor only advances past ingested transactions", async () => {
    const r = await rig();
    const sigs = Array.from({ length: 10 }, () => {
      const s = r.trade({ trader: wallet(), quote: SOL });
      r.chain.advance(1);
      return s;
    });
    const idx = indexer(r);
    await idx.init();
    const orig = r.chain.getTransactionRaw.bind(r.chain);
    let calls = 0;
    r.chain.getTransactionRaw = async (s: string) => (++calls === 6 ? null : orig(s)); // 6th fetch "not yet available"
    await expect(idx.pollOnce()).rejects.toThrow(/not yet available/);
    const partial = await r.db.Swap.countDocuments();
    expect(partial).toBeLessThan(10);
    r.chain.getTransactionRaw = orig;
    await idx.pollOnce();
    expect(await r.db.Swap.countDocuments()).toBe(10);
    expect((await r.db.Swap.distinct("signature")).sort()).toEqual([...sigs].sort());
  });

  test("transient RPC errors are retried by the client; polling still completes", async () => {
    const r = await rig();
    r.trade({ trader: wallet(), quote: SOL });
    const idx = indexer(r);
    await idx.init();
    r.chain.rpcFailures = 1;
    await expect(idx.pollOnce()).rejects.toThrow();
    await idx.pollOnce();
    expect(await r.db.Swap.countDocuments()).toBe(1);
  });

  test("finality: confirmed → finalized; a forked-out transaction is dropped and excluded from rewards", async () => {
    const r = await rig({ env: { INDEXER_DROP_AFTER_SECONDS: "30" } });
    const keep = wallet();
    const lost = wallet();
    r.trade({ trader: keep, quote: SOL });
    const forked = r.trade({ trader: lost, quote: SOL });
    const idx = indexer(r);
    await idx.init();
    await idx.pollOnce();
    r.chain.forkOut(forked);
    r.chain.advance(200); // the fork's slot is now well below the finalized slot
    // First proof of absence only marks a drop candidate (a single null status proves nothing).
    await idx.finalityPass(Date.now() + 60_000);
    expect(((await r.db.Swap.findOne({ trader: lost }).lean()) as any).status).toBe("active");
    await idx.finalityPass(Date.now() + 120_000);
    const rows: any[] = await r.db.Swap.find({}).lean();
    expect(rows.find((x) => x.trader === keep).commitment).toBe("finalized");
    expect(rows.find((x) => x.trader === lost).status).toBe("dropped");
    const sel = await selectRecipients(r.db, r.chain, { pool: MOCK_POOL, afterSlot: null, periodStartAt: null, snapshotSlot: r.chain.slot, minBuyQuote: 1n, buyerCount: 5, excluded: new Set() });
    expect(sel.recipients.map((x) => x.wallet)).toEqual([keep]);
  });

  test("terminal BUY lines are written exactly once per buy and flag below-minimum buys", async () => {
    const r = await rig();
    r.trade({ trader: wallet(), quote: SOL });
    r.trade({ trader: wallet(), quote: 10_000_000n }); // 0.01 SOL < 0.05 minimum
    const idx = indexer(r);
    await idx.init();
    await idx.pollOnce();
    await idx.pollOnce();
    const buys: any[] = await r.db.TerminalEvent.find({ type: "BUY" }).lean();
    expect(buys.length).toBe(2);
    expect(buys.filter((b) => /below minimum/.test(b.message)).length).toBe(1);
  });
});

describe("indexer without history backfill", () => {
  test("attaching mid-period still ingests the whole current reward period, but nothing before it", async () => {
    const r = await rig({ env: { INDEXER_BACKFILL: "none" } });
    const old = r.chain.addMockTrade({ trader: wallet(), pool: MOCK_POOL, kind: "buy", quote: SOL, slot: 500 });
    // a previous round snapshotted at slot 900
    await r.db.Round.create({ roundNumber: 1, roundIndex: 1, startsAt: new Date(), endsAt: new Date(), windowStartsAt: new Date(), state: "rolled_over", snapshotSlot: 900 });
    r.chain.slot = 1_000;
    const inPeriod = r.trade({ trader: wallet(), quote: SOL });
    const idx = indexer(r);
    await idx.init();
    await idx.pollOnce();
    const sigs = await r.db.Swap.distinct("signature");
    expect(sigs).toEqual([inPeriod]);
    expect(sigs).not.toContain(old);
    r.chain.advance(1);
    const later = r.trade({ trader: wallet(), quote: SOL });
    await idx.pollOnce();
    expect((await r.db.Swap.distinct("signature")).sort()).toEqual([inPeriod, later].sort());
  });
});
