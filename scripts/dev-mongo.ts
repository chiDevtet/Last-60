/**
 * Local development MongoDB: a persistent single-node replica set (transactions enabled) on
 * 127.0.0.1:27017 with data in ./.mongo-dev. No Docker required.
 *   bun run dev:mongo     → MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true
 */
import { join } from "node:path";
import { startLocalReplSet } from "../packages/engine/src/testing/mongod";

const port = Number(process.env.MONGO_PORT ?? 27017);
const rs = await startLocalReplSet({ port, dbPath: join(import.meta.dir, "../.mongo-dev"), quiet: true });
console.log(`MongoDB replica set ready\n  MONGODB_URI=${rs.uri}`);
const stop = async () => {
  await rs.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => undefined);
