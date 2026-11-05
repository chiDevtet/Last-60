/** Indexer process (PM2: last60-indexer). Read-only: holds no keys. */
import { Indexer } from "@last60/engine";
import { boot } from "./bootstrap";

const { cfg, log, db, settings, signal } = await boot("indexer", "last60-indexer");
const indexer = new Indexer({ db, cfg, settings, log });
log.info({ provider: cfg.provider.id, pool: cfg.provider.poolAddress, backfill: cfg.indexer.backfill }, "indexer starting");
await indexer.run(signal);
await db.close();
log.info("indexer stopped");
