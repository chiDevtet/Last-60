/** API entrypoint (PM2: last60-api). Holds no signing keys and no schedule key. */
import { attachStoredMigration, ConfigError, connectDatabase, createLogger, createProvider, loadConfig, providerTargetFor, PublicData, RpcClient, SettingsStore, setRootLogger } from "@last60/engine";
import { createApp } from "./app";
import { AdminAuth } from "./auth";
import { StreamHub } from "./stream";

let cfg;
try {
  cfg = loadConfig("api");
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(78);
  }
  throw e;
}
const log = createLogger({ level: cfg.logLevel, name: "last60-api" });
setRootLogger(log);
if (cfg.schedule.encryptionKey) log.warn("SCHEDULE_ENCRYPTION_KEY is set in the API environment; it is not needed here — remove it to keep scheduling secrets out of this process");
if (cfg.secrets.payoutWalletPrivateKey || cfg.secrets.payoutWalletKeypairPath) log.warn("a payout signing key is configured in the API environment; remove it — only the rewards worker's payout signer may hold it (it is never loaded here)");

const db = await connectDatabase(cfg.mongo.uri, cfg.mongo.dbName, { syncIndexes: true });
const settings = new SettingsStore(db, cfg);
const data = new PublicData(db, cfg, settings);
const hub = new StreamHub(data, cfg.api.streamSnapshotIntervalMs);
await hub.start();
const auth = new AdminAuth(db, { appName: cfg.public.appName, adminWallets: cfg.api.adminWallets, secret: cfg.api.adminSessionSecret, ttlSeconds: cfg.api.adminSessionTtlSeconds });
const rpc = new RpcClient({ urls: cfg.solana.rpcUrls, timeoutMs: cfg.solana.timeoutMs, maxRps: 5, logger: log });
// Operator recovery re-runs the attribution against the configured launch (read-only provider load).
const providerFor = async () => {
  const s = await settings.get(true);
  const p = createProvider(providerTargetFor(s, cfg), rpc);
  await p.load();
  await attachStoredMigration(db, p);
  return p;
};
const app = createApp({ db, cfg, settings, data, hub, auth, rpc, providerFor });

// Finite idle timeout server-wide (dead clients are reaped); SSE responses send a heartbeat every
// 15 s and raise their own per-request timeout (see /api/v1/stream).
const server = Bun.serve({ hostname: cfg.api.host, port: cfg.api.port, fetch: (req, srv) => app.fetch(req, srv), idleTimeout: 30 });
log.info({ url: `http://${cfg.api.host}:${cfg.api.port}`, admin: auth.enabled }, "API listening");

const shutdown = async () => {
  log.info("shutting down");
  hub.stop();
  server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
