"use client";
import { useState } from "react";
import type { RoundDetailDTO, RoundSummaryDTO } from "@last60/shared";
import { PUBLIC_API_URL } from "@/lib/config";
import { accountUrl, txUrl } from "@/lib/explorer";
import { dateTime, shortAddress, sol } from "@/lib/format";
import { StatusPill } from "./StatusPill";

export function PayoutHistory({ initial, explorer, cluster }: { initial: RoundSummaryDTO[]; explorer: string; cluster: string }) {
  const [older, setOlder] = useState<RoundSummaryDTO[]>([]);
  const [cursor, setCursor] = useState<string | null>(initial.length ? String(initial[initial.length - 1]!.roundNumber) : null);
  const [details, setDetails] = useState<Record<number, RoundDetailDTO | "loading">>({});
  const [busy, setBusy] = useState(false);
  // live rows first, then any older pages (dedupe by round number)
  const seen = new Set(initial.map((r) => r.roundNumber));
  const rows = [...initial, ...older.filter((r) => !seen.has(r.roundNumber))];

  async function toggle(n: number) {
    if (details[n]) {
      setDetails(({ [n]: _, ...rest }) => rest);
      return;
    }
    setDetails((d) => ({ ...d, [n]: "loading" }));
    const res = await fetch(`${PUBLIC_API_URL}/api/v1/rounds/${n}`);
    if (res.ok) {
      const body = (await res.json()) as RoundDetailDTO;
      setDetails((d) => ({ ...d, [n]: body }));
    } else setDetails(({ [n]: _, ...rest }) => rest);
  }

  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/v1/rounds?cursor=${cursor}&limit=20`);
      const body = await res.json();
      setOlder((o) => [...o, ...body.items]);
      setCursor(body.nextCursor);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="hidden grid-cols-[88px_1.2fr_1fr_1fr_88px_110px_28px] gap-3 border-b border-line px-5 py-3 text-xs text-mist md:grid">
        <span>Round</span>
        <span>Settled</span>
        <span className="text-right">Fees accrued</span>
        <span className="text-right">Reward pool</span>
        <span className="text-right">Wallets</span>
        <span>Status</span>
        <span />
      </div>
      {!rows.length && <div className="px-5 py-10 text-center text-sm text-mist">No rounds have settled yet. History appears here as soon as the first round completes.</div>}
      <ul>
        {rows.map((r) => {
          const d = details[r.roundNumber];
          const open = !!d;
          return (
            <li key={r.roundNumber} className="border-b border-line/70 last:border-0">
              <button
                onClick={() => toggle(r.roundNumber)}
                aria-expanded={open}
                className="focus-ring grid w-full grid-cols-[1fr_auto] items-center gap-3 px-5 py-3.5 text-left text-sm transition-colors hover:bg-white/[0.02] md:grid-cols-[88px_1.2fr_1fr_1fr_88px_110px_28px]"
              >
                <span className="font-semibold tabular">#{r.roundNumber.toLocaleString()}</span>
                <span className="hidden text-mist md:block">{dateTime(r.settledAt ?? r.endsAt)}</span>
                <span className="hidden text-right tabular md:block">{sol(r.fees, 5)}</span>
                <span className="text-right tabular md:text-right">
                  <span className="font-semibold">{sol(r.reward, 4)}</span> <span className="text-mist">SOL</span>
                </span>
                <span className="hidden text-right tabular md:block">{r.recipientCount}</span>
                <span className="hidden md:block">
                  <StatusPill status={r.dryRun && r.phase === "settled" ? "simulated" : r.phase} />
                </span>
                <span className="hidden text-mist md:block" aria-hidden>
                  {open ? "−" : "+"}
                </span>
              </button>
              {open && (
                <div className="bg-black/20 px-5 pb-4 pt-1">
                  {d === "loading" ? (
                    <div className="py-3 text-sm text-mist">Loading…</div>
                  ) : (
                    <RoundBreakdown d={d} explorer={explorer} cluster={cluster} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {cursor && rows.length >= 12 && (
        <div className="border-t border-line p-3 text-center">
          <button onClick={more} disabled={busy} className="focus-ring rounded-lg px-3 py-1.5 text-sm text-mist hover:text-frost disabled:opacity-50">
            {busy ? "Loading…" : "Load older rounds"}
          </button>
        </div>
      )}
    </div>
  );
}

function RoundBreakdown({ d, explorer, cluster }: { d: RoundDetailDTO; explorer: string; cluster: string }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 pt-2 text-xs text-mist sm:grid-cols-4">
        <div>Fees accrued <span className="block text-sm text-frost tabular">{sol(d.fees, 6)} SOL</span></div>
        <div>Reward ({d.rewardBps / 100}%){BigInt(d.rolloverIn) > 0n ? " + rollover" : ""} <span className="block text-sm text-frost tabular">{sol(d.reward, 6)} SOL</span></div>
        <div>Retained <span className="block text-sm text-frost tabular">{sol(d.retained, 6)} SOL</span></div>
        <div>Snapshot slot <span className="block text-sm text-frost tabular">{d.snapshotSlot?.toLocaleString() ?? "—"}</span></div>
      </dl>
      {d.payouts.length === 0 ? (
        <p className="text-sm text-mist">{BigInt(d.rolloverOut) > 0n ? `No payouts this round — ${sol(d.rolloverOut)} SOL carried into the next round.` : "No payouts this round."}</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Payouts for round {d.roundNumber}</caption>
          <thead>
            <tr className="text-left text-xs text-mist">
              <th className="py-1.5 font-normal">Recipient</th>
              <th className="py-1.5 text-right font-normal">Amount</th>
              <th className="hidden py-1.5 pl-4 font-normal sm:table-cell">Transaction</th>
              <th className="py-1.5 pl-4 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {d.payouts.map((p) => (
              <tr key={p.recipient} className="border-t border-line/60">
                <td className="py-2">
                  <a href={accountUrl(explorer, p.recipient, cluster)} target="_blank" rel="noreferrer" className="focus-ring font-mono text-[13px] hover:text-signal">
                    {shortAddress(p.recipient, 4, 4)}
                  </a>
                </td>
                <td className="py-2 text-right tabular">{sol(p.amount, 6)} SOL</td>
                <td className="hidden py-2 pl-4 sm:table-cell">
                  {p.signature ? (
                    <a href={txUrl(explorer, p.signature, cluster)} target="_blank" rel="noreferrer" className="focus-ring font-mono text-[12px] text-mist underline decoration-dotted underline-offset-4 hover:text-signal">
                      {shortAddress(p.signature, 6, 6)} ↗
                    </a>
                  ) : (
                    <span className="text-xs text-dim">{p.state === "simulated" ? "not sent (dry-run)" : "awaiting confirmation"}</span>
                  )}
                </td>
                <td className="py-2 pl-4">
                  <StatusPill status={p.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.dryRun && <p className="text-xs text-mist">Dry-run round: allocations were computed from live chain data; no transfers were sent.</p>}
    </div>
  );
}
