/**
 * Starts a real single-node MongoDB replica set (transactions enabled) for tests and local dev.
 *
 * mongodb-memory-server is used only to download/cache the `mongod` binary; we spawn the
 * process ourselves bound to 127.0.0.1 because the library's port probe binds `::`, which
 * fails on IPv4-only hosts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";

export interface LocalReplSet {
  uri: string;
  port: number;
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export async function mongodBinaryPath(): Promise<string> {
  const { MongoBinary } = await import("mongodb-memory-server-core");
  return MongoBinary.getPath({ version: process.env.MONGOMS_VERSION ?? "8.0.4" });
}

export async function startLocalReplSet(opts: { port?: number; dbPath?: string; quiet?: boolean } = {}): Promise<LocalReplSet> {
  const bin = await mongodBinaryPath();
  const port = opts.port ?? (await freePort());
  const ephemeral = !opts.dbPath;
  const dbPath = opts.dbPath ?? mkdtempSync(join(tmpdir(), "last60-mongo-"));
  mkdirSync(dbPath, { recursive: true });
  const child: ChildProcess = spawn(
    bin,
    ["--replSet", "rs0", "--bind_ip", "127.0.0.1", "--port", String(port), "--dbpath", dbPath, "--quiet", "--setParameter", "transactionLifetimeLimitSeconds=60"],
    { stdio: opts.quiet === false ? "inherit" : "ignore" },
  );
  let exited = false;
  child.once("exit", () => (exited = true));

  const direct = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  const deadline = Date.now() + 60_000;
  let client: MongoClient | undefined;
  while (!client) {
    if (exited) throw new Error(`mongod exited during startup (binary ${bin})`);
    try {
      const c = new MongoClient(direct, { serverSelectionTimeoutMS: 1000 });
      await c.connect();
      client = c;
    } catch {
      if (Date.now() > deadline) throw new Error("mongod did not start within 60s");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    await client.db("admin").command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  } catch (err: any) {
    if (!/already initialized/i.test(String(err?.message))) throw err;
  }
  // Wait for PRIMARY so transactions work immediately.
  while (true) {
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello.isWritablePrimary) break;
    if (Date.now() > deadline) throw new Error("replica set did not elect a primary");
    await new Promise((r) => setTimeout(r, 150));
  }
  await client.close();

  return {
    uri: `mongodb://127.0.0.1:${port}/?replicaSet=rs0&directConnection=true`,
    port,
    async stop() {
      if (!exited) {
        const done = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      }
      if (ephemeral) rmSync(dbPath, { recursive: true, force: true });
    },
  };
}
