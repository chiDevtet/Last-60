/**
 * Graduation verification against REAL mainnet migrations (offline fixtures collected with
 * scripts/fetch-migration-fixtures.ts):
 *   - Meteora DBC pool AX7tzZ96… graduated to DAMM v2 pool 26n3vvi7… (tx 2xu4wQep…, slot 465800030)
 *   - Raydium LaunchLab pool 8AH7Rbje… graduated to CPMM pool 2ZJpQEny… (tx 371QXpQ6…)
 * plus tampered copies proving that every required relationship is enforced: a migration is
 * verified only if ALL checks for its kind hold, never because the destination merely exists.
 */
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { normalizeTransaction } from "../src/chain/tx";
import { MeteoraDBCProvider } from "../src/providers/meteora/MeteoraDBCProvider";
import { decodeLaunchLabPlatformConfig, decodeLaunchLabPool } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { dammV2ClaimableFees, decodeDammV2Pool, decodeDammV2Position, migrationVerified, parseMigration, verifyMigration, DAMM_V2_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CP_LOCK_PROGRAM_ID, type MigrationRecord } from "../src/providers/migration";

import { fixtureRpc, loadFixture } from "./fixtureRpc";

const dbcFx = loadFixture("migration-dbc-damm-v2.json");
const dbcM = parseMigration(normalizeTransaction(dbcFx.tx), "meteora_dbc", dbcFx.bondingPool)!;
const dbcProv = new MeteoraDBCProvider(null, { poolAddress: dbcFx.bondingPool, tokenMint: dbcM.baseMint, role: "creator" });
const dbcBonding = dbcProv.decodePool(Buffer.from(dbcFx.accounts[dbcFx.bondingPool].data, "base64"));
const dbcCfg = dbcProv.decodeConfig(Buffer.from(dbcFx.accounts[dbcBonding.config].data, "base64"));
const dbcCtx = { base: dbcM.baseMint, quote: dbcM.quoteMint, bondingCreator: dbcBonding.creator, feeClaimer: dbcCfg.feeClaimer };

const llFx = loadFixture("migration-launchlab-cpmm.json");
const llM = parseMigration(normalizeTransaction(llFx.tx), "raydium_launchlab", llFx.bondingPool)!;
const llBonding = decodeLaunchLabPool(Buffer.from(llFx.accounts[llFx.bondingPool].data, "base64"));
const llPlatform = decodeLaunchLabPlatformConfig(Buffer.from(llFx.accounts[llBonding.platformConfig].data, "base64"));
const llCtx = { base: llM.baseMint, quote: llM.quoteMint, bondingCreator: llBonding.creator, platform: { cpConfig: llPlatform.cpConfig, platformCpCreator: llPlatform.platformCpCreator ?? null } };

describe("Meteora DBC → DAMM v2 (strict)", () => {
  test("the destination pool and LP positions are read from the migration instruction itself", () => {
    expect(dbcM.kind).toBe("dbc_damm_v2");
    expect(dbcM.signature).toBe("2xu4wQep7zpgb8p6pm2DXJj7a6DUH72Z7361Si9rTjgKscsFJADyeMgTjCGJHdkNTXuHzQU9NdBjs1nJQxMDwV1c");
    expect(dbcM.destinationProgram).toBe(DAMM_V2_PROGRAM_ID);
    expect(dbcM.destinationPool).toBe("26n3vvi7yzVni6Aa57M9hyLPNsfkG13paeUdXY8zGtQG");
    expect(dbcM.destinationConfig).toBe("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
    expect(dbcM.positions[0]!.position).toBe("FHzjmKYDUm9s1tYsQbw9arPshHNRQQuvMgr1x3De6QN4");
  });

  test("every required relationship is proven: program, layout, mints, PDA, DBC authority, config, positions, owners", async () => {
    const v = await verifyMigration(fixtureRpc(dbcFx), dbcM, dbcCtx);
    expect(v.failed).toEqual([]);
    for (const c of v.requiredChecks) expect(v.checks[c]).toBe(true);
    expect(v.requiredChecks).toEqual(expect.arrayContaining(["layoutMatches", "pdaDerivesFromConfigAndMints", "createdByDbcPoolAuthority", "configOwnedByDammV2", "positionsValid", "positionOwnersAreCreatorOrPartner"]));
    expect(migrationVerified(v)).toBe(true);
    expect(v.positionStates).toHaveLength(1); // the config gave the partner 0% LP: no second position
    expect(v.positionStates[0]!.holder).toBe(dbcBonding.creator);
  });

  test("position fee math reproduces the program's own accounting (claimable + claimed = pool LP fees, to rounding)", () => {
    const pool = decodeDammV2Pool(Buffer.from(dbcFx.accounts[dbcM.destinationPool].data, "base64"));
    const pos = decodeDammV2Position(Buffer.from(dbcFx.accounts[dbcM.positions[0]!.position].data, "base64"));
    const liquidity = pos.unlockedLiquidity + pos.vestedLiquidity + pos.permanentLockedLiquidity;
    expect(liquidity).toBe(pool.liquidity); // this position owns all liquidity
    const c = dammV2ClaimableFees(pool, pos);
    const totalA = c.a + pos.totalClaimedAFee;
    const totalB = c.b + pos.totalClaimedBFee;
    // floor() per accrual can only lose dust, never create value
    expect(totalA <= pool.totalLpAFee && pool.totalLpAFee - totalA <= 10n).toBe(true);
    expect(totalB <= pool.totalLpBFee && pool.totalLpBFee - totalB <= 10n).toBe(true);
  });

  const tamper = async (patch: Parameters<typeof fixtureRpc>[1], m: MigrationRecord = dbcM, ctx = dbcCtx) => verifyMigration(fixtureRpc(dbcFx, patch), m, ctx);

  test("wrong program owner of the destination → not verified", async () => {
    const v = await tamper((a, x) => (a === dbcM.destinationPool && x ? { ...x, owner: RAYDIUM_CPMM_PROGRAM_ID } : x));
    expect(v.checks.ownedByExpectedProgram).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("wrong account layout (size / discriminator) → not verified", async () => {
    const truncated = await tamper((a, x) => (a === dbcM.destinationPool && x ? { ...x, data: x.data.subarray(0, 1000) } : x));
    expect(truncated.checks.layoutMatches).toBe(false);
    expect(migrationVerified(truncated)).toBe(false);
    const badDisc = await tamper((a, x) => (a === dbcM.destinationPool && x ? { ...x, data: Buffer.concat([Buffer.alloc(8), x.data.subarray(8)]) } : x));
    expect(migrationVerified(badDisc)).toBe(false);
  });

  test("a mint that is not the launch's token or quote → not verified", async () => {
    const v = await verifyMigration(fixtureRpc(dbcFx), dbcM, { ...dbcCtx, base: new PublicKey(Buffer.alloc(32, 9)).toBase58() });
    expect(v.checks.mintsMatch).toBe(false);
    expect(v.checks.pdaDerivesFromConfigAndMints).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("a destination that is not PDA(config, mints) → not verified", async () => {
    const v = await tamper(undefined, { ...dbcM, destinationConfig: dbcM.positions[0]!.position });
    expect(v.checks.pdaDerivesFromConfigAndMints).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("a pool not created by the DBC pool authority → not verified", async () => {
    const v = await tamper((a, x) => {
      if (a !== dbcM.destinationPool || !x) return x;
      const d = Buffer.from(x.data);
      Buffer.alloc(32, 1).copy(d, 648);
      return { ...x, data: d };
    });
    expect(v.checks.createdByDbcPoolAuthority).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("a DAMM config that is not a DAMM v2 Config account → not verified", async () => {
    const v = await tamper((a, x) => (a === dbcM.destinationConfig && x ? { ...x, owner: RAYDIUM_CPMM_PROGRAM_ID } : x));
    expect(v.checks.configOwnedByDammV2).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("positions held by neither the DBC creator nor the partner → relationship not proven", async () => {
    const v = await verifyMigration(fixtureRpc(dbcFx), dbcM, { ...dbcCtx, bondingCreator: new PublicKey(Buffer.alloc(32, 3)).toBase58(), feeClaimer: new PublicKey(Buffer.alloc(32, 4)).toBase58() });
    expect(v.checks.positionOwnersAreCreatorOrPartner).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("a position that belongs to another pool → not verified", async () => {
    const v = await tamper((a, x) => {
      if (a !== dbcM.positions[0]!.position || !x) return x;
      const d = Buffer.from(x.data);
      Buffer.alloc(32, 5).copy(d, 8);
      return { ...x, data: d };
    });
    expect(v.checks.positionsValid).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });
});

describe("Raydium LaunchLab → CPMM (strict)", () => {
  test("the CPMM pool and the LP locks are read from migrate_to_cpswap", () => {
    expect(llM.kind).toBe("launchlab_cpmm");
    expect(llM.destinationProgram).toBe(RAYDIUM_CPMM_PROGRAM_ID);
    expect(llM.destinationPool).toBe("2ZJpQEnyTugE237Cs9X5FHPrXhPauC6DBx5jLV5FqyV7");
    // This platform locks 100% of the LP for itself (platform_scale = 1e6, creator_scale = 0):
    // one lock, fee-key NFT minted to the platform's lock wallet — none to the creator.
    expect(llPlatform.platformScale).toBe(1_000_000n);
    expect(llPlatform.creatorScale).toBe(0n);
    expect(llM.locks).toHaveLength(1);
    expect(llM.locks![0]!.nftOwnerAtMigration).toBe(llPlatform.platformLockNftWallet!);
    expect(llM.locks![0]!.nftOwnerAtMigration).not.toBe(llBonding.creator);
  });

  test("every required relationship is proven: program, layout, mints, config (= platform cp_config), PDA, pool creator, locks", async () => {
    const v = await verifyMigration(fixtureRpc(llFx), llM, llCtx);
    expect(v.failed).toEqual([]);
    expect(migrationVerified(v)).toBe(true);
    expect(v.cpmmPoolCreator).toBe(llBonding.creator); // CPMM creator fees go to the LaunchLab token creator here
    expect(v.cpmmEnableCreatorFee).toBe(true);
    expect(v.locks[0]!.holder).toBe(llPlatform.platformLockNftWallet!);
    // Real platform values (millionths): creator_fee_rate 5000 = a 0.5% FEE RATE on trade value.
    expect(llPlatform.creatorFeeRate).toBe(5000n);
  });

  test("a CPMM config other than the platform's cp_config → not verified", async () => {
    const v = await verifyMigration(fixtureRpc(llFx), llM, { ...llCtx, platform: { ...llCtx.platform, cpConfig: llM.destinationPool } });
    expect(v.checks.configMatches).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("a pool creator that is neither the token creator nor the platform's CPMM creator → not verified", async () => {
    const v = await verifyMigration(fixtureRpc(llFx), llM, { ...llCtx, bondingCreator: new PublicKey(Buffer.alloc(32, 6)).toBase58() });
    expect(v.checks.poolCreatorIsCreatorOrPlatform).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("an LP lock account not owned by the lock program → not verified", async () => {
    const v = await verifyMigration(fixtureRpc(llFx, (a, x) => (a === llM.locks![0]!.lockPda && x ? { ...x, owner: DAMM_V2_PROGRAM_ID } : x)), llM, llCtx);
    expect(v.checks.locksValid).toBe(false);
    expect(migrationVerified(v)).toBe(false);
  });

  test("a wrong owner / layout of the CPMM pool → not verified", async () => {
    const v1 = await verifyMigration(fixtureRpc(llFx, (a, x) => (a === llM.destinationPool && x ? { ...x, owner: RAYDIUM_CP_LOCK_PROGRAM_ID } : x)), llM, llCtx);
    expect(migrationVerified(v1)).toBe(false);
    const v2 = await verifyMigration(fixtureRpc(llFx, (a, x) => (a === llM.destinationPool && x ? { ...x, data: x.data.subarray(0, 600) } : x)), llM, llCtx);
    expect(v2.checks.layoutMatches).toBe(false);
    expect(migrationVerified(v2)).toBe(false);
  });
});

describe("unsupported destinations are explicitly unverified", () => {
  test("DBC → DAMM v1 and LaunchLab → AMM v4 never verify (layouts / fee model not verified here)", async () => {
    for (const kind of ["dbc_damm_v1", "launchlab_amm_v4"] as const) {
      const v = await verifyMigration(fixtureRpc(dbcFx), { ...dbcM, kind }, dbcCtx);
      expect(v.supported).toBe(false);
      expect(migrationVerified(v)).toBe(false);
      expect(v.notes.join(" ")).toContain("not supported");
    }
  });
});

describe("no false positives", () => {
  test("ordinary swaps and claims are never mistaken for a migration", () => {
    for (const [name, provider] of [["dbc-buy-direct.json", "meteora_dbc"], ["dbc-sell.json", "meteora_dbc"], ["launchlab-buy-creatorfee.json", "raydium_launchlab"], ["launchlab-claim-creator.json", "raydium_launchlab"]] as const) {
      const tx = normalizeTransaction(loadFixture(name));
      for (const ix of tx.instructions) for (const a of ix.accounts) expect(parseMigration(tx, provider, a)).toBeNull();
    }
  });

  test("a failed migration transaction is ignored", () => {
    const raw = structuredClone(dbcFx.tx);
    raw.meta.err = { InstructionError: [0, "Custom"] };
    expect(parseMigration(normalizeTransaction(raw), "meteora_dbc", dbcFx.bondingPool)).toBeNull();
  });
});

describe("configuration warnings (real DBC config)", () => {
  test("a config where the creator earns 0% of bonding-curve fees is flagged instead of silently yielding fee-less rounds", async () => {
    const { dbcConfigWarnings } = await import("../src/providers/meteora/MeteoraDBCProvider");
    const f = loadFixture("dbc-accounts.json");
    const dbc = new MeteoraDBCProvider(null, { poolAddress: f.pool, tokenMint: f.baseMint, role: "creator" });
    const cfg = dbc.decodeConfig(Buffer.from(f.accounts[f.config].data, "base64"));
    expect(cfg.creatorTradingFeePercentage).toBe(0); // this real launchpad config gives the partner 100%
    expect(dbcConfigWarnings("creator", cfg).some((w) => w.includes("creator_trading_fee_percentage is 0"))).toBe(true);
    expect(dbcConfigWarnings("partner", cfg).some((w) => w.includes("creator_trading_fee_percentage"))).toBe(false);
  });
});
