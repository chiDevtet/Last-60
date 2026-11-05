/**
 * Shared integration-test harness: a real MongoDB replica set, the FakeChain, the MockProvider,
 * a controllable clock and freshly generated (throwaway) keypairs. No real keys, no mainnet.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import mongoose from "mongoose";
import { loadConfig, type AppConfig } from "../src/config/env";
import { SettingsStore } from "../src/config/runtime";
import { createModels, ensureIndexes, type Models } from "../src/db/models";
import { FakeChain } from "../src/testing/fakeChain";
import { startLocalReplSet, type LocalReplSet } from "../src/testing/mongod";
import { MockProvider, MOCK_POOL } from "../src/providers/mock/MockProvider";
import { RewardsWorker } from "../src/rewards/RewardsWorker";
import type { Clock } from "../src/util/time";

export const SOL = 1_000_000_000n;

export class FakeClock implements Clock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    if (ms > 0) this.t += ms;
  }
  set(t: number) {
    this.t = t;
  }
}

let rs: LocalReplSet | null = null;
let conn: mongoose.Connection | null = null;
let dbSeq = 0;

export async function startDb(): Promise<void> {
  rs ??= await startLocalReplSet();
}

export async function freshDb(): Promise<Models> {
  await startDb();
  if (conn) await conn.close();
  conn = await mongoose.createConnection(rs!.uri, { dbName: `t${process.pid}_${dbSeq++}`, autoIndex: false }).asPromise();
  const m = createModels(conn);
  await ensureIndexes(m);
  return m;
}

export async function stopDb() {
  await conn?.close();
  conn = null;
  await rs?.stop();
  rs = null;
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig("test", {
    NODE_ENV: "test",
    SOLANA_CLUSTER: "localnet",
    SOLANA_RPC_URL: "http://127.0.0.1:8899",
    LAUNCH_PROVIDER: "mock",
    MONGODB_URI: rs?.uri ?? "mongodb://127.0.0.1:1",
    SCHEDULE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    SNAPSHOT_SETTLE_MS: "0",
    PAYOUT_COMMITMENT: "finalized",
    PAYOUT_WALLET_MIN_RESERVE_LAMPORTS: "0",
    INSTANCE_ID: "test-a",
    ...env,
  });
}

/** Round boundaries for tests: an arbitrary aligned instant. */
export const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

export interface Rig {
  db: Models;
  cfg: AppConfig;
  chain: FakeChain;
  clock: FakeClock;
  payer: Keypair;
  provider: MockProvider;
  settings: SettingsStore;
  worker: RewardsWorker;
  trade(o: { trader: string; kind?: "buy" | "sell"; quote: bigint; fee?: bigint; failed?: boolean }): string;
  newWorker(instanceId: string): RewardsWorker;
}

export async function rig(opts: { env?: Record<string, string>; random?: (min: number, max: number) => number; balance?: bigint } = {}): Promise<Rig> {
  const db = await freshDb();
  const payer = Keypair.generate(); // throwaway key generated per test — never a real key
  const cfg = testConfig({ PAYOUT_MODE: "live", PAYOUT_WALLET_PRIVATE_KEY: bs58.encode(payer.secretKey), PAYOUT_WALLET_PUBLIC_KEY: payer.publicKey.toBase58(), ...(opts.env ?? {}) });
  const chain = new FakeChain();
  const clock = new FakeClock(T0 + 1_000);
  chain.now = () => clock.now();
  chain.setBalance(payer.publicKey.toBase58(), opts.balance ?? 100n * SOL);
  const provider = new MockProvider();
  const settings = new SettingsStore(db, cfg, 0);
  await db.Settings.create({ _id: "active", version: 1, overrides: { expectedPayoutPublicKey: payer.publicKey.toBase58() } });
  const make = (instanceId: string) =>
    new RewardsWorker({ db, cfg: { ...cfg, instanceId }, settings, payer, claimer: null, rpc: chain, provider, clock, random: opts.random ?? (() => 30_000) });
  return {
    db,
    cfg,
    chain,
    clock,
    payer,
    provider,
    settings,
    worker: make(cfg.instanceId),
    newWorker: make,
    trade: (o) => {
      const fee = o.fee ?? (o.quote * 2n) / 100n; // 2% total fee …
      return chain.addMockTrade({ trader: o.trader, pool: MOCK_POOL, kind: o.kind ?? "buy", quote: o.quote, totalFee: fee, eligibleFee: fee / 2n, failed: o.failed }); // … half eligible
    },
  };
}

export const wallet = () => Keypair.generate().publicKey.toBase58();
