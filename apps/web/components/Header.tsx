import type { ConnState } from "@/lib/useLive";

const PROVIDER_LABEL: Record<string, string> = { meteora_dbc: "Meteora DBC", raydium_launchlab: "Raydium LaunchLab", mock: "Mock provider" };

export function Header({ conn, cluster, provider, tradeUrl }: { conn: ConnState; cluster: string; provider: string; tradeUrl?: string | null }) {
  const live = conn === "live";
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-void/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <a href="/" className="focus-ring flex items-center" aria-label="LAST60 home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-dark.svg" alt="LAST60" className="h-[22px] w-auto" />
        </a>
        <nav aria-label="Sections" className="hidden items-center gap-5 text-sm text-mist md:flex">
          <a className="focus-ring hover:text-frost" href="#round">Round</a>
          <a className="focus-ring hover:text-frost" href="#activity">Activity</a>
          <a className="focus-ring hover:text-frost" href="#stats">Paid &amp; waiting</a>
          <a className="focus-ring hover:text-frost" href="#history">History</a>
          <a className="focus-ring hover:text-frost" href="#how">How it works</a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-mist sm:inline">{PROVIDER_LABEL[provider] ?? provider}</span>
          <span className="rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-mist">{cluster}</span>
          <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${live ? "border-good/30 text-good" : "border-warn/30 text-warn"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-good live-dot" : "bg-warn"}`} aria-hidden />
            {live ? "Live" : conn === "connecting" ? "Connecting" : "Reconnecting"}
          </span>
          {tradeUrl && (
            <a href={tradeUrl} target="_blank" rel="noreferrer" className="focus-ring hidden rounded-full bg-frost px-3.5 py-1.5 text-sm font-semibold text-void transition-colors hover:bg-white sm:inline">
              Buy
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
