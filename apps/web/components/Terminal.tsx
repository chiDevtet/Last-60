"use client";
/**
 * Live engine log. Every line is a real backend event from /api/v1/stream — nothing here is
 * simulated client-side. Events never contain scheduling internals (enforced server-side).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TerminalEventDTO, TerminalEventType } from "@last60/shared";
import { PUBLIC_API_URL } from "@/lib/config";
import { txUrl } from "@/lib/explorer";
import { clockTime, shortAddress } from "@/lib/format";

const TYPE_STYLE: Record<TerminalEventType, string> = {
  SYSTEM: "text-frost",
  INDEXER: "text-series",
  BUY: "text-signal",
  FEES: "text-[#A897FF]",
  ACCOUNTING: "text-[#A897FF]",
  PAYOUT: "text-signal",
  CONFIRMED: "text-good",
  WARN: "text-warn",
  ERROR: "text-bad",
};
const FILTERS: { key: string; label: string; types: TerminalEventType[] | null }[] = [
  { key: "all", label: "All", types: null },
  { key: "buys", label: "Buys", types: ["BUY"] },
  { key: "payouts", label: "Payouts", types: ["PAYOUT", "CONFIRMED", "ACCOUNTING"] },
  { key: "system", label: "System", types: ["SYSTEM", "INDEXER", "FEES", "WARN", "ERROR"] },
];

export function Terminal({ events, explorer, cluster, onOlder, live }: { events: TerminalEventDTO[]; explorer: string; cluster: string; onOlder: (e: TerminalEventDTO[]) => void; live: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)?.types;
    return f ? events.filter((e) => f.includes(e.type)) : events;
  }, [events, filter]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [shown, stick]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  async function loadOlder() {
    if (!events.length || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/v1/terminal?before=${events[0]!.seq}&limit=100`);
      const body = await res.json();
      if (!body.items.length) setExhausted(true);
      const el = scroller.current;
      const before = el?.scrollHeight ?? 0;
      onOlder(body.items);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    } finally {
      setLoading(false);
    }
  }

  const toggle = (seq: number) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(seq)) n.delete(seq);
      else n.add(seq);
      return n;
    });

  return (
    <div className="card flex h-[460px] flex-col overflow-hidden bg-[#090B10]">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 font-mono text-xs text-mist">
          <span className={`h-2 w-2 rounded-full ${live ? "bg-good live-dot" : "bg-dim"}`} aria-hidden />
          <span className="text-frost">reward-engine</span>
          <span className="text-dim">·</span>
          <span>{live ? "live" : "reconnecting"}</span>
        </div>
        <div role="tablist" aria-label="Filter log" className="ml-auto flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`focus-ring rounded-md px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${filter === f.key ? "bg-slate text-frost" : "text-mist hover:text-frost"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={scroller} className="terminal-scroll relative flex-1 overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-6" role="log" aria-live="off" aria-label="Reward engine activity">
        <div className="mb-2 flex justify-center">
          {exhausted ? (
            <span className="text-[11px] text-dim">— beginning of retained history —</span>
          ) : (
            <button onClick={loadOlder} disabled={loading || !events.length} className="focus-ring rounded px-2 text-[11px] text-dim hover:text-mist disabled:opacity-50">
              {loading ? "loading…" : "↑ load older entries"}
            </button>
          )}
        </div>
        {!shown.length && <div className="text-dim">Waiting for engine activity…</div>}
        {shown.map((e) => {
          const hasDetails = !!e.details && Object.keys(e.details).length > 0;
          const isOpen = open.has(e.seq);
          return (
            <div key={e.seq} className="group">
              <div className="flex gap-3">
                <span className="shrink-0 text-dim tabular">[{clockTime(e.ts)}]</span>
                <span className={`shrink-0 font-semibold ${TYPE_STYLE[e.type]}`}>{e.type}:</span>
                <span className="min-w-0 flex-1 break-words text-[#C9CFDB]">
                  {e.message}
                  {e.signature && (
                    <a href={txUrl(explorer, e.signature, cluster)} target="_blank" rel="noreferrer" className="focus-ring ml-2 text-dim underline decoration-dotted underline-offset-4 hover:text-signal">
                      {shortAddress(e.signature, 4, 4)} ↗
                    </a>
                  )}
                  {hasDetails && (
                    <button onClick={() => toggle(e.seq)} aria-expanded={isOpen} className="focus-ring ml-2 text-dim hover:text-mist">
                      {isOpen ? "[−]" : "[+]"}
                    </button>
                  )}
                </span>
              </div>
              {isOpen && hasDetails && (
                <div className="mb-1 ml-[7.5rem] border-l border-line pl-3 text-[11.5px] text-mist">
                  {Object.entries(e.details!).map(([k, v]) => (
                    <div key={k}>
                      <span className="text-dim">{k}</span> = <span className="break-all">{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!stick && (
        <div className="flex justify-center border-t border-line py-1.5">
          <button
            onClick={() => {
              setStick(true);
              if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
            }}
            className="focus-ring font-mono text-[11px] text-mist hover:text-frost"
          >
            ↓ jump to latest
          </button>
        </div>
      )}
    </div>
  );
}
