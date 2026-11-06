/**
 * Graduation re-resolution and reattachment on a real MongoDB replica set (runs in CI), driven by a
 * real mainnet DBC → DAMM v2 migration (fixtures/mainnet/migration-dbc-damm-v2.json):
 *   - the destination is attached FROM THE PERSISTED RECORD (indexer and rewards worker share it);
 *   - a restart / re-resolution never rewrites an already verified spec (allocation snapshots stay);
 *   - a different graduation for the same launch is a conflict and detaches (fail closed);
 *   - a stored spec that does not belong to the loaded launch is never attached.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { normalizeTransaction } from "../src/chain/tx";
import { MeteoraDBCProvider } from "../src/providers/meteora/MeteoraDBCProvider";
import { MigrationAwareProvider } from "../src/providers/MigrationAwareProvider";
import { parseMigration } from "../src/providers/migration";
import { attachStoredMigration, resolveAndAttachMigration } from "../src/providers/migrationAttach";
import { freshDb, startDb, stopDb } from "./harness";
import { fixtureRpc, loadFixture } from "./fixtureRpc";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const migFx = loadFixture("migration-dbc-damm-v2.json");
const m = parseMigration(normalizeTransaction(migFx.tx), "meteora_dbc", migFx.bondingPool)!;
const rpc: any = { ...fixtureRpc(migFx), getSignaturesForAddress: async () => [{ signature: m.signature, slot: m.slot, err: null }], getTransactionRaw: async () => migFx.tx };

async function setup() {
  const db = await freshDb();
  const dbc = new MeteoraDBCProvider(null, { poolAddress: migFx.bondingPool, tokenMint: m.baseMint, role: "creator", expected: { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: null } });
  const pool = dbc.decodePool(Buffer.from(migFx.accounts[migFx.bondingPool].data, "base64"));
  const cfg = dbc.decodeConfig(Buffer.from(migFx.accounts[pool.config].data, "base64"));
  const info = dbc.hydrate(pool, cfg, { baseDecimals: 6, quoteDecimals: 9, baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
  expect(info.status).toBe("migrated");
  const key = `meteora_dbc:${migFx.bondingPool}`;
  await db.Pool.create({ key, provider: "meteora_dbc", poolAddress: migFx.bondingPool, tokenMint: info.tokenMint, quoteMint: info.quoteMint });
  const wrap = () => new MigrationAwareProvider(dbc, rpc);
  return { db, key, wrap, info };
}

describe("graduation re-resolution and reattachment", () => {
  test("verified once → both processes attach the same persisted spec", async () => {
    const { db, key, wrap } = await setup();
    const indexerSide = wrap();
    const r = await resolveAndAttachMigration(db, rpc, indexerSide);
    expect(r.status).toBe("verified");
    const doc: any = await db.Pool.findOne({ key }).lean();
    expect(doc.migration.status).toBe("verified");
    const rewardsSide = wrap();
    await attachStoredMigration(db, rewardsSide);
    expect(rewardsSide.info().destination).toEqual(indexerSide.info().destination);
    expect(indexerSide.info().destination!.pool).toBe(m.destinationPool);
  });

  test("a restart never rewrites the verified spec (historical allocation snapshots are kept)", async () => {
    const { db, key, wrap } = await setup();
    await resolveAndAttachMigration(db, rpc, wrap());
    await db.Pool.collection.updateOne({ key }, { $set: { "migration.spec.allocation.source": "ORIGINAL SNAPSHOT" } });
    const again = await resolveAndAttachMigration(db, rpc, wrap());
    expect(again.status).toBe("verified");
    const doc: any = await db.Pool.findOne({ key }).lean();
    expect(doc.migration.spec.allocation.source).toBe("ORIGINAL SNAPSHOT");
    expect(doc.migration.reverifiedAt).toBeTruthy();
  });

  test("a different graduation for the same launch is a conflict: detached, operator review", async () => {
    const { db, key, wrap } = await setup();
    await resolveAndAttachMigration(db, rpc, wrap());
    await db.Pool.collection.updateOne({ key }, { $set: { "migration.spec.ctx.migrationSignature": "someOtherMigration" } });
    const p = wrap();
    const r = await resolveAndAttachMigration(db, rpc, p);
    expect(r.status).toBe("conflict");
    expect(p.info().destination).toBeNull();
    const doc: any = await db.Pool.findOne({ key }).lean();
    expect(doc.migration.spec).toBeNull();
    expect(doc.migration.verifiedSpec.ctx.migrationSignature).toBe("someOtherMigration"); // history kept
  });

  test("a stored spec for another beneficiary, or with a failed required check, is never attached", async () => {
    const { db, key, wrap } = await setup();
    await resolveAndAttachMigration(db, rpc, wrap());
    await db.Pool.collection.updateOne({ key }, { $set: { "migration.spec.ctx.beneficiary": Keypair.generate().publicKey.toBase58() } });
    const p = wrap();
    await attachStoredMigration(db, p);
    expect(p.info().destination).toBeNull();
    await resolveAndAttachMigration(db, rpc, wrap()); // conflict-free re-verify path does not resurrect it either
    const doc: any = await db.Pool.findOne({ key }).lean();
    const firstCheck = doc.migration.requiredChecks[0];
    await db.Pool.collection.updateOne({ key }, { $set: { [`migration.checks.${firstCheck}`]: false } });
    const q = wrap();
    await attachStoredMigration(db, q);
    expect(q.info().destination).toBeNull();
  });
});
