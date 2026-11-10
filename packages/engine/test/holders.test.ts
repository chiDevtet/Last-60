/**
 * Holder draw: five random holders (≥ MIN_HOLDER_TOKENS, not paid as buyers) are paid alongside the
 * round's most recent qualifying buyers. Real MongoDB + FakeChain + MockProvider.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { big } from "../src/db/decimal";
import { MOCK_MINT, MOCK_POOL } from "../src/providers/mock/MockProvider";
import { drawHolders, fetchHolderBalances, holderMinBalance } from "../src/rewards/holders";
import { PublicData } from "../src/public/publicData";
import { rig, SOL, startDb, stopDb, T0, wallet, type Rig } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UNIT = 1_000_000n; // mock mint: 6 decimals
const W = 240_000;
const EXEC = T0 + W + 30_000;

/** A 165-byte SPL token account of the mock mint owned by `owner`. */
function hold(r: Rig, owner: string, tokens: bigint, mint = MOCK_MINT) {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(tokens * UNIT, 64);
  data[108] = 1;
  r.chain.accounts.set(Keypair.generate().publicKey.toBase58(), { data, owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false });
}

async function runRound(r: Rig) {
  await r.worker.scheduler.tick(r.clock.now());
  r.clock.set(T0 + W);
  await r.worker.scheduler.tick(r.clock.now());
  r.clock.set(EXEC);
  await r.worker.scheduler.tick(r.clock.now());
  await r.worker.payouts.processDue();
  r.chain.advance(40);
  await r.worker.payouts.processDue();
  return r.db.Round.findOne({ roundNumber: 1 }).lean() as Promise<any>;
}

function buys(r: Rig, n: number) {
  const ws = Array.from({ length: n }, wallet);
  for (const w of ws) {
    r.trade({ trader: w, quote: SOL });
    r.chain.advance(1);
  }
  return ws;
}

describe("holder draw (pure)", () => {
  const balances = new Map(Array.from({ length: 40 }, (_, i) => [wallet(), BigInt(100_000 + i) * UNIT] as [string, bigint]));
  const min = holderMinBalance(100_000n, 6);

  test("100,000 whole tokens in base units", () => {
    expect(min).toBe(100_000_000_000n);
    expect(holderMinBalance(100_000n, 9)).toBe(100_000_000_000_000n);
  });

  test("same seed → same winners; another seed → another draw; never more than count, never a duplicate", () => {
    const a = drawHolders({ balances, minBalance: min, count: 5, excluded: new Set(), seed: "aa" });
    const b = drawHolders({ balances, minBalance: min, count: 5, excluded: new Set(), seed: "aa" });
    const c = drawHolders({ balances, minBalance: min, count: 5, excluded: new Set(), seed: "bb" });
    expect(a.recipients).toEqual(b.recipients);
    expect(a.recipients.map((x) => x.wallet)).not.toEqual(c.recipients.map((x) => x.wallet));
    expect(a.recipients.length).toBe(5);
    expect(new Set(a.recipients.map((x) => x.wallet)).size).toBe(5);
    expect(a.eligibleCount).toBe(40);
  });

  test("below the minimum, excluded and off-curve (program-owned) addresses can never win", () => {
    const small = wallet();
    const excluded = wallet();
    const pda = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey(TOKEN_PROGRAM))[0].toBase58();
    const ok = wallet();
    const set = new Map<string, bigint>([[small, min - 1n], [excluded, min * 10n], [pda, min * 1000n], [ok, min]]);
    const d = drawHolders({ balances: set, minBalance: min, count: 5, excluded: new Set([excluded]), seed: "s" });
    expect(d.recipients).toEqual([{ wallet: ok, balance: min }]);
    expect(d.eligibleCount).toBe(1);
  });

  test("every eligible holder has the same chance (not weighted by balance)", () => {
    const whales = new Map<string, bigint>([[wallet(), min], [wallet(), min * 1_000_000n]]);
    const [small] = [...whales.keys()];
    let smallWins = 0;
    for (let i = 0; i < 2000; i++) if (drawHolders({ balances: whales, minBalance: min, count: 1, excluded: new Set(), seed: `seed-${i}` }).recipients[0]!.wallet === small) smallWins++;
    expect(smallWins).toBeGreaterThan(850);
    expect(smallWins).toBeLessThan(1150);
  });
});

describe("holder draw (rounds)", () => {
  test("five buyers and five random holders are paid the same amount; buyers are never drawn as holders", async () => {
    const r = await rig();
    const buyers = buys(r, 7).slice(2); // the 5 most recent
    const holders = Array.from({ length: 12 }, wallet);
    for (const h of holders) hold(r, h, 150_000n);
    for (const b of buyers) hold(r, b, 5_000_000n); // paid buyers also hold: must not be paid twice
    const tooSmall = wallet();
    hold(r, tooSmall, 99_999n);
    hold(r, wallet(), 900_000n, Keypair.generate().publicKey.toBase58()); // another mint
    const split = wallet();
    hold(r, split, 60_000n); // two accounts of one wallet are summed: 120,000 ≥ 100,000
    hold(r, split, 60_000n);

    const round = await runRound(r);
    expect(round.state).toBe("completed");
    expect(round.recipientCount).toBe(10);
    expect(round.holderRecipientCount).toBe(5);
    expect(round.holderDraw.eligibleCount).toBe(13);
    expect(round.config.holderCount).toBe(5);
    expect(round.config.minHolderTokens).toBe("100000");

    const payouts: any[] = await r.db.Payout.find({ roundNumber: 1 }).sort({ position: 1 }).lean();
    expect(payouts.length).toBe(10);
    const buyerRows = payouts.filter((p) => p.kind === "buyer");
    const holderRows = payouts.filter((p) => p.kind === "holder");
    expect(new Set(buyerRows.map((p) => p.recipient))).toEqual(new Set(buyers));
    expect(holderRows.length).toBe(5);
    for (const h of holderRows) {
      expect([...holders, split]).toContain(h.recipient);
      expect(buyers).not.toContain(h.recipient);
      expect(h.recipient).not.toBe(tooSmall);
    }
    expect(new Set(payouts.map((p) => p.recipient)).size).toBe(10);
    // One equal share each, and nothing is created or lost.
    const per = big(round.perRecipient);
    for (const p of payouts) {
      expect(big(p.amount)).toBe(per);
      expect(p.state).toBe("confirmed");
    }
    expect(per * 10n + big(round.dust)).toBe(big(round.reward));
    expect(big(round.paid)).toBe(per * 10n);
    for (const p of payouts) expect(r.chain.transfersTo(p.recipient).length).toBe(1);

    // Public API: every payout says why it was paid.
    const pub = new PublicData(r.db, r.cfg, r.settings, () => r.clock.now());
    const detail = (await pub.round(1))!;
    expect(detail.holderRecipientCount).toBe(5);
    expect(detail.eligibleHolders).toBe(13);
    expect(detail.holderDrawSeed).toBe(round.holderDraw.seed);
    expect(detail.payouts.filter((p) => p.kind === "holder").length).toBe(5);
    expect(detail.payouts.filter((p) => p.kind === "buyer").length).toBe(5);
    const cur = await pub.currentRound();
    expect(cur.holderCount).toBe(5);
    expect(cur.minHolderTokens).toBe("100000");
    // Holders who never bought do not inflate the buyer count.
    expect(await r.db.BuyerActivity.countDocuments({ wallet: { $in: holderRows.map((p) => p.recipient) } })).toBe(0);
  }, 60_000);

  test("fewer eligible holders than HOLDER_COUNT: all of them are paid", async () => {
    const r = await rig();
    buys(r, 5);
    const holders = [wallet(), wallet()];
    for (const h of holders) hold(r, h, 100_000n);
    const round = await runRound(r);
    expect(round.recipientCount).toBe(7);
    expect(round.holderRecipientCount).toBe(2);
    const rows: any[] = await r.db.Payout.find({ roundNumber: 1, kind: "holder" }).lean();
    expect(new Set(rows.map((p) => p.recipient))).toEqual(new Set(holders));
  }, 60_000);

  test("no qualifying buyer: nothing is paid to holders either, the pool rolls over", async () => {
    const r = await rig();
    for (let i = 0; i < 8; i++) hold(r, wallet(), 500_000n);
    r.trade({ trader: wallet(), kind: "sell", quote: SOL });
    r.chain.advance(1);
    const round = await runRound(r);
    expect(round.state).toBe("rolled_over");
    expect(round.outcome).toBe("no_buyers");
    expect(await r.db.Payout.countDocuments({})).toBe(0);
    expect(big(round.rolloverOut)).toBe(big(round.reward));
  }, 60_000);

  test("excluded wallets, the creator and the payout wallet are never drawn", async () => {
    const r = await rig();
    const banned = wallet();
    await r.db.Settings.updateOne({ _id: "active" }, { $set: { "overrides.excludedWallets": [banned] }, $inc: { version: 1 } });
    buys(r, 5);
    hold(r, banned, 9_000_000n);
    hold(r, r.provider.info().creator, 9_000_000n);
    hold(r, r.payer.publicKey.toBase58(), 9_000_000n);
    const ok = wallet();
    hold(r, ok, 100_000n);
    const round = await runRound(r);
    const rows: any[] = await r.db.Payout.find({ roundNumber: 1, kind: "holder" }).lean();
    expect(rows.map((p) => p.recipient)).toEqual([ok]);
    expect(round.holderDraw.eligibleCount).toBe(1);
  }, 60_000);

  test("HOLDER_COUNT=0 switches the draw off: buyers only, as before", async () => {
    const r = await rig({ env: { HOLDER_COUNT: "0" } });
    const buyers = buys(r, 5);
    for (let i = 0; i < 8; i++) hold(r, wallet(), 500_000n);
    const round = await runRound(r);
    expect(round.recipientCount).toBe(5);
    expect(round.holderRecipientCount).toBe(0);
    expect(round.holderDraw).toBeNull();
    const rows: any[] = await r.db.Payout.find({ roundNumber: 1 }).lean();
    expect(new Set(rows.map((p) => p.recipient))).toEqual(new Set(buyers));
  }, 60_000);

  test("the holder set cannot be read: the round still pays its buyers", async () => {
    const r = await rig();
    const buyers = buys(r, 5);
    for (let i = 0; i < 8; i++) hold(r, wallet(), 500_000n);
    r.chain.getProgramAccounts = async () => {
      throw new Error("getProgramAccounts is not available on this endpoint");
    };
    const round = await runRound(r);
    expect(round.state).toBe("completed");
    expect(round.recipientCount).toBe(5);
    expect(round.holderDraw.error).toContain("not available");
    const rows: any[] = await r.db.Payout.find({ roundNumber: 1 }).lean();
    expect(new Set(rows.map((p) => p.recipient))).toEqual(new Set(buyers));
  }, 60_000);

  test("a resumed execution reuses the stored draw instead of drawing again", async () => {
    const r = await rig();
    buys(r, 5);
    const holders = Array.from({ length: 30 }, wallet);
    for (const h of holders) hold(r, h, 200_000n);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    // Crash after the draw was persisted, before the round was committed.
    const insertMany = r.db.Payout.insertMany.bind(r.db.Payout);
    (r.db.Payout as any).insertMany = async () => {
      throw new Error("injected crash");
    };
    r.clock.set(EXEC);
    await r.worker.scheduler.tick(r.clock.now()).catch(() => undefined);
    (r.db.Payout as any).insertMany = insertMany;
    const stuck: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(stuck.state).toBe("snapshotting");
    const drawn = stuck.holderDraw.recipients.map((h: any) => h.wallet);
    expect(drawn.length).toBe(5);

    r.clock.set(EXEC + 5_000);
    await r.worker.scheduler.tick(r.clock.now());
    const round: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(round.state).toBe("paying");
    expect(round.holderDraw.seed).toBe(stuck.holderDraw.seed);
    const rows: any[] = await r.db.Payout.find({ roundNumber: 1, kind: "holder" }).lean();
    expect(new Set(rows.map((p) => p.recipient))).toEqual(new Set(drawn));
  }, 60_000);

  test("fetchHolderBalances sums a wallet's accounts and ignores empty ones", async () => {
    const r = await rig();
    const a = wallet();
    const empty = wallet();
    hold(r, a, 10n);
    hold(r, a, 5n);
    hold(r, empty, 0n);
    const m = await fetchHolderBalances(r.chain, MOCK_MINT, TOKEN_PROGRAM);
    expect(m.get(a)).toBe(15n * UNIT);
    expect(m.has(empty)).toBe(false);
    expect(MOCK_POOL).toBeTruthy();
  });
});
