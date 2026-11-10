import { sol, tokens } from "@/lib/format";

export function HowItWorks({ minBuy, buyerCount, holderCount, minHolderTokens, durationMin }: { minBuy: string; buyerCount: number; holderCount: number; minHolderTokens: string; durationMin: number }) {
  const holders = holderCount > 0;
  const steps = [
    { n: "01", t: "Buy at least " + sol(minBuy, 3) + " SOL", d: "Any buy of the token on its launch pool counts — direct or through an aggregator. Each wallet holds one place, set by its most recent qualifying buy." },
    { n: "02", t: "The final minute", d: `Every round lasts ${durationMin} minutes. Somewhere inside the last 60 seconds the engine takes its snapshot. The exact moment is drawn by a cryptographically secure random number and kept private until it happens.` },
    {
      n: "03",
      t: holders ? `The last ${buyerCount} buyers and ${holderCount} random holders share the reward` : `The last ${buyerCount} buyers share the reward`,
      d: holders
        ? `At the snapshot, the ${buyerCount} most recent unique qualifying buyers are paid — and ${holderCount} more wallets are drawn at random from everyone holding at least ${tokens(minHolderTokens)} tokens. All of them split the round's reward equally. Payouts are based on verified creator fee allocations; fees that cannot be verified on-chain are never paid out.`
        : `At the snapshot, the ${buyerCount} most recent unique qualifying buyers split the round's reward equally. Payouts are based on verified creator fee allocations; fees that cannot be verified on-chain are never paid out.`,
    },
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

export function Rules({ holderCount, minHolderTokens }: { holderCount: number; minHolderTokens: string }) {
  const holders = holderCount > 0;
  const items = [
    holders
      ? ["Buyers by order, holders by draw", "The buyer places are a deterministic function of on-chain buys at the snapshot slot — randomness decides when, never which buyers. The holder places are a random draw; its seed is stored with the round and published, so the draw can be re-run."]
      : ["Randomness decides when, never who", "Recipients are a deterministic function of on-chain buys at the snapshot slot. Anyone can verify them from the chain."],
    ...(holders
      ? [
          ["Holding is enough", `Hold at least ${tokens(minHolderTokens)} tokens (0.01% of the 1,000,000,000 supply) in your own wallet and you are in every round's holder draw — no buy needed. Every eligible wallet has the same chance, whatever its size. Tokens sitting in pools, vaults or other program accounts do not count.`],
          ["One payout per wallet per round", `A wallet paid as one of the round's last buyers is left out of that round's holder draw, so the ${holderCount} holder places always go to other wallets. If fewer than ${holderCount} holders are eligible, all of them are paid.`],
        ]
      : []),
    ["No qualifying buyers?", holders ? "Nothing is paid — to buyers or holders. The reward pool is preserved and carried into the next round." : "Nothing is paid. The reward pool is preserved and carried into the next round."],
    ["Creator fees, not volume", "Eligible creator fees are tracked and allocated for payouts: only fees the launch's on-chain configuration and positions allocate to the creator count — never the whole pool's fees, protocol or partner fees, or other liquidity providers' fees. Amounts are computed with the programs' own integer math and reconciled against on-chain accounts."],
    ["Sells never count", "Only confirmed buys qualify for the buyer places. Failed, dropped or forked-out transactions are excluded automatically."],
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
