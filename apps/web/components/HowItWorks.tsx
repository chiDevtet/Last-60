import { formatBps } from "@last60/shared";
import { sol } from "@/lib/format";

export function HowItWorks({ minBuy, buyerCount, rewardBps, durationMin }: { minBuy: string; buyerCount: number; rewardBps: number; durationMin: number }) {
  const steps = [
    { n: "01", t: "Buy at least " + sol(minBuy, 3) + " SOL", d: "Any buy of the token on its launch pool counts — direct or through an aggregator. Each wallet holds one place, set by its most recent qualifying buy." },
    { n: "02", t: "The final minute", d: `Every round lasts ${durationMin} minutes. Somewhere inside the last 60 seconds the engine takes its snapshot. The exact moment is drawn by a cryptographically secure random number and kept private until it happens.` },
    { n: "03", t: `The last ${buyerCount} buyers share ${formatBps(rewardBps)}%`, d: `At the snapshot, the ${buyerCount} most recent unique qualifying buyers split ${formatBps(rewardBps)}% of the round's eligible trading fees equally. The remaining ${formatBps(10_000 - rewardBps)}% is retained.` },
    { n: "04", t: "Paid on-chain, verifiable", d: "Each recipient gets an individual transfer, recorded only once it is final on Solana. Every payout links to its transaction on Solscan." },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {steps.map((s) => (
        <div key={s.n} className="card p-5">
          <div className="font-mono text-xs text-series">{s.n}</div>
          <h3 className="mt-3 text-base font-semibold">{s.t}</h3>
          <p className="mt-2 text-sm leading-relaxed text-mist">{s.d}</p>
        </div>
      ))}
    </div>
  );
}

export function Rules() {
  const items = [
    ["Randomness decides when, never who", "Recipients are a deterministic function of on-chain buys at the snapshot slot. Anyone can verify them from the chain."],
    ["No qualifying buyers?", "Nothing is paid. The reward pool is preserved and carried into the next round."],
    ["Fees, not volume", "Only trading fees actually attributable to the project's fee share are distributed, computed with the launch program's own integer math and reconciled against on-chain fee accounts."],
    ["Sells never count", "Only confirmed buys qualify. Failed, dropped or forked-out transactions are excluded automatically."],
  ];
  return (
    <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      {items.map(([t, d]) => (
        <div key={t}>
          <dt className="text-sm font-semibold">{t}</dt>
          <dd className="mt-1 text-sm leading-relaxed text-mist">{d}</dd>
        </div>
      ))}
    </dl>
  );
}
