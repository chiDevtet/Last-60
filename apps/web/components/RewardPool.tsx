"use client";
import type { RewardPoolDTO } from "@last60/shared";
import { AnimatedSol } from "./AnimatedNumber";

export function RewardPool({ pool }: { pool: RewardPoolDTO }) {
  const fees = BigInt(pool.periodFees || "0");
  const share = fees === 0n ? 0 : Number((BigInt(pool.periodReward) - BigInt(pool.rolloverIn)) * 10_000n / fees) / 100;
  return (
    <div className="card p-5 sm:p-6">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Live reward pool</h3>
        <span className="eyebrow">this period</span>
      </div>
      <div className="mt-4">
        <div className="text-xs text-mist">Eligible creator fees since the last payout</div>
        <div className="mt-1 text-4xl font-semibold tracking-tight">
          <AnimatedSol lamports={pool.periodFees} max={5} /> <span className="text-lg font-normal text-mist">SOL</span>
        </div>
      </div>
      {/* one whole split into two parts: thin segmented bar */}
      <div className="mt-5 flex h-2 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Split between the reward for buyers and holders and the retained amount">
        <div className="h-full rounded-full bg-series" style={{ width: `${share}%` }} />
        <div className="h-full flex-1 rounded-full bg-slate" />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="flex items-center gap-1.5 text-mist"><span className="h-2 w-2 rounded-sm bg-series" aria-hidden />To buyers &amp; holders</dt>
          <dd className="mt-0.5 text-lg font-semibold"><AnimatedSol lamports={pool.periodReward} /> <span className="text-sm font-normal text-mist">SOL</span></dd>
          {BigInt(pool.rolloverIn) > 0n && <dd className="text-xs text-mist">incl. <AnimatedSol lamports={pool.rolloverIn} /> rolled over</dd>}
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-mist"><span className="h-2 w-2 rounded-sm bg-slate" aria-hidden />Retained</dt>
          <dd className="mt-0.5 text-lg font-semibold"><AnimatedSol lamports={pool.periodRetained} /> <span className="text-sm font-normal text-mist">SOL</span></dd>
        </div>
      </dl>
      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4 text-sm">
        <div><div className="text-xs text-mist">Waiting to be paid</div><div className="mt-0.5 font-semibold"><AnimatedSol lamports={pool.pendingPayouts} /></div></div>
        <div><div className="text-xs text-mist">Paid, last 24h</div><div className="mt-0.5 font-semibold"><AnimatedSol lamports={pool.distributed24h} /></div></div>
        <div><div className="text-xs text-mist">Paid, all time</div><div className="mt-0.5 font-semibold"><AnimatedSol lamports={pool.totalDistributed} /></div></div>
      </div>
    </div>
  );
}
