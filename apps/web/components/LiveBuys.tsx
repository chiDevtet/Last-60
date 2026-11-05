"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { BuyDTO } from "@last60/shared";
import { accountUrl, txUrl } from "@/lib/explorer";
import { relative, shortAddress, sol } from "@/lib/format";

/** Live stream of buys. Deliberately never labels anyone as "selected" before a payout. */
export function LiveBuys({ buys, now, explorer, cluster, minBuy }: { buys: BuyDTO[]; now: number; explorer: string; cluster: string; minBuy: string }) {
  const reduce = useReducedMotion();
  return (
    <div className="card flex h-[460px] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">Recent buys</h3>
        <span className="text-xs text-mist">qualifies at ≥ {sol(minBuy, 3)} SOL</span>
      </div>
      <ul className="terminal-scroll flex-1 overflow-y-auto" aria-live="polite" aria-relevant="additions">
        {!buys.length && <li className="px-4 py-6 text-sm text-mist">No buys indexed yet.</li>}
        <AnimatePresence initial={false}>
          {buys.map((b) => (
            <motion.li
              key={`${b.signature}`}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: -8, backgroundColor: "rgba(56,225,255,0.10)" }}
              animate={{ opacity: 1, y: 0, backgroundColor: "rgba(56,225,255,0)" }}
              transition={{ duration: 0.6 }}
              className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 text-sm"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${b.qualifies ? "bg-signal" : "bg-dim"}`} aria-hidden />
              <a href={accountUrl(explorer, b.wallet, cluster)} target="_blank" rel="noreferrer" className="focus-ring font-mono text-[13px] text-frost hover:text-signal">
                {shortAddress(b.wallet, 4, 4)}
              </a>
              <span className="ml-auto font-semibold tabular">{sol(b.quoteAmount, 3)} <span className="font-normal text-mist">SOL</span></span>
              <span className={`w-[72px] text-right text-[11px] ${b.qualifies ? "text-signal" : "text-dim"}`}>{b.qualifies ? "qualifies" : "below min"}</span>
              <a href={txUrl(explorer, b.signature, cluster)} target="_blank" rel="noreferrer" className="focus-ring w-[64px] text-right text-[11px] text-dim hover:text-mist" title={b.commitment}>
                {relative(b.blockTime, now)}
              </a>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
