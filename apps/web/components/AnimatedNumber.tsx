"use client";
import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { lamportsToFloat, sol } from "@/lib/format";

/**
 * Animated SOL amount. The tween is display-only; at rest the exact value (bigint formatting) is
 * shown, so the screen never disagrees with the ledger.
 */
export function AnimatedSol({ lamports, max = 4, className }: { lamports: string; max?: number; className?: string }) {
  const reduce = useReducedMotion();
  const target = lamportsToFloat(lamports);
  const from = useRef(target);
  const [text, setText] = useState(() => sol(lamports, max));
  useEffect(() => {
    if (reduce || from.current === target) {
      from.current = target;
      setText(sol(lamports, max));
      return;
    }
    const fmt = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: max });
    const c = animate(from.current, target, { duration: 0.9, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => setText(fmt(v)), onComplete: () => setText(sol(lamports, max)) });
    from.current = target;
    return () => c.stop();
  }, [lamports, target, max, reduce]);
  return <span className={className}>{text}</span>;
}

export function AnimatedInt({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion();
  const from = useRef(value);
  const [v, setV] = useState(value);
  useEffect(() => {
    if (reduce || from.current === value) {
      from.current = value;
      setV(value);
      return;
    }
    const c = animate(from.current, value, { duration: 0.7, onUpdate: (x) => setV(Math.round(x)) });
    from.current = value;
    return () => c.stop();
  }, [value, reduce]);
  return <span className={className}>{v.toLocaleString()}</span>;
}
