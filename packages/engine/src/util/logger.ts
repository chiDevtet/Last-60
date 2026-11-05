import pino, { type Logger } from "pino";

export type { Logger };

const REDACT = [
  "*.privateKey",
  "*.secretKey",
  "*.PAYOUT_WALLET_PRIVATE_KEY",
  "*.FEE_CLAIM_AUTHORITY_PRIVATE_KEY",
  "*.SCHEDULE_ENCRYPTION_KEY",
  "*.ADMIN_SESSION_SECRET",
  "*.executeAt",
  "*.executeAtCipher",
  "*.delayMs",
  "*.serializedTx",
  "headers.authorization",
];

let root: Logger | undefined;

export function createLogger(opts: { level?: string; name?: string; pretty?: boolean } = {}): Logger {
  const pretty = opts.pretty ?? (process.env.LOG_PRETTY === "true" || (process.env.NODE_ENV !== "production" && process.stdout.isTTY));
  return pino({
    name: opts.name ?? "last60",
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT, censor: "[redacted]" },
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } } } : {}),
  });
}

export function rootLogger(): Logger {
  root ??= createLogger({ level: process.env.NODE_ENV === "test" ? process.env.LOG_LEVEL ?? "silent" : undefined });
  return root;
}

export function setRootLogger(l: Logger) {
  root = l;
}
