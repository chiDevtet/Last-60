/** API entrypoint (PM2: last60-api). Holds no signing keys and no schedule key. */
import { ConfigError, connectDatabase, createLogger, loadConfig, PublicData, RpcClient, SettingsStore, setRootLogger } from "@last60/engine";
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
if (cfg.secrets.payoutWalletPrivateKey || cfg.secrets.payoutWalletKeypairPath) log.warn("a payout signing key is configured in the API environment; remove it — only the rewards worker needs it");

const db = await connectDatabase(cfg.mongo.uri, cfg.mongo.dbName, { syncIndexes: true });
const settings = new SettingsStore(db, cfg);
const data = new PublicData(db, cfg, settings);
const hub = new StreamHub(data, cfg.api.streamSnapshotIntervalMs);
await hub.start();
const auth = new AdminAuth(db, { appName: cfg.public.appName, adminWallets: cfg.api.adminWallets, secret: cfg.api.adminSessionSecret, ttlSeconds: cfg.api.adminSessionTtlSeconds });
const rpc = new RpcClient({ urls: cfg.solana.rpcUrls, timeoutMs: cfg.solana.timeoutMs, maxRps: 5, logger: log });
const app = createApp({ db, cfg, settings, data, hub, auth, rpc });

const server = Bun.serve({ hostname: cfg.api.host, port: cfg.api.port, fetch: app.fetch, idleTimeout: 0 });
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
