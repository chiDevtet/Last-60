/**
 * Reward allocation — pure integer arithmetic on base units (lamports). No floating point.
 *
 *   rewardShare = floor(fees × rewardBps / 10_000)
 *   retained    = fees − rewardShare                  (the project's share, e.g. 25%)
 *   pool        = rewardShare + funding + rolloverIn
 *
 * `fees` are creator-allocated fees under the legacy policy (REWARD_PERCENTAGE applies to them).
 * `funding` is the sum of verified, reconciled Last-60 contributions under the phase-aware policy
 * (already the reward share by source-specific policy: REWARD_PERCENTAGE is NOT applied to it).
 *   per         = floor(pool / n)
 *   dust        = pool − per × n                      (deterministic, recorded, retained)
 *
 * If there are no recipients, or `per` is below the minimum payout (which must cover the
 * rent-exempt minimum so a transfer to an empty wallet cannot fail), nothing is paid and the
 * pool is either rolled into the next round or retained, per policy.
 *
 * Invariant (tested): fees + funding + rolloverIn = retained + dust + rolloverOut + retainedPool + per × n
 */
export interface AllocationInput {
  fees: bigint;
  /** Verified Last-60 contributions (phase-aware policy); default 0. */
  funding?: bigint;
  rolloverIn: bigint;
  rewardBps: number;
  recipients: string[];
  minPayout: bigint;
  skippedRoundPolicy: "rollover" | "retain";
}

export interface Allocation {
  fees: bigint;
  funding: bigint;
  rewardShare: bigint;
  retained: bigint;
  pool: bigint;
  rolloverIn: bigint;
  perRecipient: bigint;
  dust: bigint;
  rolloverOut: bigint;
  /** Pool retained (not rolled) because the round was skipped under the "retain" policy. */
  retainedPool: bigint;
  payouts: { recipient: string; amount: bigint; position: number }[];
  outcome: "paid" | "no_buyers" | "below_minimum" | "no_fees";
}

export function allocate(i: AllocationInput): Allocation {
  const funding = i.funding ?? 0n;
  if (i.fees < 0n || i.rolloverIn < 0n || funding < 0n) throw new Error("allocate: negative input");
  if (!Number.isInteger(i.rewardBps) || i.rewardBps <= 0 || i.rewardBps > 10_000) throw new Error("allocate: rewardBps out of range");
  if (new Set(i.recipients).size !== i.recipients.length) throw new Error("allocate: duplicate recipient");

  const rewardShare = (i.fees * BigInt(i.rewardBps)) / 10_000n;
  const retained = i.fees - rewardShare;
  const pool = rewardShare + funding + i.rolloverIn;
  const n = BigInt(i.recipients.length);
  const base = { fees: i.fees, funding, rewardShare, retained, pool, rolloverIn: i.rolloverIn };

  const skip = (outcome: Allocation["outcome"]): Allocation => ({
    ...base,
    perRecipient: 0n,
    dust: 0n,
    rolloverOut: i.skippedRoundPolicy === "rollover" ? pool : 0n,
    retainedPool: i.skippedRoundPolicy === "retain" ? pool : 0n,
    payouts: [],
    outcome,
  });

  if (pool === 0n) return skip("no_fees");
  if (n === 0n) return skip("no_buyers");
  const per = pool / n;
  if (per < i.minPayout) return skip("below_minimum");
  const dust = pool - per * n;
  return {
    ...base,
    perRecipient: per,
    dust,
    rolloverOut: 0n,
    retainedPool: 0n,
    payouts: i.recipients.map((recipient, position) => ({ recipient, amount: per, position })),
    outcome: "paid",
  };
}
