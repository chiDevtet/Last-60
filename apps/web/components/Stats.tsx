"use client";
import { useMemo, useState } from "react";
import type { FeeChartPointDTO, StatsDTO } from "@last60/shared";
import { AnimatedInt, AnimatedSol } from "./AnimatedNumber";
import { lamportsToFloat, sol } from "@/lib/format";

export function Stats({ stats, chart, dryRun }: { stats: StatsDTO; chart: FeeChartPointDTO[]; dryRun?: boolean }) {
  return (
    <>
    {dryRun && <p className="mb-3 text-xs text-mist">Dry-run: simulated payouts are never counted as paid. Paid totals only include transfers confirmed on-chain.</p>}
    <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
      <dl className="grid grid-cols-2 gap-3">
        <Tile label="Total fees accrued" value={<AnimatedSol lamports={stats.totalFeesAccrued} />} unit="SOL" />
        <Tile label="Total paid to buyers" value={<AnimatedSol lamports={stats.totalPaid} />} unit="SOL" />
        <Tile label="Waiting to be paid" value={<AnimatedSol lamports={stats.totalPending} />} unit="SOL" />
        <Tile label="Current reward allocation" value={<AnimatedSol lamports={stats.currentReward} />} unit="SOL" />
        <Tile label="Payouts made" value={<AnimatedInt value={stats.payoutCount} />} />
        <Tile label="Unique recipient wallets" value={<AnimatedInt value={stats.uniqueRecipients} />} />
      </dl>
      <RoundsChart data={chart} />
    </div>
    </>
  );
}

function Tile({ label, value, unit }: { label: string; value: React.ReactNode; unit?: string }) {
  return (
    <div className="card px-4 py-4">
      <dt className="text-xs text-mist">{label}</dt>
      <dd className="mt-1.5 text-2xl font-semibold tracking-tight">
        {value} {unit && <span className="text-sm font-normal text-mist">{unit}</span>}
      </dd>
    </div>
  );
}

/** Nice tick step for a max value. */
function niceStep(max: number, ticks = 3) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

/**
 * Reward pool per round — single series column chart (no legend: the title names it).
 * Specs: columns ≤ 24px, 4px rounded data-end, square at the baseline, 2px gaps, hairline grid,
 * per-column hover/focus tooltip, table view.
 */
function RoundsChart({ data }: { data: FeeChartPointDTO[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 560;
  const H = 220;
  const pad = { l: 44, r: 8, t: 12, b: 26 };
  const values = data.map((d) => lamportsToFloat(d.reward));
  const max = Math.max(...values, 0);
  const step = niceStep(max || 1);
  const top = Math.max(step, Math.ceil((max || 1) / step) * step);
  const band = (W - pad.l - pad.r) / Math.max(data.length, 1);
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const ticks = useMemo(() => Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step), [top, step]);
  const fmtTick = (v: number) => (v === 0 ? "0" : v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(2) : v.toLocaleString(undefined, { maximumFractionDigits: 1 }));

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold">Reward pool per round</h3>
          <p className="text-xs text-mist">SOL allocated to buyers, last {data.length || 0} executed rounds</p>
        </div>
        <button onClick={() => setTable((t) => !t)} className="focus-ring rounded px-2 py-1 text-xs text-mist hover:text-frost" aria-pressed={table}>
          {table ? "Chart" : "Table"}
        </button>
      </div>
      {!data.length ? (
        <div className="flex h-[220px] items-center justify-center text-sm text-mist">Chart fills in as rounds execute.</div>
      ) : table ? (
        <div className="terminal-scroll mt-3 max-h-[220px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-mist">
                <th className="py-1 font-normal">Round</th>
                <th className="py-1 text-right font-normal">Fees (SOL)</th>
                <th className="py-1 text-right font-normal">Reward (SOL)</th>
                <th className="py-1 text-right font-normal">Wallets</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {[...data].reverse().map((d) => (
                <tr key={d.roundNumber} className="border-t border-line/60">
                  <td className="py-1.5">#{d.roundNumber}</td>
                  <td className="py-1.5 text-right">{sol(d.fees, 6)}</td>
                  <td className="py-1.5 text-right">{sol(d.reward, 6)}</td>
                  <td className="py-1.5 text-right">{d.recipients}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative mt-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Reward pool per round for rounds ${data[0]!.roundNumber} to ${data[data.length - 1]!.roundNumber}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="rgb(148 163 184 / 0.12)" strokeWidth={1} />
                <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-mist tabular" fontSize={10}>
                  {fmtTick(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const v = values[i]!;
              const x = pad.l + i * band + (band - bw) / 2;
              const h = Math.max(0, y(0) - y(v));
              const r = Math.min(4, h, bw / 2);
              const path = h <= 0 ? "" : `M${x} ${y(0)} V${y(v) + r} Q${x} ${y(v)} ${x + r} ${y(v)} H${x + bw - r} Q${x + bw} ${y(v)} ${x + bw} ${y(v) + r} V${y(0)} Z`;
              const active = hover === i;
              return (
                <g key={d.roundNumber} tabIndex={0} role="button" aria-label={`Round ${d.roundNumber}: ${sol(d.reward, 6)} SOL to ${d.recipients} wallets`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} className="outline-none">
                  <rect x={pad.l + i * band} y={pad.t} width={band} height={H - pad.t - pad.b} fill="transparent" />
                  {path && <path d={path} fill={active ? "#3DB6E0" : "#1A9FCC"} opacity={hover === null || active ? 1 : 0.55} />}
                  {d.recipients === 0 && <line x1={x} x2={x + bw} y1={y(0) - 1} y2={y(0) - 1} stroke="#5C6478" strokeWidth={2} />}
                </g>
              );
            })}
            <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="rgb(148 163 184 / 0.3)" strokeWidth={1} />
            {[0, data.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
              <text key={i} x={pad.l + i * band + band / 2} y={H - 8} textAnchor="middle" className="fill-mist tabular" fontSize={10}>
                #{data[i]!.roundNumber}
              </text>
            ))}
          </svg>
          {hover !== null && data[hover] && (
            <div className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-line-strong bg-graphite px-3 py-2 text-xs shadow-xl" style={{ left: `${((pad.l + hover * band + band / 2) / W) * 100}%`, top: 0 }}>
              <div className="text-base font-semibold text-frost">{sol(data[hover]!.reward, 6)} SOL</div>
              <div className="text-mist">Round #{data[hover]!.roundNumber} · {data[hover]!.recipients} wallets</div>
              <div className="text-mist">Fees {sol(data[hover]!.fees, 6)} SOL</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
