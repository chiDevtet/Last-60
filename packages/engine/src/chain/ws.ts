/**
 * logsSubscribe(mentions) over WebSocket with automatic reconnect. This is only the low-latency
 * path: correctness never depends on it, because the polling backstop re-reads every signature.
 */
import { backoffDelay } from "../util/backoff";
import { rootLogger, type Logger } from "../util/logger";

export interface LogsNotification {
  signature: string;
  err: unknown | null;
  slot: number;
  address: string;
}

export class LogsSubscriber {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  connected = false;
  lastMessageAt = 0;
  private readonly log: Logger;

  constructor(
    private readonly url: string,
    private readonly addresses: string[],
    private readonly onLog: (n: LogsNotification) => void,
    logger?: Logger,
  ) {
    this.log = (logger ?? rootLogger()).child({ component: "ws" });
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.connected = false;
  }

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect(err);
      return;
    }
    this.ws = ws;
    const pending = new Map<number, string>();
    const active = new Map<number, string>();
    ws.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      for (const address of this.addresses) {
        const id = this.nextId++;
        pending.set(id, address);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [address] }, { commitment: "confirmed" }] }));
      }
      this.pingTimer = setInterval(() => {
        try {
          (ws as any).ping?.();
        } catch {
          /* ignore */
        }
        // Treat a silent socket as dead so we reconnect (providers drop idle subscriptions).
        if (Date.now() - this.lastMessageAt > 120_000) ws.close();
      }, 30_000);
      this.log.info({ addresses: this.addresses.length }, "websocket connected");
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString());
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        if (typeof msg.result === "number") active.set(msg.result, pending.get(msg.id)!);
        else this.log.warn({ error: msg.error }, "logsSubscribe rejected");
        pending.delete(msg.id);
        return;
      }
      if (msg.method === "logsNotification") {
        const v = msg.params?.result?.value;
        const address = active.get(msg.params?.subscription) ?? "";
        if (v?.signature) this.onLog({ signature: v.signature, err: v.err ?? null, slot: msg.params.result.context?.slot ?? 0, address });
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.scheduleReconnect("closed");
    };
  }

  private scheduleReconnect(reason: unknown) {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt++, { baseMs: 500, maxMs: 30_000 });
    this.log.warn({ reason: String(reason), delay }, "websocket disconnected; reconnecting");
    setTimeout(() => this.connect(), delay);
  }
}
