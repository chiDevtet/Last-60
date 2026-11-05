/**
 * Post-graduation groundwork, verified against REAL mainnet migrations (offline fixtures collected
 * with scripts/fetch-migration-fixtures.ts):
 *   - Meteora DBC pool AX7tzZ96… graduated to DAMM v2 pool 26n3vvi7… (tx 2xu4wQep…, slot 465800030)
 *   - Raydium LaunchLab pool 8AH7Rbje… graduated to CPMM pool 2ZJpQEny… (tx 371QXpQ6…, slot 465826675)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeTransaction } from "../src/chain/tx";
import { MeteoraDBCProvider } from "../src/providers/meteora/MeteoraDBCProvider";
import { decodeLaunchLabPool } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { dammV2ClaimableFees, decodeDammV2Pool, decodeDammV2Position, migrationVerified, parseMigration, verifyMigration, DAMM_V2_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID } from "../src/providers/migration";

const FIX = join(import.meta.dir, "fixtures/mainnet");
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

/** Read-only RPC stub serving the fixture's account snapshot. */
function fixtureRpc(fx: any): any {
  const acc = (a: string) => (fx.accounts[a] ? { owner: fx.accounts[a].owner, data: Buffer.from(fx.accounts[a].data, "base64"), lamports: 0, executable: false } : null);
  return { getAccountInfo: async (a: string) => ({ slot: fx.slot, value: acc(a) }), getMultipleAccounts: async (as: string[]) => ({ slot: fx.slot, value: as.map(acc) }) };
}

describe("Meteora DBC → DAMM v2", () => {
  const fx = load("migration-dbc-damm-v2.json");
  const m = parseMigration(normalizeTransaction(fx.tx), "meteora_dbc", fx.bondingPool)!;

  test("the destination pool and LP positions are read from the migration instruction itself", () => {
    expect(m.kind).toBe("dbc_damm_v2");
    expect(m.signature).toBe("2xu4wQep7zpgb8p6pm2DXJj7a6DUH72Z7361Si9rTjgKscsFJADyeMgTjCGJHdkNTXuHzQU9NdBjs1nJQxMDwV1c");
    expect(m.destinationProgram).toBe(DAMM_V2_PROGRAM_ID);
    expect(m.destinationPool).toBe("26n3vvi7yzVni6Aa57M9hyLPNsfkG13paeUdXY8zGtQG");
    expect(m.destinationConfig).toBe("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
    expect(m.positions[0]!.position).toBe("FHzjmKYDUm9s1tYsQbw9arPshHNRQQuvMgr1x3De6QN4");
  });

  test("the destination is proven on-chain: owner, mints, PDA(config, mints), creator = DBC pool authority", async () => {
    const v = await verifyMigration(fixtureRpc(fx), m, { base: m.baseMint, quote: m.quoteMint });
    expect(v.checks).toEqual({ destinationExists: true, ownedByExpectedProgram: true, mintsMatch: true, createdByDbcPoolAuthority: true, pdaDerivesFromConfigAndMints: true, positionsResolved: true });
    expect(migrationVerified(v)).toBe(true);
    // The LP position NFT is held by the bonding pool's creator…
    const dbc = new MeteoraDBCProvider(null, { poolAddress: fx.bondingPool, tokenMint: m.baseMint, role: "creator" });
    const bonding = dbc.decodePool(Buffer.from(fx.accounts[fx.bondingPool].data, "base64"));
    expect(v.positionStates).toHaveLength(1); // the config gave the partner 0% LP: no second position
    expect(v.positionStates[0]!.holder).toBe(bonding.creator);
  });

  test("position fee math reproduces the program's own accounting (claimable + claimed = pool LP fees, to rounding)", () => {
    const pool = decodeDammV2Pool(Buffer.from(fx.accounts[m.destinationPool].data, "base64"));
    const pos = decodeDammV2Position(Buffer.from(fx.accounts[m.positions[0]!.position].data, "base64"));
    const liquidity = pos.unlockedLiquidity + pos.vestedLiquidity + pos.permanentLockedLiquidity;
    expect(liquidity).toBe(pool.liquidity); // this position owns all liquidity
    const c = dammV2ClaimableFees(pool, pos);
    const totalA = c.a + pos.totalClaimedAFee;
    const totalB = c.b + pos.totalClaimedBFee;
    // floor() per accrual can only lose dust, never create value
    expect(totalA <= pool.totalLpAFee && pool.totalLpAFee - totalA <= 10n).toBe(true);
    expect(totalB <= pool.totalLpBFee && pool.totalLpBFee - totalB <= 10n).toBe(true);
    expect(pool.collectFeeMode).toBe(0); // BothToken: most LP fee value accrues in the token, not SOL
  });
});

describe("Raydium LaunchLab → CPMM", () => {
  const fx = load("migration-launchlab-cpmm.json");
  const m = parseMigration(normalizeTransaction(fx.tx), "raydium_launchlab", fx.bondingPool)!;

  test("the CPMM pool is read from migrate_to_cpswap and proven (owner, mints, config, PDA)", async () => {
    expect(m.kind).toBe("launchlab_cpmm");
    expect(m.destinationProgram).toBe(RAYDIUM_CPMM_PROGRAM_ID);
    expect(m.destinationPool).toBe("2ZJpQEnyTugE237Cs9X5FHPrXhPauC6DBx5jLV5FqyV7");
    const v = await verifyMigration(fixtureRpc(fx), m, { base: m.baseMint, quote: m.quoteMint });
    expect(v.checks).toEqual({ destinationExists: true, ownedByExpectedProgram: true, mintsMatch: true, configMatches: true, pdaDerivesFromConfigAndMints: true });
    // CPMM creator fees go to the LaunchLab token creator for this platform.
    const bonding = decodeLaunchLabPool(Buffer.from(fx.accounts[fx.bondingPool].data, "base64"));
    expect(bonding.status).toBe(2); // Trade = migrated
    expect(v.cpmmPoolCreator).toBe(bonding.creator);
  });
});

describe("no false positives", () => {
  test("ordinary swaps and claims are never mistaken for a migration", () => {
    for (const [name, provider] of [["dbc-buy-direct.json", "meteora_dbc"], ["dbc-sell.json", "meteora_dbc"], ["launchlab-buy-creatorfee.json", "raydium_launchlab"], ["launchlab-claim-creator.json", "raydium_launchlab"]] as const) {
      const tx = normalizeTransaction(load(name));
      for (const ix of tx.instructions) for (const a of ix.accounts) expect(parseMigration(tx, provider, a)).toBeNull();
    }
  });
});

describe("configuration warnings (real DBC config)", () => {
  test("a config where the creator earns 0% of bonding-curve fees is flagged instead of silently yielding fee-less rounds", async () => {
    const { dbcConfigWarnings } = await import("../src/providers/meteora/MeteoraDBCProvider");
    const f = load("dbc-accounts.json");
    const dbc = new MeteoraDBCProvider(null, { poolAddress: f.pool, tokenMint: f.baseMint, role: "creator" });
    const cfg = dbc.decodeConfig(Buffer.from(f.accounts[f.config].data, "base64"));
    expect(cfg.creatorTradingFeePercentage).toBe(0); // this real launchpad config gives the partner 100%
    expect(dbcConfigWarnings("creator", cfg).some((w) => w.includes("creator_trading_fee_percentage is 0"))).toBe(true);
    expect(dbcConfigWarnings("partner", cfg).some((w) => w.includes("creator_trading_fee_percentage"))).toBe(false);
  });
});
