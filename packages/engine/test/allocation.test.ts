import { describe, expect, test } from "bun:test";
import { allocate, type AllocationInput } from "../src/rewards/allocation";
import { boundsOf, drawExecuteAt, preRoundClaimDue, roundIndexAt } from "../src/rewards/roundMath";
import { loadConfig } from "../src/config/env";
import { secureRandomInt } from "../src/util/crypto";

const SOL = 1_000_000_000n;
const base: AllocationInput = { fees: 0n, rolloverIn: 0n, rewardBps: 7500, recipients: [], minPayout: 1_000_000n, skippedRoundPolicy: "rollover" };
const wallets = (n: number) => Array.from({ length: n }, (_, i) => `W${i}`);

function invariant(a: ReturnType<typeof allocate>) {
  const paid = a.payouts.reduce((s, p) => s + p.amount, 0n);
  expect(a.fees + a.rolloverIn).toBe(a.retained + a.dust + a.rolloverOut + a.retainedPool + paid);
}

describe("allocation (75/25 split, integer arithmetic)", () => {
  test("spec example: 2 SOL fees, 5 buyers → 0.3 SOL each", () => {
    const a = allocate({ ...base, fees: 2n * SOL, recipients: wallets(5) });
    expect(a.rewardShare).toBe(1_500_000_000n);
    expect(a.retained).toBe(500_000_000n);
    expect(a.perRecipient).toBe(300_000_000n);
    expect(a.dust).toBe(0n);
    expect(a.payouts.map((p) => p.amount)).toEqual(Array(5).fill(300_000_000n));
    invariant(a);
  });

  test("only three buyers → pool split among three", () => {
    const a = allocate({ ...base, fees: 2n * SOL, recipients: wallets(3) });
    expect(a.perRecipient).toBe(500_000_000n);
    expect(a.payouts.length).toBe(3);
    invariant(a);
  });

  test("no buyers → nothing paid, pool rolled over (default) or retained", () => {
    const r = allocate({ ...base, fees: 2n * SOL });
    expect(r.outcome).toBe("no_buyers");
    expect(r.payouts).toEqual([]);
    expect(r.rolloverOut).toBe(1_500_000_000n);
    invariant(r);
    const k = allocate({ ...base, fees: 2n * SOL, skippedRoundPolicy: "retain" });
    expect(k.rolloverOut).toBe(0n);
    expect(k.retainedPool).toBe(1_500_000_000n);
    invariant(k);
  });

  test("rollover flows into the next round's pool", () => {
    const a = allocate({ ...base, fees: 1n * SOL, rolloverIn: 1_500_000_000n, recipients: wallets(5) });
    expect(a.pool).toBe(2_250_000_000n);
    expect(a.perRecipient).toBe(450_000_000n);
    invariant(a);
  });

  test("rounding dust is deterministic and accounted for", () => {
    const a = allocate({ ...base, fees: 1_000_000_007n, recipients: wallets(3) });
    // floor(1_000_000_007 * 0.75) = 750_000_005
    expect(a.rewardShare).toBe(750_000_005n);
    expect(a.retained).toBe(250_000_002n);
    expect(a.perRecipient).toBe(250_000_001n);
    expect(a.dust).toBe(2n);
    invariant(a);
    // same input → same output
    expect(allocate({ ...base, fees: 1_000_000_007n, recipients: wallets(3) })).toEqual(a);
  });

  test("below the minimum payout → rolled over, never sends dust-sized transfers", () => {
    const a = allocate({ ...base, fees: 3_000_000n, recipients: wallets(5) }); // pool 2.25M → 450k each
    expect(a.outcome).toBe("below_minimum");
    expect(a.payouts).toEqual([]);
    expect(a.rolloverOut).toBe(2_250_000n);
    invariant(a);
  });

  test("non-default percentages and huge values stay exact", () => {
    const a = allocate({ ...base, rewardBps: 7550, fees: 18_446_744_073_709_551_615n, recipients: wallets(7) });
    expect(a.rewardShare).toBe((18_446_744_073_709_551_615n * 7550n) / 10_000n);
    invariant(a);
  });

  test("property: invariant holds for random inputs", () => {
    for (let i = 0; i < 2000; i++) {
      const fees = BigInt(secureRandomInt(0, 2 ** 31)) * BigInt(secureRandomInt(1, 1000));
      const a = allocate({ ...base, fees, rolloverIn: BigInt(secureRandomInt(0, 2 ** 30)), rewardBps: secureRandomInt(1, 10_001), recipients: wallets(secureRandomInt(0, 8)), minPayout: BigInt(secureRandomInt(0, 5_000_000)) });
      invariant(a);
      for (const p of a.payouts) expect(p.amount).toBeGreaterThanOrEqual(a.perRecipient);
    }
  });

  test("rejects duplicate recipients and invalid bps", () => {
    expect(() => allocate({ ...base, fees: SOL, recipients: ["A", "A"] })).toThrow(/duplicate/);
    expect(() => allocate({ ...base, rewardBps: 0 })).toThrow();
    expect(() => allocate({ ...base, rewardBps: 10_001 })).toThrow();
  });
});

describe("clock-anchored rounds", () => {
  const p = { roundDurationMs: 300_000, windowStartMs: 240_000, windowDurationMs: 60_000, anchorEpochMs: 0 };

  test("rounds align to :00/:05 wall-clock boundaries", () => {
    const t = Date.UTC(2026, 10, 5, 12, 3, 17, 400);
    const b = boundsOf(roundIndexAt(t, p), p);
    expect(new Date(b.startsAt).toISOString()).toBe("2026-11-05T12:00:00.000Z");
    expect(new Date(b.windowStartsAt).toISOString()).toBe("2026-11-05T12:04:00.000Z");
    expect(new Date(b.endsAt).toISOString()).toBe("2026-11-05T12:05:00.000Z");
  });

  test("boundaries are exact: the last ms belongs to the round, the next ms to the next", () => {
    const start = Date.UTC(2026, 10, 5, 12, 5, 0);
    expect(roundIndexAt(start - 1, p) + 1).toBe(roundIndexAt(start, p));
    // no drift regardless of how late we compute it
    expect(boundsOf(roundIndexAt(start + 299_999, p), p).startsAt).toBe(start);
  });

  test("execute time is always inside the final window", () => {
    const b = boundsOf(5_000_000, p);
    for (let i = 0; i < 5000; i++) {
      const { executeAt, late } = drawExecuteAt(b, b.startsAt + 10, secureRandomInt);
      expect(late).toBe(false);
      expect(executeAt).toBeGreaterThanOrEqual(b.windowStartsAt);
      expect(executeAt).toBeLessThan(b.windowEndsAt);
    }
  });

  test("late draw is uniform over the remaining window and never in the past", () => {
    const b = boundsOf(5_000_000, p);
    const now = b.windowStartsAt + 45_000;
    for (let i = 0; i < 2000; i++) {
      const { executeAt, late } = drawExecuteAt(b, now, secureRandomInt);
      expect(late).toBe(true);
      expect(executeAt).toBeGreaterThanOrEqual(now);
      expect(executeAt).toBeLessThan(b.windowEndsAt);
    }
  });

  test("CSPRNG draw covers the window roughly uniformly (chi-square sanity check)", () => {
    const b = boundsOf(1, p);
    const buckets = new Array(12).fill(0);
    const N = 24_000;
    for (let i = 0; i < N; i++) {
      const { executeAt } = drawExecuteAt(b, 0, secureRandomInt);
      buckets[Math.floor(((executeAt - b.windowStartsAt) / p.windowDurationMs) * 12)]++;
    }
    const expected = N / 12;
    const chi2 = buckets.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(40); // df=11, p≈1e-4 threshold ≈ 37.4–40
  });
});

describe("pre-round fee claim (FEE_CLAIM_LEAD_SECONDS)", () => {
  const p = { roundDurationMs: 300_000, windowStartMs: 240_000, windowDurationMs: 60_000, anchorEpochMs: 0 };
  const b = boundsOf(5_981_740, p);
  test("due once per round, from the lead before the execution window until it opens", () => {
    const lead = 90_000;
    expect(preRoundClaimDue(b.windowStartsAt - lead - 1, p, lead, null)).toBeNull(); // too early: fees still accruing
    expect(preRoundClaimDue(b.windowStartsAt - lead, p, lead, null)?.index).toBe(b.index);
    expect(preRoundClaimDue(b.windowStartsAt - 1, p, lead, null)?.index).toBe(b.index);
    expect(preRoundClaimDue(b.windowStartsAt - 30_000, p, lead, b.index)).toBeNull(); // already claimed for this round
    expect(preRoundClaimDue(b.windowStartsAt, p, lead, null)).toBeNull(); // window open: the round may execute any moment
    expect(preRoundClaimDue(b.windowStartsAt - 30_000, p, 0, null)).toBeNull(); // 0 = claim after the round instead
    const next = boundsOf(b.index + 1, p);
    expect(preRoundClaimDue(next.windowStartsAt - 10_000, p, lead, b.index)?.index).toBe(next.index);
  });
  test("defaults to 90 s and never exceeds the window start", () => {
    const env = { SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: "https://api.devnet.solana.com", MONGODB_URI: "mongodb://x", REWARD_FUNDING_POLICY: "legacy_creator_fee_v1" };
    expect(loadConfig("api", env).feeCollection.leadMs).toBe(90_000);
    expect(loadConfig("api", { ...env, FEE_CLAIM_LEAD_SECONDS: "0" }).feeCollection.leadMs).toBe(0);
    expect(loadConfig("api", { ...env, FEE_CLAIM_LEAD_SECONDS: "3600" }).feeCollection.leadMs).toBe(loadConfig("api", env).schedule.windowStartMs);
  });
});
