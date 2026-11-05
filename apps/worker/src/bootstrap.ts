/** Shared process bootstrap: validated config, structured logging, DB, settings, health port. */
import { ConfigError, connectDatabase, createLogger, loadConfig, SettingsStore, setRootLogger, type ProcessRole, type Database, type AppConfig, type Logger } from "@last60/engine";

export interface Booted {
  cfg: AppConfig;
  log: Logger;
  db: Database;
  settings: SettingsStore;
  signal: AbortSignal;
}

export async function boot(role: ProcessRole, name: string): Promise<Booted> {
  let cfg: AppConfig;
  try {
    cfg = loadConfig(role);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[${name}] ${e.message}`);
      process.exit(78); // EX_CONFIG: PM2 should not hot-loop on bad config
    }
    throw e;
  }
  const log = createLogger({ level: cfg.logLevel, name });
  setRootLogger(log);
  const db = await connectDatabase(cfg.mongo.uri, cfg.mongo.dbName, { syncIndexes: true });
  const settings = new SettingsStore(db, cfg);
  const ctrl = new AbortController();
  const stop = (sig: string) => {
    log.info({ sig }, "shutdown requested; finishing current step");
    ctrl.abort();
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error({ err: String(err) }, "unhandled rejection"));

  const port = Number(process.env.WORKER_HEALTH_PORT ?? 0);
  if (port) {
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: async () => {
        const w: any = await db.WorkerState.findById(role === "rewards" ? "rewards" : "indexer").lean().catch(() => null);
        const fresh = w?.heartbeatAt && Date.now() - new Date(w.heartbeatAt).getTime() < 30_000;
        return Response.json({ status: fresh ? w.status : "stale", heartbeatAt: w?.heartbeatAt ?? null }, { status: fresh ? 200 : 503 });
      },
    });
    log.info({ port }, "health endpoint listening on 127.0.0.1");
  }
  return { cfg, log, db, settings, signal: ctrl.signal };
}
