/**
 * PR #5 follow-ups, on REAL mainnet fixtures:
 *   A. CPMM `creator_fee_on` (PoolState byte 389) is decoded to a verified mode and persisted through the
 *      verified migration, the destination spec, the immutable basis snapshot and the reports; an unknown
 *      mode fails closed.
 *   B. The per-creator `CreatorFeeShare` PDA (["creator_fee_share", pool_creator, amm_config]) overrides
 *      AmmConfig.creator_fee_share_rate; default / override / effective rates are reported separately; an
 *      unresolvable rate fails closed.
 * Plus historical (separate Fee Keys) vs post-upgrade (one platform Fee Key) lock handling for the Forge
 * platform LP stream.
 */
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { normalizeTransaction } from "../src/chain/tx";
import { RaydiumLaunchLabProvider, decodeLaunchLabPlatformConfig, decodeLaunchLabPool } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { COLLECT_CP_FEES_DISC, CREATOR_FEE_SHARE_SIZE, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CP_LOCK_PROGRAM_ID, cpmmCreatorNetAmount, creatorFeeMints, decodeCreatorFeeOn, decodeCreatorFeeShare, deriveCreatorFeeSharePda, parseMigration, resolveCreatorFeeShareRate, verifyMigration } from "../src/providers/migration";
import { cpmmCreatorFeeVerification, destinationSpec } from "../src/providers/destination";
import { basisDistributable, cpmmCreatorFeeBasisIncomplete, snapshotOf } from "../src/accounting/attribution";
import { buildAllocationReport } from "../src/accounting/allocationReport";
import { extractRevenue, type RevenueLaunchFacts } from "../src/revenue/decode";
import { fixtureRpc, loadFixture } from "./fixtureRpc";
import { buildTx, opaque, splTransfer } from "./revenueTx";

const llFx = loadFixture("migration-launchlab-cpmm.json");
const cFx = loadFixture("destination-cpmm.json");
const fsFx = loadFixture("cpmm-creator-fee-share.json");
const lM = parseMigration(normalizeTransaction(llFx.tx), "raydium_launchlab", llFx.bondingPool)!;
const llBonding = decodeLaunchLabPool(Buffer.from(llFx.accounts[llFx.bondingPool].data, "base64"));
const llPlatform = decodeLaunchLabPlatformConfig(Buffer.from(llFx.accounts[llBonding.platformConfig].data, "base64"));
const accounts = { ...cFx.accounts, ...llFx.accounts };
const ctx = { base: lM.baseMint, quote: lM.quoteMint, bondingCreator: llBonding.creator, platform: { cpConfig: llPlatform.cpConfig, platformCpCreator: null } };
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const verifiedExpected = { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: Number(llPlatform.creatorFeeRate), launchlabCreatorLpScale: null, launchlabPlatformConfig: llBonding.platformConfig };

const patchPool = (byte389: number) => (a: string, x: { owner: string; data: Buffer } | null) => {
  if (a !== lM.destinationPool || !x) return x;
  const d = Buffer.from(x.data);
  d[389] = byte389;
  return { ...x, data: d };
};
async function verify(patch?: Parameters<typeof fixtureRpc>[1]) {
  return verifyMigration(fixtureRpc({ ...llFx, accounts }, patch), lM, ctx);
}
function launch(expected = verifiedExpected) {
  const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role: "creator", expected });
  const info = ll.hydrate(llBonding, llPlatform, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN });
  return { ll, info };
}

describe("A. creator_fee_on mode", () => {
  test("decoding follows raydium-cp-swap CreatorFeeOn::from_u8; unknown values are not a mode", () => {
    expect([0, 1, 2].map(decodeCreatorFeeOn)).toEqual(["both_tokens", "only_token_0", "only_token_1"]);
    expect([3, 255, null, undefined].map(decodeCreatorFeeOn)).toEqual([null, null, null, null]);
    expect(creatorFeeMints("both_tokens", "A", "B")).toEqual(["A", "B"]);
    expect(creatorFeeMints("only_token_0", "A", "B")).toEqual(["A"]);
    expect(creatorFeeMints("only_token_1", "A", "B")).toEqual(["B"]);
  });

  test("real pool 2ZJpQEny…: creator_fee_on = 1 (only token_0 = WSOL) is verified and persisted to spec, basis and snapshot", async () => {
    const v = await verify();
    expect(v.cpmmCreatorFeeOnRaw).toBe(1);
    expect(v.cpmmCreatorFeeOn).toBe("only_token_0");
    expect(v.tokenAMint).toBe("So11111111111111111111111111111111111111112");
    const { ll, info } = launch();
    const spec = destinationSpec(info, v, ll.lpCheck, { platformNftWallet: llPlatform.platformLockNftWallet })!;
    expect(spec.cpmm!.creatorFeeOn).toBe("only_token_0");
    expect(spec.allocation.params.creatorFeeOn).toBe("only_token_0");
    expect(snapshotOf(spec.allocation, info.poolAddress).params.creatorFeeOn).toBe("only_token_0"); // immutable v1 snapshot
    expect(spec.allocation.verification).toBe("verified");
    expect(basisDistributable(spec.allocation)).toBe(true);
    // Allocation report shows the mode with the CPMM creator-fee row.
    const report = buildAllocationReport({ ...info, destination: { kind: spec.kind, program: spec.program, pool: spec.pool, migrationSlot: lM.slot, migrationSignature: lM.signature, supported: true, allocation: spec.allocation, lpAllocation: spec.lpAllocation } }, verifiedExpected);
    expect(report.rows.find((r) => r.parameter.startsWith("CPMM creator fee"))!.onChain).toContain('"creatorFeeOn":"only_token_0"');
  });

  test("all verified modes round-trip: both tokens, only token 0, only token 1 (each its own basis id)", async () => {
    const { ll, info } = launch();
    const ids = new Set<string>();
    for (const [raw, mode] of [[0, "both_tokens"], [1, "only_token_0"], [2, "only_token_1"]] as const) {
      const v = await verify(patchPool(raw));
      expect(v.cpmmCreatorFeeOn).toBe(mode);
      const spec = destinationSpec(info, v, ll.lpCheck)!;
      expect(spec.cpmm!.creatorFeeOn).toBe(mode);
      expect(spec.allocation.params.creatorFeeOn).toBe(mode);
      expect(spec.allocation.verification).toBe("verified");
      ids.add(spec.allocation.id);
    }
    expect(ids.size).toBe(3);
  });

  test("an unknown creator_fee_on byte fails closed: basis unverifiable, never distributable; never inferred from enable_creator_fee", async () => {
    const v = await verify(patchPool(3));
    expect(v.cpmmEnableCreatorFee).toBe(true); // the enable flag alone proves nothing about the mode
    expect(v.cpmmCreatorFeeOn).toBeNull();
    expect(v.notes.join(" ")).toContain("creator_fee_on byte 3");
    const { ll, info } = launch();
    const spec = destinationSpec(info, v, ll.lpCheck)!;
    expect(spec.allocation.verification).toBe("unverifiable");
    expect(spec.allocation.params.creatorFeeOn).toBe("unverified:3");
    expect(basisDistributable(spec.allocation)).toBe(false);
  });

  test("bases persisted before this PR (no creator_fee_on / effective rate) are never distributable, even if marked verified", () => {
    const legacy = { phase: "post_migration_trading" as const, provider: "raydium_launchlab", verification: "verified" as const, params: { cpmmPoolCreator: "x", enableCreatorFee: true, creatorFeeRate: "500", creatorFeeShareRate: "50000", creatorFeeIsBeneficiary: true } };
    expect(cpmmCreatorFeeBasisIncomplete(legacy)).toBe(true);
    expect(basisDistributable(legacy)).toBe(false);
    expect(basisDistributable({ ...legacy, params: { ...legacy.params, creatorFeeOn: "only_token_0", effectiveCreatorFeeShareRate: "50000" } })).toBe(true);
    // DBC / other phases are unaffected.
    expect(basisDistributable({ phase: "bonding_curve", provider: "raydium_launchlab", verification: "verified", params: {} })).toBe(true);
  });
});

describe("B. CreatorFeeShare override", () => {
  test("PDA derivation reproduces the account the REAL collect_creator_fee_permissionless transaction passed (#15)", () => {
    const tx = normalizeTransaction(cFx.txs.collectCreatorFee);
    const ix = tx.instructions.find((i) => i.programId === RAYDIUM_CPMM_PROGRAM_ID)!;
    const poolCreator = ix.accounts[1]!;
    const ammConfig = ix.accounts[14]!;
    expect(deriveCreatorFeeSharePda(poolCreator, ammConfig)).toBe(ix.accounts[15]!);
    expect(ix.accounts[15]).toBe("JBfL9sTQfkJyipttaCkLrnyp9rTNTDnqFgZemzXe3D7G");
    // That PDA held no lamports at collection (no override): the AmmConfig default applied.
    const i = tx.accountKeys.indexOf(ix.accounts[15]!);
    expect(tx.preBalances[i]).toBe(0n);
  });

  test("every CreatorFeeShare account on mainnet decodes with the verified layout and derives from (creator, amm_config)", () => {
    expect(fsFx.overrides.length).toBeGreaterThan(0);
    for (const o of fsFx.overrides) {
      const d = decodeCreatorFeeShare(Buffer.from(o.data, "base64"))!;
      expect(Buffer.from(o.data, "base64").length).toBe(CREATOR_FEE_SHARE_SIZE);
      expect(o.owner).toBe(RAYDIUM_CPMM_PROGRAM_ID);
      expect(d.creator).toBe(o.creator);
      expect(d.ammConfig).toBe(o.ammConfig);
      expect(d.shareRate.toString()).toBe(o.shareRate);
      expect(deriveCreatorFeeSharePda(d.creator, d.ammConfig)).toBe(o.address);
    }
    // One exists on Forgepad's AmmConfig C7Cx2p… — for one specific creator only.
    expect(fsFx.forgepadAmmConfigOverride.ammConfig).toBe("C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2");
    // Absent cases read null at a recorded slot.
    expect(fsFx.absentCases.every((c: any) => c.account === null && deriveCreatorFeeSharePda(c.poolCreator, c.ammConfig) === c.pda)).toBe(true);
  });

  test("real migration: no override for the pool creator → effective = AmmConfig default (50 000), reported separately", async () => {
    const v = await verify();
    expect(v.cpmmFeeShare).toMatchObject({ ammConfigDefaultRate: "50000", override: "absent", overrideRate: null, effectiveRate: "50000", source: "amm_config_default", overridePda: "JBfL9sTQfkJyipttaCkLrnyp9rTNTDnqFgZemzXe3D7G" });
    expect(v.cpmmFeeShare!.verifiedAtSlot).toBe(llFx.slot);
    const { ll, info } = launch();
    const spec = destinationSpec(info, v, ll.lpCheck)!;
    expect(spec.allocation.params).toMatchObject({ creatorFeeShareRate: "50000", creatorFeeShareOverride: "absent", effectiveCreatorFeeShareRate: "50000", creatorFeeSharePda: "JBfL9sTQfkJyipttaCkLrnyp9rTNTDnqFgZemzXe3D7G" });
  });

  test("an override for the pool creator takes precedence over the AmmConfig default (never silently the default)", async () => {
    const real = Buffer.from(fsFx.forgepadAmmConfigOverride.data, "base64");
    const pool = lM.destinationPool;
    const v0 = await verify();
    const data = Buffer.from(real);
    new PublicKey(v0.cpmmPoolCreator!).toBuffer().copy(data, 9);
    new PublicKey(lM.destinationConfig!).toBuffer().copy(data, 41);
    data.writeBigUInt64LE(123_456n, 73);
    const pda = deriveCreatorFeeSharePda(v0.cpmmPoolCreator!, lM.destinationConfig!);
    const v = await verify((a, x) => (a === pda ? { owner: RAYDIUM_CPMM_PROGRAM_ID, data } : x));
    expect(v.cpmmFeeShare).toMatchObject({ ammConfigDefaultRate: "50000", override: "present", overrideRate: "123456", effectiveRate: "123456", source: "creator_fee_share_override" });
    const { ll, info } = launch();
    const spec = destinationSpec(info, v, ll.lpCheck)!;
    expect(spec.allocation.params).toMatchObject({ creatorFeeShareRate: "50000", creatorFeeShareOverride: "123456", effectiveCreatorFeeShareRate: "123456" });
    expect(spec.allocation.id).not.toBe(destinationSpec(info, v0, ll.lpCheck)!.allocation.id);
    void pool;
  });

  test("precedence mirrors resolve_creator_fee_share_rate; invalid overrides fail closed", () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const cfg = Keypair.generate().publicKey.toBase58();
    const real = Buffer.from(fsFx.forgepadAmmConfigOverride.data, "base64");
    const forThis = (rate: bigint, c = creator, k = cfg) => {
      const d = Buffer.from(real);
      new PublicKey(c).toBuffer().copy(d, 9);
      new PublicKey(k).toBuffer().copy(d, 41);
      d.writeBigUInt64LE(rate, 73);
      return d;
    };
    const r = (pdaAccount: { owner: string; data: Buffer } | null, def: bigint | null = 50_000n) => resolveCreatorFeeShareRate({ poolCreator: creator, ammConfig: cfg, ammConfigDefaultRate: def, pdaAccount, slot: 7 });
    expect(r(null)).toMatchObject({ override: "absent", effectiveRate: "50000", source: "amm_config_default" });
    expect(r({ owner: RAYDIUM_CPMM_PROGRAM_ID, data: Buffer.alloc(0) })).toMatchObject({ effectiveRate: "50000" }); // empty account
    expect(r({ owner: "11111111111111111111111111111111", data: forThis(1n) })).toMatchObject({ override: "absent", effectiveRate: "50000" }); // not CPMM-owned → default (program rule)
    expect(r({ owner: RAYDIUM_CPMM_PROGRAM_ID, data: forThis(0n) })).toMatchObject({ override: "present", effectiveRate: "0" });
    expect(r({ owner: RAYDIUM_CPMM_PROGRAM_ID, data: Buffer.alloc(145, 1) })).toMatchObject({ override: "invalid", effectiveRate: null, source: "unresolved" });
    expect(r({ owner: RAYDIUM_CPMM_PROGRAM_ID, data: forThis(1_000_001n) })).toMatchObject({ override: "invalid", effectiveRate: null });
    expect(r({ owner: RAYDIUM_CPMM_PROGRAM_ID, data: forThis(5n, Keypair.generate().publicKey.toBase58()) })).toMatchObject({ override: "invalid", effectiveRate: null });
    expect(r(null, null)).toMatchObject({ effectiveRate: null, source: "unresolved" });
  });

  test("an unresolved effective rate makes the CPMM creator-fee basis unverifiable", async () => {
    const v0 = await verify();
    const pda = deriveCreatorFeeSharePda(v0.cpmmPoolCreator!, lM.destinationConfig!);
    const v = await verify((a, x) => (a === pda ? { owner: RAYDIUM_CPMM_PROGRAM_ID, data: Buffer.alloc(145, 9) } : x));
    expect(v.cpmmFeeShare!.effectiveRate).toBeNull();
    const { ll, info } = launch();
    const spec = destinationSpec(info, v, ll.lpCheck)!;
    expect(spec.allocation.verification).toBe("unverifiable");
    expect(spec.allocation.problems.join(" ")).toContain("share rate unresolved");
    expect(basisDistributable(spec.allocation)).toBe(false);
  });

  test("creator net = accrued − ⌊accrued × share / 1e6⌋ (program's own unit-test values)", () => {
    expect(cpmmCreatorNetAmount(1_000n, 200_000n)).toEqual({ creator: 800n, protocol: 200n });
    expect(cpmmCreatorNetAmount(1n, 200_000n)).toEqual({ creator: 1n, protocol: 0n });
    expect(cpmmCreatorNetAmount(9n, 200_000n)).toEqual({ creator: 8n, protocol: 1n });
    expect(cpmmCreatorNetAmount(1_000n, 0n)).toEqual({ creator: 1_000n, protocol: 0n });
    expect(cpmmCreatorNetAmount(1_000n, 1_000_000n)).toEqual({ creator: 0n, protocol: 1_000n });
    expect(() => cpmmCreatorNetAmount(1n, 1_000_001n)).toThrow();
  });

  test("EXPECTED_CPMM_CREATOR_FEE_RATE: a mismatch with AmmConfig.creator_fee_rate is flagged; a match inherits the bonding verification", async () => {
    const v = await verify();
    const bonding = { verification: "verified" as const, problems: [] };
    expect(cpmmCreatorFeeVerification(v, v.cpmmPoolCreator!, bonding, Number(v.cpmmConfig!.creatorFeeRate)).verification).toBe("verified");
    const mm = cpmmCreatorFeeVerification(v, v.cpmmPoolCreator!, bonding, 500);
    expect(v.cpmmConfig!.creatorFeeRate).not.toBe("500"); // this fixture's AmmConfig is not Forgepad's
    expect(mm.verification).toBe("mismatch");
    expect(cpmmCreatorFeeVerification(v, Keypair.generate().publicKey.toBase58(), bonding, null).verification).toBe("unverifiable");
  });
});

describe("historical vs post-upgrade Fee Keys — Forge platform LP stream", () => {
  const creator = llBonding.creator;
  const platformWallet = llPlatform.platformLockNftWallet!;
  function facts(spec: NonNullable<ReturnType<typeof destinationSpec>>, platformLocks: string[] | null, forge: string | null = platformWallet): RevenueLaunchFacts {
    const c = spec.cpmm!;
    return { provider: "raydium_launchlab", tokenMint: lM.baseMint, quoteMint: lM.quoteMint, sourcePool: llFx.bondingPool, creator, role: "creator", creatorClaimVaults: [], destination: { pool: spec.pool, kind: spec.kind, migrationSlot: lM.slot, token0Mint: c.token0Mint, token1Mint: c.token1Mint, token0Vault: c.token0Vault, token1Vault: c.token1Vault, poolCreator: c.poolCreator, platformLocks, platformNftWallet: platformWallet }, fundingDestinations: [], forgePlatformLpBeneficiary: forge };
  }
  function collectTx(spec: NonNullable<ReturnType<typeof destinationSpec>>, lockPda: string, signer: string, recipientOwner: string) {
    const c = spec.cpmm!;
    const a0 = Keypair.generate().publicKey.toBase58();
    const a1 = Keypair.generate().publicKey.toBase58();
    const accts = [Keypair.generate().publicKey.toBase58(), signer, Keypair.generate().publicKey.toBase58(), lockPda, RAYDIUM_CPMM_PROGRAM_ID, Keypair.generate().publicKey.toBase58(), spec.pool];
    return buildTx({ slot: lM.slot + 100, ixs: [opaque(RAYDIUM_CP_LOCK_PROGRAM_ID, accts, Buffer.concat([COLLECT_CP_FEES_DISC, Buffer.alloc(8)]), [splTransfer(c.token0Vault, a0, "auth", 4_000n), splTransfer(c.token1Vault, a1, "auth", 9n)])], tokens: { [a0]: { owner: recipientOwner, mint: c.token0Mint }, [a1]: { owner: recipientOwner, mint: c.token1Mint, decimals: 6 } } });
  }
  const none = { swaps: [], claims: [], anomalies: [], attributions: [] };

  test("post-upgrade (real migration): ONE platform Fee Key → Forge LP collection, per fee mint; never a creator entitlement", async () => {
    const v = await verify();
    const { ll, info } = launch();
    const spec = destinationSpec(info, v, ll.lpCheck, { platformNftWallet: platformWallet, creatorScale: "0", platformScale: "1000000" })!;
    expect(spec.cpmm!.allPlatformLocks!.map((l) => l.lockPda)).toEqual([lM.locks![0]!.lockPda]);
    expect(spec.cpmm!.beneficiaryLocks).toEqual([]); // no creator-owned LP entitlement
    const out = extractRevenue(collectTx(spec, lM.locks![0]!.lockPda, platformWallet, platformWallet), none, facts(spec, spec.cpmm!.allPlatformLocks!.map((l) => l.lockPda)));
    expect(out.map((d) => [d.stream, d.feeMint, d.netAmount, d.beneficiary, d.evidence.platformLock])).toEqual([
      ["forge_platform_lp_fee_collection", spec.cpmm!.token0Mint, 4_000n, platformWallet, true],
      ["forge_platform_lp_fee_collection", spec.cpmm!.token1Mint, 9n, platformWallet, true],
    ]);
  });

  test("historical (pre-upgrade) separate Fee Keys: the creator's lock is the creator's own LP revenue, not Forge's; the platform lock is Forge's", async () => {
    const v = await verify();
    const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role: "creator", expected: { ...verifiedExpected, launchlabCreatorLpScale: 200_000 } });
    const plat = { ...llPlatform, platformScale: 800_000n, creatorScale: 200_000n, burnScale: 0n };
    const info = ll.hydrate(llBonding, plat, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN });
    const pLock = v.locks[0]!;
    const creatorLock = Keypair.generate().publicKey.toBase58();
    const pre = { ...v, slot: 439_000_000, locks: [...v.locks, { ...pLock, lockPda: creatorLock, nftMint: Keypair.generate().publicKey.toBase58(), nftOwnerAtMigration: creator, lpAmount: (pLock.lpAmount * 200_000n) / 800_000n, holder: creator }] };
    const spec = destinationSpec(info, pre, ll.lpCheck, { creatorScale: "200000", platformScale: "800000", platformNftWallet: platformWallet })!;
    expect(spec.lpAllocation!.verification).toBe("verified"); // proven creator entitlement (pre-upgrade layout)
    const plocks = spec.cpmm!.allPlatformLocks!.map((l) => l.lockPda);
    expect(plocks).toEqual([pLock.lockPda]);
    expect(extractRevenue(collectTx(spec, creatorLock, creator, creator), none, facts(spec, plocks))).toEqual([]);
    expect(extractRevenue(collectTx(spec, pLock.lockPda, platformWallet, platformWallet), none, facts(spec, plocks)).map((d) => d.stream)).toEqual(["forge_platform_lp_fee_collection", "forge_platform_lp_fee_collection"]);
  });

  test("a spec without platform-lock facts: recorded only when the declared Forge beneficiary collected, and marked unknown (unresolved downstream)", async () => {
    const v = await verify();
    const { ll, info } = launch();
    const spec = destinationSpec(info, v, ll.lpCheck, { platformNftWallet: platformWallet })!;
    const lock = lM.locks![0]!.lockPda;
    const byForge = extractRevenue(collectTx(spec, lock, platformWallet, platformWallet), none, facts(spec, null));
    expect(byForge.every((d) => d.evidence.platformLock === "unknown")).toBe(true);
    expect(extractRevenue(collectTx(spec, lock, creator, creator), none, facts(spec, null))).toEqual([]);
  });
});
