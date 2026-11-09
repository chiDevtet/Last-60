/**
 * Forgepad's actual LaunchLab PlatformConfig (5zZFa8Ki…, decoded on mainnet; fixture
 * test/fixtures/mainnet/forgepad-platform-config.json) and the accounting rules derived from it:
 *   - exact decode (repo decoder = Anchor IDL = Raydium SDK layout) and strict validation;
 *   - creator_fee_rate is a rate on trade value, never a split of the platform fee;
 *   - bonding-curve platform and creator fees are attributed separately;
 *   - creator_scale is never payable to the creator by itself; a creator LP entitlement needs a
 *     creator Fee Key proven by the migration's lock records (real pre/post-upgrade evidence);
 *   - post-graduation CPMM creator fees are attributed independently of locked LP;
 *   - unverified / ambiguous configuration stays ineligible;
 *   - immutable snapshots survive a configuration change;
 *   - indexer and rewards worker resolve the same verified basis.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PlatformConfig as SdkPlatformConfig } from "@raydium-io/raydium-sdk-v2";
import llIdl from "../src/providers/raydium/idl/raydium_launchpad.json";
import {
  decodeLaunchLabPlatformConfig,
  launchLabFeeSplit,
  LAUNCHLAB_PROGRAM_ID,
  RaydiumLaunchLabProvider,
  validateLaunchLabPlatformConfig,
  type LaunchLabPoolState,
} from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { classifyLaunchLabLocks, FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG, interpretPlatformConfig, LAUNCHLAB_LOCKED_LP_UPGRADE } from "../src/accounting/launchlabPlatform";
import { checkLaunchLabPlatformConfig, PLATFORM_CHECK_EXIT } from "../src/accounting/launchlabPlatformCheck";
import { buildAllocationReport, FORGEPAD_INTENDED } from "../src/accounting/allocationReport";
import { basisDistributable, basisPayable, makeBasis, snapshotOf } from "../src/accounting/attribution";
import { decodeCpmmConfig, parseMigration, verifyMigration } from "../src/providers/migration";
import { destinationSpec } from "../src/providers/destination";
import { normalizeTransaction } from "../src/chain/tx";
import { AnchorEventDecoder, toBig } from "../src/chain/anchorEvents";
import { loadConfig, type ExpectedAllocation } from "../src/config/env";
import { createProvider, providerTargetFor } from "../src/providers";
import { periodFees } from "../src/rewards/selection";
import { dec } from "../src/db/decimal";
import { fixtureRpc, loadFixture } from "./fixtureRpc";
import { rig, SOL, startDb, stopDb, wallet } from "./harness";

const FIX = join(import.meta.dir, "fixtures/mainnet");
const fixture = (n: string) => JSON.parse(readFileSync(join(FIX, n), "utf8"));
const FP = fixture("forgepad-platform-config.json");
const FP_DATA = Buffer.from(FP.platformConfig.data, "base64");
const CPMM_DATA = Buffer.from(FP.cpmmConfig.data, "base64");
const FORGEPAD_WALLET = "8KXqQwtrgtKxNfTWYsN34XNKXVQQR78JZfgbLorNL2n1";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const NONE: ExpectedAllocation = { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: null, launchlabPlatformConfig: null };
const FORGEPAD_DECL: ExpectedAllocation = { ...NONE, launchlabPlatformConfig: FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG, launchlabCreatorFeeRate: 5000, launchlabCreatorLpScale: 500_000 };
const forgepad = decodeLaunchLabPlatformConfig(FP_DATA);

/** A pool bound to Forgepad's PlatformConfig (synthetic PoolState; the PlatformConfig is real). */
function forgepadPool(creator = Keypair.generate().publicKey.toBase58(), platformConfig = FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG): LaunchLabPoolState {
  const k = () => Keypair.generate().publicKey.toBase58();
  return { status: 0, baseDecimals: 6, quoteDecimals: 9, platformFeeAccrued: 0n, globalConfig: "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX", platformConfig, baseMint: k(), quoteMint: WSOL, baseVault: k(), quoteVault: k(), creator };
}
function hydrated(expected: ExpectedAllocation, pool = forgepadPool(), platform = forgepad) {
  const p = new RaydiumLaunchLabProvider(null, { poolAddress: Keypair.generate().publicKey.toBase58(), tokenMint: pool.baseMint, role: "creator", expected });
  return { p, info: p.hydrate(pool, platform, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN }) };
}

describe("Forgepad PlatformConfig 5zZFa8Ki… — decoded on-chain values", () => {
  test("fixture provenance: the supplied address, owned by Raydium LaunchLab, 944 bytes", () => {
    expect(FP.platformConfig.address).toBe(FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG);
    expect(FP.platformConfig.owner).toBe(LAUNCHLAB_PROGRAM_ID);
    expect(FP_DATA.length).toBe(944);
  });

  test("exact decoded values", () => {
    expect(forgepad).toEqual({
      epoch: 969n,
      platformFeeWallet: FORGEPAD_WALLET,
      platformLockNftWallet: FORGEPAD_WALLET,
      platformScale: 500_000n,
      creatorScale: 500_000n,
      burnScale: 0n,
      feeRate: 10_000n,
      name: "Forge",
      web: "https://forgepad.fun",
      img: "https://i.postimg.cc/76TzYyFW/Forge-X-Logo.png",
      cpConfig: "C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2",
      creatorFeeRate: 5_000n,
      transferFeeExtensionAuth: FORGEPAD_WALLET,
      platformVestingWallet: FORGEPAD_WALLET,
      platformVestingScale: 0n,
      platformCpCreator: null,
      restrictGlobalConfig: 0,
      restrictCurveParam: 0,
      curveRuleManager: null,
    });
    expect(validateLaunchLabPlatformConfig({ owner: LAUNCHLAB_PROGRAM_ID, data: FP_DATA })).toMatchObject({ code: "ok", problems: [] });
  });

  test("three independent decoders agree: repo offsets, Anchor IDL v0.2.0, Raydium SDK 0.2.82-alpha layout", () => {
    const a: any = new BorshAccountsCoder(llIdl as any).decode("PlatformConfig", FP_DATA);
    expect(a.platform_fee_wallet.toBase58()).toBe(forgepad.platformFeeWallet);
    expect(a.platform_nft_wallet.toBase58()).toBe(forgepad.platformLockNftWallet!);
    expect([a.platform_scale, a.creator_scale, a.burn_scale, a.fee_rate, a.creator_fee_rate, a.platform_vesting_scale].map(String)).toEqual(["500000", "500000", "0", "10000", "5000", "0"]);
    expect(a.cpswap_config.toBase58()).toBe(forgepad.cpConfig!);
    expect(a.curve_params).toEqual([]); // legacy vec reading of the tail: empty, consistent with all-zero bytes
    const s: any = SdkPlatformConfig.decode(FP_DATA);
    expect([s.platformScale, s.creatorScale, s.burnScale, s.feeRate, s.creatorFeeRate].map(String)).toEqual(["500000", "500000", "0", "10000", "5000"]);
    expect(s.platformClaimFeeWallet.toBase58()).toBe(FORGEPAD_WALLET);
    expect([s.restrictGlobalConfig, s.restrictCurveParam]).toEqual([0, 0]);
  });

  test("Forgepad's CPMM AmmConfig (cpswap_config) decoded on-chain", () => {
    expect(FP.cpmmConfig.owner).toBe("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    expect(decodeCpmmConfig(CPMM_DATA)).toEqual({ tradeFeeRate: 40_000n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n, creatorFeeRate: 500n, creatorFeeShareRate: 50_000n });
  });

  test("strict validation rejects wrong owner, wrong discriminator, wrong size, unknown tail data and out-of-range values", () => {
    const v = (data: Buffer, owner = LAUNCHLAB_PROGRAM_ID) => validateLaunchLabPlatformConfig({ owner, data });
    expect(validateLaunchLabPlatformConfig(null).code).toBe("missing");
    expect(v(FP_DATA, "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C").code).toBe("wrong_owner");
    const bad = (f: (d: Buffer) => void) => {
      const d = Buffer.from(FP_DATA);
      f(d);
      return v(d);
    };
    expect(bad((d) => (d[0] = 0)).code).toBe("unsupported_layout");
    expect(v(FP_DATA.subarray(0, 940)).code).toBe("unsupported_layout");
    expect(v(Buffer.concat([FP_DATA, Buffer.alloc(8)])).code).toBe("unsupported_layout");
    expect(bad((d) => (d[940] = 1)).code).toBe("unsupported_layout"); // legacy vec length ≠ 0: ambiguous
    expect(bad((d) => (d[900] = 7)).code).toBe("unsupported_layout");
    expect(bad((d) => d.writeBigUInt64LE(400_000n, 88)).problems.join()).toContain("1000000"); // scales no longer sum to 1e6
    expect(bad((d) => d.writeBigUInt64LE(5_001n, 720)).problems.join()).toContain("MAX_CREATOR_FEE_RATE");
    expect(bad((d) => (d[832] = 2)).code).toBe("invalid_values");
  });

  test("the read-only check command maps every outcome to a distinct nonzero exit code", async () => {
    const accounts = { [FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG]: { owner: LAUNCHLAB_PROGRAM_ID, data: FP.platformConfig.data }, [FP.cpmmConfig.address]: { owner: FP.cpmmConfig.owner, data: FP.cpmmConfig.data } };
    const ok = await checkLaunchLabPlatformConfig(fixtureRpc({ accounts }), FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG);
    expect(ok.code).toBe("ok");
    expect(PLATFORM_CHECK_EXIT[ok.code]).toBe(0);
    expect(ok.streams.map((s) => [s.stream, s.status])).toEqual([
      ["bonding_platform_fee", "confirmed"],
      ["bonding_creator_fee", "requires_launch_evidence"],
      ["cpmm_creator_fee", "requires_launch_evidence"],
      ["platform_locked_lp", "confirmed"],
      ["creator_locked_lp", "requires_launch_evidence"],
    ]);
    const missing = await checkLaunchLabPlatformConfig(fixtureRpc({ accounts: {} }), FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG);
    const owner = await checkLaunchLabPlatformConfig(fixtureRpc({ accounts: { [FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG]: { owner: TOKEN, data: FP.platformConfig.data } } }), FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG);
    const noCpmm = await checkLaunchLabPlatformConfig(fixtureRpc({ accounts: { [FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG]: accounts[FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG]! } }), FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG);
    const codes = [missing, owner, noCpmm].map((r) => PLATFORM_CHECK_EXIT[r.code]);
    expect(codes).toEqual([2, 3, 5]);
  });
});

describe("rates: creator_fee_rate is a rate on trade value, never a split of the platform fee", () => {
  test("with Forgepad's rates on a 1 SOL buy: platform 1%, creator 0.5% — independent amounts", () => {
    const s = launchLabFeeSplit(SOL, { protocol: 2_500n, platform: forgepad.feeRate, creator: forgepad.creatorFeeRate });
    expect(s.total).toBe(17_500_000n); // 0.25% + 1% + 0.5%
    expect(s.platformFee).toBe(10_000_000n);
    expect(s.creatorFee).toBe(5_000_000n);
    // The misreading "creator gets 0.5% (5000 millionths) OF the platform fee" would be 50 000 lamports:
    expect((s.platformFee * forgepad.creatorFeeRate) / 1_000_000n).toBe(50_000n);
    expect(s.creatorFee).not.toBe(50_000n);
    // … and the DBC 25/75 split does NOT apply to LaunchLab: creator : platform is 1 : 2 here, not 75 : 25.
    expect(s.creatorFee * 2n).toBe(s.platformFee);
  });

  test("the interpretation never describes creator_fee_rate as a share of fees", () => {
    const st = interpretPlatformConfig(forgepad, null).find((x) => x.stream === "bonding_creator_fee")!;
    expect(st.explanation).toContain("0.5% of each trade");
    expect(st.explanation).toContain("independent of and additional to the platform fee");
  });

  test("bonding-curve platform and creator fees are attributed separately from the same real trade", async () => {
    const acc = fixture("launchlab-accounts.json");
    const accounts = new Map(Object.entries<any>(acc.accounts).map(([a, v]) => [a, { owner: v.owner, data: Buffer.from(v.data, "base64"), lamports: 1, executable: false }]));
    const rpc: any = { getAccountInfo: async (a: string) => ({ slot: 1, value: accounts.get(a) ?? null }) };
    const tx = normalizeTransaction(fixture("launchlab-buy-creatorfee.json"));
    const ev: any = new AnchorEventDecoder(LAUNCHLAB_PROGRAM_ID, llIdl as any).decodeAll(tx).find((e) => e.name === "TradeEvent")!.data;
    const creator = new RaydiumLaunchLabProvider(rpc, { poolAddress: acc.pool, tokenMint: acc.baseMint, role: "creator" });
    const platform = new RaydiumLaunchLabProvider(rpc, { poolAddress: acc.pool, tokenMint: acc.baseMint, role: "platform" });
    await creator.load();
    await platform.load();
    const c = creator.parseTransaction(tx).swaps[0]!;
    const p = platform.parseTransaction(tx).swaps[0]!;
    expect(c.eligibleFee).toBe(toBig(ev.creator_fee));
    expect(p.eligibleFee).toBe(toBig(ev.platform_fee));
    expect(c.eligibleFee).not.toBe(p.eligibleFee);
    expect(c.basisId).not.toBe(p.basisId);
    expect(c.eligibleFee + p.eligibleFee).toBeLessThan(c.totalFee); // protocol fee belongs to neither
    expect(creator.info().beneficiary).not.toBe(platform.info().beneficiary);
  });
});

describe("bonding-curve basis: platform identity AND rate", () => {
  test("Forgepad declarations on a Forgepad pool verify", () => {
    const { info } = hydrated(FORGEPAD_DECL);
    expect(info.allocation!.verification).toBe("verified");
    expect(basisDistributable(info.allocation!)).toBe(true);
  });

  test("a pool of ANOTHER platform with the same creator_fee_rate (real EB2LqTh8…, also 5000) is a mismatch — never paid", () => {
    const ll = loadFixture("migration-launchlab-cpmm.json");
    const pool = (ll.accounts as any)[ll.bondingPool];
    const { decodeLaunchLabPool } = require("../src/providers/raydium/RaydiumLaunchLabProvider");
    const ps = decodeLaunchLabPool(Buffer.from(pool.data, "base64"));
    const other = decodeLaunchLabPlatformConfig(Buffer.from((ll.accounts as any)[ps.platformConfig].data, "base64"));
    expect(other.creatorFeeRate).toBe(forgepad.creatorFeeRate);
    const { info } = hydrated(FORGEPAD_DECL, ps, other);
    expect(info.allocation!.verification).toBe("mismatch");
    expect(info.allocation!.problems.join()).toContain(FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG);
    expect(basisPayable(info.allocation!)).toBe(false);
  });

  test("a rate without the platform identity (or the reverse) is not_declared — never distributable", () => {
    for (const e of [{ ...NONE, launchlabCreatorFeeRate: 5000 }, { ...NONE, launchlabPlatformConfig: FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG }]) {
      const { info } = hydrated(e);
      expect(info.allocation!.verification).toBe("not_declared");
      expect(basisDistributable(info.allocation!)).toBe(false);
    }
  });

  test("Forgepad's LaunchLab declarations are the decoded on-chain values, not the DBC 25/75 percentages", () => {
    const ll = Object.fromEntries(FORGEPAD_INTENDED.raydium_launchlab.map((t) => [t.key, t.value]));
    expect(ll).toEqual({ launchlabPlatformConfig: FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG, launchlabCreatorFeeRate: Number(forgepad.creatorFeeRate), launchlabCreatorLpScale: Number(forgepad.creatorScale) });
    expect(Object.values(ll)).not.toContain(75);
    expect(FORGEPAD_INTENDED.meteora_dbc.map((t) => t.value)).toEqual([75, 75]);
  });
});

describe("locked LP: creator_scale is never, by itself, a creator entitlement", () => {
  const ev = FP.migrationLockEvidence;
  const locks = (m: any) => m.locks.map((l: any) => ({ lockPda: l.lockPda, nftMint: l.lockPda, nftOwnerAtMigration: l.owner, lpAmount: l.lp }));
  const realFacts = (m: any) => ({ locks: locks(m), beneficiary: m.creator, platformNftWallet: ev.platformNftWallet, platformScale: BigInt(ev.scales.platform), creatorScale: BigInt(ev.scales.creator), migrationSlot: m.slot });

  test("real post-upgrade migration (2026-08-18): the creator_scale Fee Key is minted to the PLATFORM — no creator entitlement", () => {
    for (const m of [ev.firstPostUpgrade, ev.recentPostUpgrade]) {
      const c = classifyLaunchLabLocks(realFacts(m));
      expect(c.creatorEntitlement).toBe("none");
      expect(c.creatorLocks).toEqual([]);
      expect(c.platformLocks).toHaveLength(1);
      expect(c.problems.join()).toContain("2026-08-17");
    }
  });

  test("real pre-upgrade migration (2026-08-14): the creator Fee Key is proven by the lock records", () => {
    const c = classifyLaunchLabLocks(realFacts(ev.lastPreUpgrade));
    expect(c.creatorEntitlement).toBe("proven");
    expect(c.creatorLocks.map((l) => l.lockPda)).toEqual([ev.lastPreUpgrade.locks[0].lockPda]);
    expect(ev.lastPreUpgrade.slot).toBeLessThanOrEqual(LAUNCHLAB_LOCKED_LP_UPGRADE.lastObservedPreUpgradeSlot);
  });

  test("a lock minted to the creator AFTER the upgrade cannot prove a creator entitlement", () => {
    const m = { ...ev.lastPreUpgrade, slot: LAUNCHLAB_LOCKED_LP_UPGRADE.firstObservedPostUpgradeSlot + 1 };
    expect(classifyLaunchLabLocks(realFacts(m)).creatorEntitlement).toBe("unprovable");
  });

  test("Forgepad: creator = platform NFT wallet → the Fee Key minted to it is platform-owned, never the creator's", () => {
    const one = [{ lockPda: "L1", nftMint: "N1", nftOwnerAtMigration: FORGEPAD_WALLET, lpAmount: 1_000n }];
    const c = classifyLaunchLabLocks({ locks: one, beneficiary: FORGEPAD_WALLET, platformNftWallet: FORGEPAD_WALLET, platformScale: 500_000n, creatorScale: 500_000n, migrationSlot: 466_000_000 });
    expect(c.creatorEntitlement).toBe("none");
    expect(c.platformLocks.map((l) => l.lockPda)).toEqual(["L1"]);
    expect(c.creatorLocks).toEqual([]);
    // Even with a pre-upgrade style second lock, both locks minted to the shared wallet are platform-owned.
    const two = [...one, { lockPda: "L2", nftMint: "N2", nftOwnerAtMigration: FORGEPAD_WALLET, lpAmount: 1_000n }];
    expect(classifyLaunchLabLocks({ locks: two, beneficiary: FORGEPAD_WALLET, platformNftWallet: FORGEPAD_WALLET, platformScale: 500_000n, creatorScale: 500_000n, migrationSlot: 400_000_000 }).creatorLocks).toEqual([]);
  });

  test("pre-upgrade layout checks: lock ratio, lock count and unknown platform wallet", () => {
    const creator = "C".repeat(43) + "1";
    const base = { beneficiary: creator, platformNftWallet: FORGEPAD_WALLET, platformScale: 500_000n, creatorScale: 500_000n, migrationSlot: 400_000_000 };
    const pl = { lockPda: "P", nftMint: "PN", nftOwnerAtMigration: FORGEPAD_WALLET, lpAmount: 1_000_000n };
    const cr = (lp: bigint) => ({ lockPda: "C", nftMint: "CN", nftOwnerAtMigration: creator, lpAmount: lp });
    expect(classifyLaunchLabLocks({ ...base, locks: [pl, cr(1_000_000n)] }).creatorEntitlement).toBe("proven");
    expect(classifyLaunchLabLocks({ ...base, locks: [pl, cr(2_000_000n)] }).creatorEntitlement).toBe("unprovable"); // wrong ratio
    expect(classifyLaunchLabLocks({ ...base, locks: [cr(1_000_000n)] }).creatorEntitlement).toBe("unprovable"); // platform lock missing
    expect(classifyLaunchLabLocks({ ...base, locks: [pl, cr(1n), { ...cr(1n), lockPda: "C2" }] }).creatorEntitlement).toBe("unprovable"); // two creator locks
    expect(classifyLaunchLabLocks({ ...base, platformNftWallet: null, locks: [pl, cr(1_000_000n)] }).creatorEntitlement).toBe("unprovable");
  });

  test("the report never marks creator_scale distributable, even when declared and equal to the chain", () => {
    const { p, info } = hydrated(FORGEPAD_DECL);
    expect(p.lpCheck.verification).toBe("verified"); // the config VALUE matches …
    const r = buildAllocationReport(info, FORGEPAD_DECL, p.lpCheck);
    const scale = r.rows.find((x) => x.parameter.startsWith("creator_scale"))!;
    expect(scale.verification).toBe("verified");
    expect(scale.distributable).toBe(false); // … but it is not an entitlement
    expect(r.rows.find((x) => x.parameter === "creator-owned locked-LP Fee Key")!.pendingLaunchEvidence).toBeTruthy();
    expect(r.outcome).toBe("verified");
    expect(info.warnings!.join()).toContain("not a creator fee");
  });
});

describe("post-graduation CPMM creator fees are attributed independently of locked LP", () => {
  test("verified CPMM creator-fee basis while the creator has NO locked-LP entitlement (real migration, creator_scale > 0)", async () => {
    const llFx = loadFixture("migration-launchlab-cpmm.json");
    const cFx = loadFixture("destination-cpmm.json");
    const lM = parseMigration(normalizeTransaction(llFx.tx), "raydium_launchlab", llFx.bondingPool)!;
    const { decodeLaunchLabPool } = require("../src/providers/raydium/RaydiumLaunchLabProvider");
    const pool = decodeLaunchLabPool(Buffer.from((llFx.accounts as any)[llFx.bondingPool].data, "base64"));
    const plat = decodeLaunchLabPlatformConfig(Buffer.from((llFx.accounts as any)[pool.platformConfig].data, "base64"));
    const expected = { ...NONE, launchlabPlatformConfig: pool.platformConfig, launchlabCreatorFeeRate: Number(plat.creatorFeeRate), launchlabCreatorLpScale: 500_000 };
    const pretend = { ...plat, platformScale: 500_000n, creatorScale: 500_000n }; // Forgepad-like scales
    const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role: "creator", expected });
    const info = ll.hydrate(pool, pretend, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN });
    const v = await verifyMigration(fixtureRpc({ ...llFx, accounts: { ...cFx.accounts, ...llFx.accounts } }), lM, { base: lM.baseMint, quote: lM.quoteMint, bondingCreator: pool.creator, platform: { cpConfig: plat.cpConfig, platformCpCreator: null } });
    const spec = destinationSpec(info, v, ll.lpCheck, { creatorScale: "500000", platformScale: "500000", platformNftWallet: plat.platformLockNftWallet })!;
    expect(spec.allocation.phase).toBe("post_migration_trading");
    expect(spec.allocation.verification).toBe("verified");
    expect(spec.lpAllocation!.phase).toBe("migrated_lp");
    expect(spec.lpAllocation!.verification).toBe("unverifiable");
    expect(new Set([info.allocation!.id, spec.allocation.id, spec.lpAllocation!.id]).size).toBe(3);
    expect(spec.cpmm!.platformLocks).toHaveLength(1);
  });
});

describe("creator wallet = platform NFT wallet (Forgepad's fee/NFT wallet launching a token)", () => {
  test("the platform's Fee Key minted to that wallet is never a creator LP entitlement, even with creator_scale declared", async () => {
    const llFx = loadFixture("migration-launchlab-cpmm.json");
    const cFx = loadFixture("destination-cpmm.json");
    const lM = parseMigration(normalizeTransaction(llFx.tx), "raydium_launchlab", llFx.bondingPool)!;
    const { decodeLaunchLabPool } = require("../src/providers/raydium/RaydiumLaunchLabProvider");
    const real = decodeLaunchLabPool(Buffer.from((llFx.accounts as any)[llFx.bondingPool].data, "base64"));
    const plat = { ...decodeLaunchLabPlatformConfig(Buffer.from((llFx.accounts as any)[real.platformConfig].data, "base64")), platformScale: 500_000n, creatorScale: 500_000n };
    const nftWallet = plat.platformLockNftWallet!;
    expect(lM.locks!.map((l) => l.nftOwnerAtMigration)).toEqual([nftWallet]); // the real single post-upgrade lock
    const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role: "creator", expected: { ...NONE, launchlabPlatformConfig: real.platformConfig, launchlabCreatorFeeRate: Number(plat.creatorFeeRate), launchlabCreatorLpScale: 500_000 } });
    const info = ll.hydrate({ ...real, creator: nftWallet }, plat, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN });
    expect(ll.lpCheck.verification).toBe("verified");
    expect(info.warnings!.join()).toContain("IS the platform NFT wallet");
    const v = await verifyMigration(fixtureRpc({ ...llFx, accounts: { ...cFx.accounts, ...llFx.accounts } }), lM, { base: lM.baseMint, quote: lM.quoteMint, bondingCreator: real.creator, platform: { cpConfig: plat.cpConfig, platformCpCreator: null } });
    const spec = destinationSpec(info, v, ll.lpCheck, { creatorScale: "500000", platformScale: "500000", platformNftWallet: nftWallet })!;
    expect(spec.cpmm!.beneficiaryLocks).toEqual([]); // previously: the platform lock, payable
    expect(spec.cpmm!.platformLocks!.map((l) => l.lockPda)).toEqual([lM.locks![0]!.lockPda]);
    expect(spec.lpAllocation!.verification).toBe("unverifiable");
    expect(basisPayable(spec.lpAllocation!)).toBe(false);
  });
});

describe("immutable snapshots and process consistency (MongoDB)", () => {
  beforeAll(startDb, 120_000);
  afterAll(stopDb);

  test("a PlatformConfig change creates a NEW basis; records under the old one keep their snapshot and cannot be rewritten", async () => {
    const r = await rig();
    const pool = forgepadPool();
    const before = hydrated(FORGEPAD_DECL, pool).info.allocation!;
    const changed = hydrated(FORGEPAD_DECL, pool, { ...forgepad, creatorFeeRate: 4_000n }).info.allocation!;
    expect(changed.id).not.toBe(before.id);
    expect(changed.verification).toBe("mismatch"); // declared 5000, chain now 4000
    // A verification-only change cannot alter the id (so it cannot re-label history either).
    expect(makeBasis({ ...before, verification: "mismatch", problems: ["x"] }).id).toBe(before.id);
    const row = (sig: string, slot: number, b: typeof before, fee: bigint) =>
      r.db.Swap.create({ signature: sig, eventIndex: 0, provider: "raydium_launchlab", pool: before.pool, sourcePool: before.pool, tokenMint: pool.baseMint, quoteMint: WSOL, side: "buy", trader: wallet(), traderSource: "payer", quoteAmount: dec(SOL), baseAmount: dec(1n), totalFee: dec(fee * 4n), eligibleFee: dec(fee), eligibleFeeMint: WSOL, slot, commitment: "finalized", source: "indexer", beneficiary: b.beneficiary, basisId: b.id, basis: snapshotOf(b, before.pool), feeStatus: "observed", payoutEligible: basisPayable(b) });
    await row("old", 10, before, 100n);
    await row("new", 20, changed, 80n);
    await expect(r.db.Swap.updateOne({ signature: "old" }, { $set: { basis: snapshotOf(changed, before.pool), basisId: changed.id } }).exec()).rejects.toThrow(/immutable/);
    const stored: any = await r.db.Swap.findOne({ signature: "old" }).lean();
    expect(stored.basis.id).toBe(before.id);
    expect(stored.basis.verification).toBe("verified");
    const f = await periodFees(r.db, { pool: [before.pool], afterSlot: 0, periodStartAt: null, snapshotSlot: 100 }, WSOL, { verifiedBasisIds: [] });
    expect(f.payout).toBe(100n); // only the record whose own snapshot was verified
  });

  test("indexer and rewards worker build the same provider target and resolve the same verified basis", () => {
    const env = { SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: "https://api.devnet.solana.com", MONGODB_URI: "mongodb://localhost/x", LAUNCH_PROVIDER: "raydium_launchlab", TOKEN_MINT: WSOL, POOL_ADDRESS: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", EXPECTED_LAUNCHLAB_PLATFORM_CONFIG: FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG, EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE: "5000", SCHEDULE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), PAYOUT_WALLET_PUBLIC_KEY: Keypair.generate().publicKey.toBase58(), REWARD_FUNDING_POLICY: "legacy_creator_fee_v1" /* devnet: no Forge platform wallet */ };
    const settings = { launchProvider: "raydium_launchlab" as const, poolAddress: env.POOL_ADDRESS, tokenMint: WSOL, feeBeneficiaryRole: "creator" as const, payoutAssetMint: WSOL };
    const targets = (["indexer", "rewards", "cli"] as const).map((role) => providerTargetFor(settings, loadConfig(role, env)));
    expect(targets[1]).toEqual(targets[0]!);
    expect(targets[2]).toEqual(targets[0]!);
    expect(targets[0]!.expected).toMatchObject({ launchlabPlatformConfig: FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG, launchlabCreatorFeeRate: 5000 });
    const pool = { ...forgepadPool(), baseMint: WSOL };
    const bases = targets.map((t) => {
      const p: any = createProvider(t, null);
      return p.inner.hydrate(pool, forgepad, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN }).allocation;
    });
    expect(bases[0].verification).toBe("verified");
    expect(bases.map((b: any) => b.id)).toEqual([bases[0].id, bases[0].id, bases[0].id]);
    expect(() => loadConfig("indexer", { ...env, EXPECTED_LAUNCHLAB_PLATFORM_CONFIG: "not-a-key" })).toThrow(/EXPECTED_LAUNCHLAB_PLATFORM_CONFIG/);
  });
});
