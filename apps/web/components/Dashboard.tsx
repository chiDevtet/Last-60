"use client";
import type { DashboardSnapshotDTO, TerminalEventDTO } from "@last60/shared";
import { useLive, useNow } from "@/lib/useLive";
import { Countdown } from "./Countdown";
import { TokenCA } from "./TokenCA";
import { Header } from "./Header";
import { LiveBuys } from "./LiveBuys";
import { PayoutHistory } from "./PayoutHistory";
import { RewardPool } from "./RewardPool";
import { Stats } from "./Stats";
import { Terminal } from "./Terminal";
import { HowItWorks, Rules } from "./HowItWorks";
import { Footer } from "./Footer";

export function Dashboard({ initial, initialTerminal, tradeUrl }: { initial: DashboardSnapshotDTO | null; initialTerminal: TerminalEventDTO[]; tradeUrl: string | null }) {
  const { snapshot, terminal, conn, offsetMs, prependOlder } = useLive(initial, initialTerminal);
  const now = useNow(offsetMs, 8);

  if (!snapshot) {
    return (
      <>
        <Header conn={conn} cluster="—" provider="—" tradeUrl={tradeUrl} />
        <main className="mx-auto flex min-h-[70vh] max-w-7xl flex-col items-center justify-center px-4 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon-dark.svg" alt="" className="h-16 w-16 opacity-80" />
          <h1 className="mt-6 text-xl font-semibold">Connecting to the reward engine…</h1>
          <p className="mt-2 max-w-md text-sm text-mist">The dashboard is waiting for the Asteroid Protocol API. Rewards keep running on the backend regardless of this page.</p>
        </main>
      </>
    );
  }
  const { round, pool, stats, recentBuys, recentRounds, chart, meta } = snapshot;
  const latest = recentRounds[0] ?? null;

  return (
    <>
      <Header conn={conn} cluster={meta.cluster} provider={meta.provider} tradeUrl={tradeUrl} />
      {meta.payoutMode === "dry_run" && (
        <div className="border-b border-line bg-white/[0.03]">
          <p className="mx-auto max-w-7xl px-4 py-2 text-center text-xs text-mist sm:px-6">
            <span className="mr-2 rounded border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-frost">DRY-RUN</span>
            Rounds, snapshots and allocations run on live chain data, but no transfers are sent. Simulated payouts are labelled as such.
          </p>
        </div>
      )}
      {meta.poolStatus !== "bonding" && meta.poolStatus !== "unknown" && (
        <div className="border-b border-warn/20 bg-warn/10">
          <p className="mx-auto max-w-7xl px-4 py-2 text-center text-xs text-warn sm:px-6">
            The launch pool has {meta.poolStatus === "migrated" ? "graduated" : "completed its curve"}. Post-graduation activity is tracked once the destination pool has been verified on-chain.
          </p>
        </div>
      )}
      <main>
        <section id="round" className="relative overflow-hidden">
          <div className="bg-grid pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-12 sm:px-6 sm:pt-16">
            <div className="mx-auto mb-10 max-w-2xl text-center">
              <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">The final minute pays.</h1>
              <p className="mx-auto mt-4 max-w-xl text-base text-mist sm:text-lg">
                Every {round.durationSeconds / 60} minutes, eligible creator fees are allocated to payouts for the last {round.buyerCount} unique buyers — paid on-chain at a moment inside the final 60 seconds.
              </p>
            </div>
            <Countdown round={round} pool={pool} now={now} latest={latest} />
            <TokenCA mint={meta.tokenMint} />
          </div>
        </section>

        <section id="activity" className="mx-auto max-w-7xl px-4 sm:px-6" aria-label="Live activity">
          <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
            <RewardPool pool={pool} />
            <LiveBuys buys={recentBuys} now={now} explorer={meta.explorer} cluster={meta.cluster} minBuy={round.minBuy} />
          </div>
          <div className="mt-4">
            <SectionTitle eyebrow="Engine" title="Live reward engine" sub="Every line is a real backend event: indexed buys, fee accruals, payout submissions and confirmations." />
            <Terminal events={terminal} explorer={meta.explorer} cluster={meta.cluster} onOlder={prependOlder} live={conn === "live"} />
          </div>
        </section>

        <section id="stats" className="mx-auto mt-20 max-w-7xl px-4 sm:px-6">
          <SectionTitle eyebrow="Totals" title="Paid & waiting" />
          <Stats stats={stats} chart={chart} dryRun={meta.payoutMode === "dry_run"} />
        </section>

        <section id="history" className="mx-auto mt-20 max-w-7xl px-4 sm:px-6">
          <SectionTitle eyebrow="History" title="Payout history" sub="Expand a round to see each recipient, amount and transaction." />
          <PayoutHistory initial={recentRounds} explorer={meta.explorer} cluster={meta.cluster} />
        </section>

        <section id="how" className="mx-auto mt-20 max-w-7xl px-4 sm:px-6">
          <SectionTitle eyebrow="Mechanics" title="How it works" />
          <HowItWorks minBuy={round.minBuy} buyerCount={round.buyerCount} durationMin={round.durationSeconds / 60} />
          <div className="card mt-4 p-6">
            <Rules />
          </div>
        </section>
      </main>
      <Footer mint={meta.tokenMint} pool={meta.poolAddress} explorer={meta.explorer} cluster={meta.cluster} />
    </>
  );
}

function SectionTitle({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
      </div>
      {sub && <p className="max-w-md text-sm text-mist sm:text-right">{sub}</p>}
    </div>
  );
}
