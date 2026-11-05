"use client";
/**
 * Live data over Server-Sent Events (no polling). Keeps the latest dashboard snapshot, a rolling
 * terminal buffer, connection state, and the offset between server and browser clocks so every
 * viewer's countdown agrees with the server.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSnapshotDTO, TerminalEventDTO } from "@last60/shared";
import { PUBLIC_API_URL } from "./config";

export type ConnState = "connecting" | "live" | "reconnecting" | "offline";
const MAX_LINES = 600;

export function useLive(initial: DashboardSnapshotDTO | null, initialTerminal: TerminalEventDTO[]) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshotDTO | null>(initial);
  const [terminal, setTerminal] = useState<TerminalEventDTO[]>(() => [...initialTerminal].sort((a, b) => a.seq - b.seq));
  const [conn, setConn] = useState<ConnState>("connecting");
  const offset = useRef(initial ? new Date(initial.round.serverTime).getTime() - Date.now() : 0);
  const [offsetMs, setOffsetMs] = useState(offset.current);
  const retry = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      es = new EventSource(`${PUBLIC_API_URL}/api/v1/stream`);
      es.onopen = () => {
        retry.current = 0;
        setConn("live");
      };
      es.addEventListener("snapshot", (e) => {
        const s = JSON.parse((e as MessageEvent).data) as DashboardSnapshotDTO;
        const measured = new Date(s.round.serverTime).getTime() - Date.now();
        // Exponential smoothing avoids visible jumps from network jitter.
        offset.current = Math.abs(measured - offset.current) > 2000 ? measured : offset.current * 0.8 + measured * 0.2;
        setOffsetMs(offset.current);
        setSnapshot(s);
      });
      es.addEventListener("terminal", (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as TerminalEventDTO;
        setTerminal((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev].slice(-MAX_LINES)));
      });
      es.onerror = () => {
        es?.close();
        if (closed) return;
        setConn(retry.current > 3 ? "offline" : "reconnecting");
        const delay = Math.min(30_000, 1000 * 2 ** retry.current++) * (0.5 + Math.random() / 2);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const prependOlder = useCallback((older: TerminalEventDTO[]) => {
    setTerminal((prev) => {
      const seen = new Set(prev.map((p) => p.seq));
      return [...older.filter((o) => !seen.has(o.seq)).sort((a, b) => a.seq - b.seq), ...prev];
    });
  }, []);

  return { snapshot, terminal, conn, offsetMs, prependOlder };
}

/** Re-renders at `hz` and returns server-synchronised "now". */
export function useNow(offsetMs: number, hz = 4) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + offsetMs), 1000 / hz);
    return () => clearInterval(id);
  }, [offsetMs, hz]);
  return now;
}
