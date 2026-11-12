/**
 * Clock-anchored round arithmetic. Rounds are a pure function of wall-clock time, so execution
 * latency, restarts and crashes can never make the schedule drift.
 *
 *   index(t) = floor((t − anchor) / duration)
 *   number   = index − genesisIndex + 1
 */
export interface ScheduleParams {
  roundDurationMs: number;
  windowStartMs: number;
  windowDurationMs: number;
  anchorEpochMs: number;
}

export interface RoundBounds {
  index: number;
  startsAt: number;
  endsAt: number;
  windowStartsAt: number;
  windowEndsAt: number;
}

export function roundIndexAt(t: number, p: ScheduleParams): number {
  return Math.floor((t - p.anchorEpochMs) / p.roundDurationMs);
}

export function boundsOf(index: number, p: ScheduleParams): RoundBounds {
  const startsAt = p.anchorEpochMs + index * p.roundDurationMs;
  const windowStartsAt = startsAt + p.windowStartMs;
  return {
    index,
    startsAt,
    endsAt: startsAt + p.roundDurationMs,
    windowStartsAt,
    windowEndsAt: windowStartsAt + p.windowDurationMs,
  };
}

/**
 * Picks the private execution instant. Uniform over the window; if we are already inside the
 * window (worker started late) it is uniform over the *remaining* part, never in the past.
 */
export function drawExecuteAt(b: RoundBounds, now: number, randomInt: (min: number, max: number) => number): { executeAt: number; late: boolean } {
  const from = Math.max(b.windowStartsAt, now);
  if (from >= b.windowEndsAt) return { executeAt: b.windowEndsAt - 1, late: true };
  const offset = randomInt(0, b.windowEndsAt - from); // [0, remaining)
  return { executeAt: from + offset, late: from > b.windowStartsAt };
}

/**
 * The pre-round fee claim: due once per round, from `leadMs` before the execution window opens until it
 * opens, so what was claimed (and its 75 % settlement) is final before the round can execute.
 */
export function preRoundClaimDue(now: number, p: ScheduleParams, leadMs: number, lastClaimedIndex: number | null): RoundBounds | null {
  if (leadMs <= 0) return null;
  const b = boundsOf(roundIndexAt(now, p), p);
  if (b.index === lastClaimedIndex || now < b.windowStartsAt - leadMs || now >= b.windowStartsAt) return null;
  return b;
}
