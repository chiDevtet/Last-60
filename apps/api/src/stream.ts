/**
 * Server-Sent Events hub. ONE snapshot computation and ONE terminal tail query per interval,
 * fanned out to every connected client — so database load is independent of audience size and
 * browsers never poll.
 */
import type { DashboardSnapshotDTO, TerminalEventDTO } from "@last60/shared";
import type { PublicData } from "@last60/engine";

type Listener = (event: "snapshot" | "terminal" | "heartbeat", data: unknown) => void;

export class StreamHub {
  private listeners = new Set<Listener>();
  private lastSeq = 0;
  private snapshot: DashboardSnapshotDTO | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private busy = { snap: false, term: false };

  constructor(
    private readonly data: PublicData,
    private readonly snapshotMs: number,
    private readonly terminalMs = 750,
  ) {}

  get clients() {
    return this.listeners.size;
  }

  async start() {
    const recent = await this.data.terminal({ limit: 1 });
    this.lastSeq = recent.items[0]?.seq ?? 0;
    this.timers.push(setInterval(() => void this.tickSnapshot(), this.snapshotMs));
    this.timers.push(setInterval(() => void this.tickTerminal(), this.terminalMs));
    this.timers.push(setInterval(() => this.emit("heartbeat", { serverTime: new Date().toISOString() }), 15_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  latest() {
    return this.snapshot;
  }

  private emit(event: "snapshot" | "terminal" | "heartbeat", data: unknown) {
    for (const l of this.listeners) {
      try {
        l(event, data);
      } catch {
        /* a broken client never affects others */
      }
    }
  }

  async tickSnapshot() {
    if (this.busy.snap || !this.listeners.size) return;
    this.busy.snap = true;
    try {
      this.snapshot = await this.data.dashboard();
      this.emit("snapshot", this.snapshot);
    } catch {
      /* transient DB error: next tick retries */
    } finally {
      this.busy.snap = false;
    }
  }

  async tickTerminal() {
    if (this.busy.term) return;
    this.busy.term = true;
    try {
      const { items } = await this.data.terminal({ after: this.lastSeq, limit: 200 });
      for (const e of items as TerminalEventDTO[]) {
        this.lastSeq = Math.max(this.lastSeq, e.seq);
        this.emit("terminal", e);
      }
    } catch {
      /* retry next tick */
    } finally {
      this.busy.term = false;
    }
  }
}
