import mongoose, { type Connection } from "mongoose";
import { createModels, ensureIndexes, type Models } from "./models";
import { rootLogger } from "../util/logger";
import { retry } from "../util/backoff";

export interface Database extends Models {
  close(): Promise<void>;
}

/**
 * Connects to MongoDB, verifies the deployment supports transactions (replica set or sharded),
 * and synchronises indexes. Retries with backoff so workers survive Mongo starting after them.
 */
export async function connectDatabase(uri: string, dbName: string, opts: { syncIndexes?: boolean; requireTransactions?: boolean } = {}): Promise<Database> {
  const log = rootLogger().child({ component: "db" });
  const conn: Connection = await retry(
    async () => mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 10_000, maxPoolSize: 20, bufferCommands: false, autoIndex: false }).asPromise(),
    { retries: 10, baseMs: 500, maxMs: 15_000, onRetry: (err, n, d) => log.warn({ err: String(err), attempt: n, delayMs: d }, "MongoDB connect failed, retrying") },
  );
  if (opts.requireTransactions !== false) {
    const hello = await conn.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") {
      await conn.close();
      throw new Error("MongoDB must be a replica set (or sharded cluster) so multi-document transactions are available. Use Atlas, or start mongod with --replSet rs0 and run rs.initiate().");
    }
  }
  conn.on("disconnected", () => log.warn("MongoDB disconnected"));
  conn.on("reconnected", () => log.info("MongoDB reconnected"));
  const models = createModels(conn);
  if (opts.syncIndexes !== false) await ensureIndexes(models);
  return Object.assign(models, { close: () => conn.close() });
}

/** Runs fn inside a transaction with automatic retry of transient errors (withTransaction semantics). */
export async function inTransaction<T>(db: Models, fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await db.conn.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    return result as T;
  } finally {
    await session.endSession();
  }
}
