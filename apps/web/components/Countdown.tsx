"use client";
/**
 * The centerpiece. A five-segment ring (one segment per minute) that fills as the round elapses.
 * In the final 60 seconds the last segment — "the final arc" — lights up and the scene
 * intensifies as time runs out: scanner sweep, expanding pulses, rising glow.
 *
 * The countdown targets the ROUND END only. The client never receives the hidden execution
 * instant, so nothing here can reveal it.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CurrentRoundDTO, RewardPoolDTO, RoundSummaryDTO } from "@last60/shared";
import { AnimatedSol } from "./AnimatedNumber";
import { sol } from "@/lib/format";

const CX = 200;
const R = 168;
const STROKE = 12;
const GAP = 3.2;

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
const pt = (deg: number, r = R) => [CX + r * Math.cos(rad(deg)), CX + r * Math.sin(rad(deg))] as const;
function arc(a0: number, a1: number, r = R) {
  if (a1 - a0 <= 0.01) return "";
  const [x0, y0] = pt(a0, r);
  const [x1, y1] = pt(a1, r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Roll a stale snapshot forward locally so the clock never shows negative time. */
function useLocalRound(round: CurrentRoundDTO, now: number) {
  return useMemo(() => {
    const dur = round.durationSeconds * 1000;
    let startsAt = new Date(round.startsAt).getTime();
    let number = round.roundNumber;
    let rolled = false;
    while (now >= startsAt + dur) {
      startsAt += dur;
      number++;
      rolled = true;
    }
    const endsAt = startsAt + dur;
    const windowStart = endsAt - round.finalWindowSeconds * 1000;
    const serverPhase = rolled ? null : round.phase;
    const timePhase = now >= windowStart ? "final_minute" : "open";
    const phase = serverPhase && !["open", "final_minute"].includes(serverPhase) ? serverPhase : timePhase;
    return { number, startsAt, endsAt, windowStart, dur, phase, rolled };
  }, [round, now]);
}

export function Countdown({ round, pool, now, latest }: { round: CurrentRoundDTO; pool: RewardPoolDTO; now: number; latest: RoundSummaryDTO | null }) {
  const reduce = useReducedMotion();
  const r = useLocalRound(round, now);
  const remaining = Math.max(0, r.endsAt - now);
  const elapsed = 1 - remaining / r.dur;
  const finalMs = round.finalWindowSeconds * 1000;
  const inFinal = remaining <= finalMs && (r.phase === "final_minute" || r.phase === "open");
  const intensity = inFinal ? Math.min(1, 1 - remaining / finalMs) : 0;
  const settledHere = !r.rolled && round.settledRoundNumber === r.number && ["processing", "settled", "rolled_over", "awaiting_funds", "attention"].includes(r.phase);

  const mm = Math.floor(remaining / 60_000);
  const ss = Math.floor((remaining % 60_000) / 1000);
  const P = Math.min(360, elapsed * 360);

  // Announce phase changes to assistive tech (not every second).
  const [announce, setAnnounce] = useState("");
  const lastPhase = useRef<string>("");
  useEffect(() => {
    const key = `${r.number}:${inFinal ? "final" : r.phase}`;
    if (key === lastPhase.current) return;
    lastPhase.current = key;
    setAnnounce(inFinal ? `Round ${r.number}: final minute started.` : r.phase === "settled" ? `Round ${r.number} settled.` : `Round ${r.number} in progress.`);
  }, [r.number, r.phase, inFinal]);

  const segments = [0, 1, 2, 3, 4].map((i) => {
    const s = i * 72 + GAP / 2;
    const e = (i + 1) * 72 - GAP / 2;
    return { i, s, e, fillEnd: Math.min(e, Math.max(s, P)) };
  });
  const pulseEvery = 1.7 - intensity * 1.0;
  const label =
    r.phase === "processing"
      ? "Payout processing"
      : r.phase === "settled"
        ? "Round settled"
        : r.phase === "rolled_over"
          ? "Reward rolls to next round"
          : r.phase === "awaiting_funds"
            ? "Payouts queued"
            : r.phase === "attention"
              ? "Payouts under review"
              : inFinal
                ? "Final minute"
                : "Round closes in";

  return (
    <section aria-labelledby="round-heading" className="relative">
      <h2 id="round-heading" className="sr-only">
        Current round
      </h2>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div className="relative mx-auto aspect-square w-[min(86vw,440px)]">
        {/* ambient glow intensifies through the final minute */}
        <div
          aria-hidden
          className="absolute inset-[-18%] rounded-full blur-3xl transition-opacity duration-700"
          style={{
            background: `radial-gradient(circle, rgb(123 97 255 / ${0.1 + intensity * 0.28}) 0%, rgb(56 225 255 / ${0.04 + intensity * 0.12}) 38%, transparent 68%)`,
          }}
        />
        <svg viewBox="0 0 400 400" className="relative h-full w-full overflow-visible" role="timer" aria-label={`Round ${r.number}: ${mm} minutes ${ss} seconds remaining`}>
          <defs>
            <linearGradient id="cd-prog" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#1A9FCC" />
              <stop offset="1" stopColor="#38E1FF" />
            </linearGradient>
            <linearGradient id="cd-final" gradientUnits="userSpaceOnUse" x1={pt(288)[0]} y1={pt(288)[1]} x2={pt(360)[0]} y2={pt(360)[1]}>
              <stop offset="0" stopColor="#7B61FF" />
              <stop offset="1" stopColor="#38E1FF" />
            </linearGradient>
            <radialGradient id="cd-sweep" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform={`translate(${CX} ${CX}) scale(${R - 24})`}>
              <stop offset="0" stopColor="#38E1FF" stopOpacity="0" />
              <stop offset="1" stopColor="#38E1FF" stopOpacity="0.22" />
            </radialGradient>
            <filter id="cd-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="7" />
            </filter>
            <clipPath id="cd-inner">
              <circle cx={CX} cy={CX} r={R - 22} />
            </clipPath>
          </defs>

          {/* minute ticks */}
          {[0, 72, 144, 216, 288].map((a) => {
            const [x0, y0] = pt(a, R + 16);
            const [x1, y1] = pt(a, R + 24);
            return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke={a === 288 ? "#7B61FF" : "#2A3244"} strokeWidth={2} strokeLinecap="round" />;
          })}

          {/* track */}
          {segments.map((g) => (
            <path key={`t${g.i}`} d={arc(g.s, g.e)} stroke={g.i === 4 ? "rgb(123 97 255 / 0.22)" : "#1F2635"} strokeWidth={STROKE} fill="none" />
          ))}

          {/* scanner sweep (final minute only) */}
          {inFinal && !reduce && (
            <g clipPath="url(#cd-inner)" opacity={0.35 + intensity * 0.65}>
              <g className="scanner" style={{ ["--scan-duration" as string]: `${2.6 - intensity * 1.6}s` }}>
                <path d={`M${CX} ${CX} L${pt(-28, R)[0]} ${pt(-28, R)[1]} A${R} ${R} 0 0 1 ${pt(0, R)[0]} ${pt(0, R)[1]} Z`} fill="url(#cd-sweep)" />
              </g>
            </g>
          )}

          {/* progress */}
          {segments.map((g) =>
            g.fillEnd > g.s ? (
              <g key={`p${g.i}`}>
                {g.i === 4 && <path d={arc(g.s, g.fillEnd)} stroke="url(#cd-final)" strokeWidth={STROKE + 6} fill="none" filter="url(#cd-glow)" opacity={0.35 + intensity * 0.65} />}
                <path d={arc(g.s, g.fillEnd)} stroke={g.i === 4 ? "url(#cd-final)" : "url(#cd-prog)"} strokeWidth={STROKE} fill="none" />
              </g>
            ) : null,
          )}

          {/* expanding pulses in the final minute */}
          {inFinal && !reduce && (
            <motion.circle
              key={`pulse-${Math.round(pulseEvery * 10)}`}
              cx={CX}
              cy={CX}
              r={R}
              fill="none"
              stroke="#38E1FF"
              strokeWidth={2}
              initial={{ opacity: 0.55, scale: 1 }}
              animate={{ opacity: 0, scale: 1.16 }}
              transition={{ duration: pulseEvery, repeat: Infinity, ease: "easeOut" }}
              style={{ transformOrigin: "200px 200px" }}
            />
          )}

          {/* leading tick */}
          {P > 0.5 && P < 359.5 && (
            <g>
              <circle cx={pt(P)[0]} cy={pt(P)[1]} r={11} fill={inFinal ? "#38E1FF" : "#1A9FCC"} opacity={0.25} filter="url(#cd-glow)" />
              <circle cx={pt(P)[0]} cy={pt(P)[1]} r={6.5} fill="#D6FAFF" stroke="#07080C" strokeWidth={2} />
            </g>
          )}
        </svg>

        {/* center readout */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="eyebrow mb-3 flex items-center gap-2">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${inFinal ? "bg-signal live-dot" : "bg-series"}`} />
            Round <span className="tabular text-frost">#{r.number.toLocaleString()}</span>
          </div>
          <div
            className="tabular font-semibold leading-none tracking-tight transition-colors duration-500"
            style={{ fontSize: "clamp(56px, 17vw, 96px)", color: inFinal ? `color-mix(in oklab, #38E1FF ${40 + intensity * 60}%, #E9EDF5)` : "#E9EDF5", textShadow: inFinal ? `0 0 ${12 + intensity * 28}px rgb(56 225 255 / ${0.25 + intensity * 0.35})` : "none" }}
          >
            <span>{String(mm).padStart(2, "0")}</span>
            <span className={inFinal ? "opacity-80" : "opacity-40"}>:</span>
            <span className="relative inline-block overflow-hidden align-bottom">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span key={ss} className="inline-block" initial={reduce ? false : { y: "-35%", opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={reduce ? undefined : { y: "35%", opacity: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
                  {String(ss).padStart(2, "0")}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
          <div className={`mt-3 text-sm font-medium ${inFinal ? "text-signal" : "text-mist"}`}>{label}</div>
          {inFinal && <div className="mt-1 max-w-[15rem] text-xs text-mist">The payout can trigger at any moment before the clock reaches zero.</div>}
          {settledHere && latest && latest.roundNumber === r.number && (
            <div className="mt-2 text-xs text-mist">
              {latest.recipientCount > 0 ? `${sol(latest.perRecipient)} SOL × ${latest.recipientCount} wallets` : "No qualifying buyers"}
            </div>
          )}
        </div>
      </div>

      {/* round facts */}
      <dl className="mx-auto mt-8 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Reward pool">
          <AnimatedSol lamports={pool.periodReward} /> <span className="text-mist text-sm">SOL</span>
        </Fact>
        <Fact label="Qualifying buyers">
          <span className="tabular">{round.qualifyingBuyers}</span>
        </Fact>
        <Fact label="Minimum buy">
          {sol(round.minBuy, 3)} <span className="text-mist text-sm">SOL</span>
        </Fact>
        <Fact label="Recipients per round">
          <span>Last {round.buyerCount}</span>
        </Fact>
      </dl>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card px-4 py-3">
      <dt className="text-xs text-mist">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{children}</dd>
    </div>
  );
}
