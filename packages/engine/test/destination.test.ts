/**
 * Post-graduation adapters on REAL mainnet transactions (fixtures collected with
 * scripts/fetch-destination-fixtures.ts) and on synthetic transactions for cases not observed yet.
 * The creator is attributed only its actual entitlement: fee growth of LP positions it holds
 * (DAMM v2), creator fees as collected to it, and LP fees collected from the lock minted to it
 * (CPMM). Swaps on destination pools carry buyers, never creator fees.
 */
import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { normalizeTransaction, tokenAccountDelta } from "../src/chain/tx";
import { MeteoraDBCProvider } from "../src/providers/meteora/MeteoraDBCProvider";
import { RaydiumLaunchLabProvider, decodeLaunchLabPlatformConfig, decodeLaunchLabPool } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { parseMigration, verifyMigration, COLLECT_CP_FEES_DISC, RAYDIUM_CP_LOCK_PROGRAM_ID, type VerifiedMigration } from "../src/providers/migration";
import { buildDestination, destinationSpec } from "../src/providers/destination";
import { MigrationAwareProvider } from "../src/providers/MigrationAwareProvider";
import type { CheckpointState } from "../src/providers/LaunchProvider";
import { fixtureRpc, loadFixture } from "./fixtureRpc";

const WSOL = "So11111111111111111111111111111111111111112";

// ── DAMM v2 ──────────────────────────────────────────────────────────────────────────────────
const migFx = loadFixture("migration-dbc-damm-v2.json");
const dFx = loadFixture("destination-damm-v2.json");
const dM = parseMigration(normalizeTransaction(migFx.tx), "meteora_dbc", migFx.bondingPool)!;
const dbc = new MeteoraDBCProvider(null, { poolAddress: migFx.bondingPool, tokenMint: dM.baseMint, role: "creator", expected: { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: null } });
const dPool = dbc.decodePool(Buffer.from(migFx.accounts[migFx.bondingPool].data, "base64"));
const dCfg = dbc.decodeConfig(Buffer.from(migFx.accounts[dPool.config].data, "base64"));
const dInfo = dbc.hydrate(dPool, dCfg, { baseDecimals: 6, quoteDecimals: 9, baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
let dVerified: VerifiedMigration;

async function dammSpec(lp = dbc.lpCheck) {
  dVerified ??= await verifyMigration(fixtureRpc(migFx), dM, { base: dM.baseMint, quote: dM.quoteMint, bondingCreator: dPool.creator, feeClaimer: dCfg.feeClaimer });
  return destinationSpec(dInfo, dVerified, lp)!;
}

describe("DAMM v2 destination", () => {
  test("a verified migration yields a spec; an unverified one never does", async () => {
    const spec = await dammSpec();
    expect(spec.kind).toBe("dbc_damm_v2");
    expect(spec.ctx.migrationSlot).toBe(dM.slot);
    expect(spec.allocation.params.beneficiaryPositions).toBe(dM.positions[0]!.position);
    expect(destinationSpec(dInfo, { ...dVerified, checks: { ...dVerified.checks, mintsMatch: false } }, dbc.lpCheck)).toBeNull();
  });

  test("real swap: buyer tracking from EvtSwap2; LP fees are NOT attributed per swap", async () => {
    const a = buildDestination(await dammSpec(), null);
    const tx = normalizeTransaction(dFx.txs.swap);
    const p = a.parse(tx);
    expect(p.swaps).toHaveLength(1);
    const s = p.swaps[0]!;
    expect(s.pool).toBe(dM.destinationPool);
    expect(s.side).toBe("sell"); // AtoB with token A = the launched token
    expect(s.quoteAmount).toBe(6_506_169n); // equals the vault → user SOL transfer
    expect(s.trader).toBe("79MybfLXGj7N366Ebk7rg3oB5c9Y94XqTiiDCNri5KUo");
    expect(s.totalFeeMint).toBe(WSOL); // BothToken + AtoB → fee on the output token (B)
    expect(s.eligibleFee).toBe(0n);
    expect(s.excludedFee).toBe(s.totalFee);
    expect(s.feePhase).toBe("post_migration_trading");
  });

  test("real claim of the creator's position is recorded with exact token amounts", async () => {
    const a = buildDestination(await dammSpec(), null);
    const p = a.parse(normalizeTransaction(dFx.txs.claimPositionFee));
    expect(p.claims).toHaveLength(1);
    expect(p.claims[0]!.pool).toBe(dM.destinationPool);
    expect(p.claims[0]!.quoteAmount).toBe(7_656_046n); // fee_b_claimed (SOL)
    expect(p.claims[0]!.baseAmount).toBe(15_462_119_758n); // fee_a_claimed (token)
  });

  test("checkpoints attribute only the fee growth of positions the creator holds, exactly once", async () => {
    const spec = await dammSpec();
    const a = buildDestination(spec, fixtureRpc(migFx));
    const store = new Map<string, CheckpointState>();
    const prev = async (k: string) => store.get(k) ?? null;
    const first = await a.checkpoint!(migFx.slot, prev);
    const sol = first.find((r) => r.feeMint === WSOL)!;
    // Position fee growth = claimable + claimed (program formula), all of it the creator's here.
    const pos = (dVerified.positionStates[0]!);
    const quoteIsA = dVerified.tokenAMint === WSOL;
    expect(sol.creatorAmount).toBe(quoteIsA ? pos.claimableA + pos.claimedA : pos.claimableB + pos.claimedB);
    expect(sol.payoutEligible).toBe(true);
    expect(sol.status).toBe("observed");
    expect(sol.phase).toBe("migrated_lp");
    // Same chain state at the next snapshot → no new entitlement, nothing written.
    for (const r of first) store.set(r.evidence.checkpointKey as string, { cumulative: BigInt(r.evidence.cumulative as string), slot: r.slot });
    expect(await a.checkpoint!(migFx.slot + 1, prev)).toEqual([]);
  });

  test("a position held by someone else (unrelated LP / partner) is excluded, never the creator's", async () => {
    const spec = await dammSpec();
    const stranger = Keypair.generate().publicKey.toBase58();
    const a = buildDestination({ ...spec, ctx: { ...spec.ctx, beneficiary: stranger } }, fixtureRpc(migFx));
    const recs = await a.checkpoint!(migFx.slot, async () => null);
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(r.creatorAmount).toBe(0n);
      expect(r.payoutEligible).toBe(false);
      expect(r.excludedReason).toBe("position_not_held_by_beneficiary");
    }
  });

  test("a declared LP allocation that contradicts the config makes migrated LP fees ineligible (flagged, not substituted)", async () => {
    const lp = { verification: "mismatch" as const, problems: ["creator LP percentage is 100 on-chain but 75 was declared"] };
    const a = buildDestination(await dammSpec(lp), fixtureRpc(migFx));
    const recs = await a.checkpoint!(migFx.slot, async () => null);
    expect(recs.every((r) => !r.payoutEligible && r.status === "unresolved")).toBe(true);
  });

  test("a closed / unreadable position is unresolved: no amount is invented", async () => {
    const spec = await dammSpec();
    const a = buildDestination(spec, fixtureRpc(migFx, (addr, x) => (addr === dM.positions[0]!.position ? null : x)));
    const recs = await a.checkpoint!(migFx.slot, async () => null);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe("unresolved");
    expect(recs[0]!.creatorAmount).toBe(0n);
  });

  test("a fee counter that decreased is flagged and does not reset the stored cumulative", async () => {
    const a = buildDestination(await dammSpec(), fixtureRpc(migFx));
    const recs = await a.checkpoint!(migFx.slot, async () => ({ cumulative: 1n << 62n, slot: 1 }));
    expect(recs.every((r) => r.status === "unresolved" && r.creatorAmount === 0n && r.evidence.cumulative === (1n << 62n).toString())).toBe(true);
  });

  test("activity before the verified migration slot is rejected as an anomaly", async () => {
    const spec = await dammSpec();
    const a = buildDestination({ ...spec, ctx: { ...spec.ctx, migrationSlot: dFx.txs.swap.slot + 1 } }, null);
    const p = a.parse(normalizeTransaction(dFx.txs.swap));
    expect(p.swaps).toHaveLength(0);
    expect(p.anomalies.length).toBe(1);
  });

  test("the wrapper attaches the destination only from a spec, and detaches on null", async () => {
    const w = new MigrationAwareProvider(dbc, null);
    expect(w.info().accountingPools).toEqual([migFx.bondingPool]);
    w.attach(await dammSpec());
    expect(w.info().accountingPools).toEqual([migFx.bondingPool, dM.destinationPool]);
    expect(w.info().watchAddresses).toContain(dM.destinationPool);
    expect(w.info().watchFromSlot![dM.destinationPool]).toBe(dM.slot);
    expect(w.attach(await dammSpec())).toBe(false); // idempotent
    w.attach(null);
    expect(w.info().accountingPools).toEqual([migFx.bondingPool]);
  });
});

// ── CPMM ─────────────────────────────────────────────────────────────────────────────────────
const llFx = loadFixture("migration-launchlab-cpmm.json");
const cFx = loadFixture("destination-cpmm.json");
const lM = parseMigration(normalizeTransaction(llFx.tx), "raydium_launchlab", llFx.bondingPool)!;
const llBonding = decodeLaunchLabPool(Buffer.from(llFx.accounts[llFx.bondingPool].data, "base64"));
const llPlatform = decodeLaunchLabPlatformConfig(Buffer.from(llFx.accounts[llBonding.platformConfig].data, "base64"));

async function cpmmSpec(role: "creator" | "platform" = "creator", platformOverride = llPlatform) {
  const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role });
  const info = ll.hydrate(llBonding, platformOverride, { baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
  const v = await verifyMigration(fixtureRpc({ ...llFx, accounts: { ...cFx.accounts, ...llFx.accounts } }), lM, { base: lM.baseMint, quote: lM.quoteMint, bondingCreator: llBonding.creator, platform: { cpConfig: llPlatform.cpConfig, platformCpCreator: null } });
  return destinationSpec(info, v, ll.lpCheck, { creatorScale: platformOverride.creatorScale?.toString() ?? null })!;
}

describe("CPMM destination", () => {
  test("real swap: buyer tracking from the instruction's transfers; creator fee is only an estimate", async () => {
    const a = buildDestination(await cpmmSpec(), null);
    const p = a.parse(normalizeTransaction(cFx.txs.swapBaseInput));
    expect(p.anomalies).toEqual([]);
    expect(p.swaps).toHaveLength(1);
    const s = p.swaps[0]!;
    expect(s.side).toBe("sell");
    expect(s.quoteAmount).toBe(102_858_740n); // SOL vault → user transfer
    expect(s.eligibleFee).toBe(0n); // nothing payable at swap time
    expect(s.estimatedCreatorFee).toBe(1_561_077n); // SwapEvent.creator_fee accrued (before the protocol share)
    expect(s.totalFeeMint).toBe(WSOL); // creator_fee_on_input = false → output token
  });

  test("real creator-fee collection: exactly what the collect instruction transferred to the creator is payable", async () => {
    const a = buildDestination(await cpmmSpec(), null);
    const tx = normalizeTransaction(cFx.txs.collectCreatorFee);
    const p = a.parse(tx);
    const recs = p.attributions!.filter((r) => r.kind === "creator_fee_collection");
    expect(recs).toHaveLength(1);
    expect(recs[0]!.creatorAmount).toBe(1_683_458_372n);
    expect(recs[0]!.status).toBe("collected");
    expect(recs[0]!.payoutEligible).toBe(true);
    expect(recs[0]!.feeMint).toBe(WSOL);
    // The creator's token account changed by a DIFFERENT amount over the whole transaction (a later
    // instruction moved part of it): whole-transaction balance deltas would mis-attribute.
    expect(tokenAccountDelta(tx, recs[0]!.evidence.to as string)).toBe(1_090_712_680n);
  });

  test("CPMM creator fees of a pool whose creator is not the beneficiary are excluded", async () => {
    const a = buildDestination(await cpmmSpec("platform"), null);
    const recs = a.parse(normalizeTransaction(cFx.txs.collectCreatorFee)).attributions!;
    expect(recs[0]!.creatorAmount).toBe(0n);
    expect(recs[0]!.payoutEligible).toBe(false);
    expect(recs[0]!.excludedReason).toBe("cpmm_pool_creator_is_not_beneficiary");
  });

  test("creator_scale > 0 without a lock minted to the creator is unverifiable (never paid)", async () => {
    const spec = await cpmmSpec("creator", { ...llPlatform, creatorScale: 500_000n });
    expect(spec.lpAllocation!.verification).toBe("unverifiable");
    expect(spec.cpmm!.beneficiaryLocks).toEqual([]);
  });

  // Synthetic: collect_cp_fees on the LP-lock program (account order per the Raydium SDK).
  function lockCollectTx(o: { lockPda: string; signer: string; recipientOwner: string; amount0: bigint; amount1: bigint; slot: number }, spec: Awaited<ReturnType<typeof cpmmSpec>>) {
    const c = spec.cpmm!;
    const k = () => Keypair.generate().publicKey.toBase58();
    const userA = k(), userB = k();
    const keys = [k(), o.signer, k(), o.lockPda, "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", k(), spec.pool, k(), userA, userB, c.token0Vault, c.token1Vault, c.token0Mint, c.token1Mint, k(), RAYDIUM_CP_LOCK_PROGRAM_ID, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"];
    const idx = (a: string) => keys.indexOf(a);
    const transfer = (src: string, dst: string, amount: bigint) => {
      const d = Buffer.alloc(9);
      d[0] = 3;
      d.writeBigUInt64LE(amount, 1);
      return { programIdIndex: idx("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), accounts: [idx(src), idx(dst), 5], data: bs58.encode(d), stackHeight: 3 };
    };
    const bal = (acct: string, mint: string, amount: bigint) => ({ accountIndex: idx(acct), mint, owner: o.recipientOwner, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", uiTokenAmount: { amount: amount.toString(), decimals: 9 } });
    return {
      slot: o.slot,
      blockTime: 1,
      transaction: { signatures: [bs58.encode(Buffer.alloc(64, o.slot % 251))], message: { accountKeys: keys, header: { numRequiredSignatures: 2 }, instructions: [{ programIdIndex: idx(RAYDIUM_CP_LOCK_PROGRAM_ID), accounts: keys.slice(0, 15).map(idx), data: bs58.encode(Buffer.concat([COLLECT_CP_FEES_DISC, Buffer.alloc(8)])) }] } },
      meta: { err: null, fee: 5000, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: idx("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"), accounts: [], data: bs58.encode(Buffer.alloc(8)), stackHeight: 2 }, transfer(c.token0Vault, userA, o.amount0), transfer(c.token1Vault, userB, o.amount1)] }], preTokenBalances: [bal(userA, c.token0Mint, 0n), bal(userB, c.token1Mint, 0n)], postTokenBalances: [bal(userA, c.token0Mint, o.amount0), bal(userB, c.token1Mint, o.amount1)], preBalances: [], postBalances: [], logMessages: [] },
    };
  }

  /**
   * A PRE-upgrade migration (slot before the 2026-08-17 change) on a platform with platform_scale
   * 800 000 / creator_scale 200 000: the real platform lock plus a creator lock in the scale ratio —
   * the only lock layout that proves a creator-owned Fee Key.
   */
  async function provenCreatorLockSpec() {
    const creatorLock = Keypair.generate().publicKey.toBase58();
    const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role: "creator", expected: { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: 200_000 } });
    const plat = { ...llPlatform, platformScale: 800_000n, creatorScale: 200_000n, burnScale: 0n };
    const info = ll.hydrate(llBonding, plat, { baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    const v = await verifyMigration(fixtureRpc({ ...llFx, accounts: { ...cFx.accounts, ...llFx.accounts } }), lM, { base: lM.baseMint, quote: lM.quoteMint, bondingCreator: llBonding.creator, platform: { cpConfig: llPlatform.cpConfig, platformCpCreator: null } });
    const pLock = v.locks[0]!;
    expect(pLock.nftOwnerAtMigration).toBe(llPlatform.platformLockNftWallet!);
    const creatorAmount = (pLock.lpAmount * 200_000n) / 800_000n;
    const pre = { ...v, slot: 439_000_000, locks: [...v.locks, { ...pLock, lockPda: creatorLock, nftMint: Keypair.generate().publicKey.toBase58(), nftOwnerAtMigration: llBonding.creator, lpAmount: creatorAmount, holder: llBonding.creator }] };
    const spec = destinationSpec(info, pre, ll.lpCheck, { creatorScale: "200000", platformScale: "800000", platformNftWallet: llPlatform.platformLockNftWallet })!;
    return { spec, creatorLock };
  }

  test("locked-LP fee collection is attributed only from the creator's migration lock, signed by the creator", async () => {
    const { spec, creatorLock } = await provenCreatorLockSpec();
    expect(spec.lpAllocation!.verification).toBe("verified");
    expect(spec.cpmm!.beneficiaryLocks.map((l) => l.lockPda)).toEqual([creatorLock]);
    const a = buildDestination(spec, null);
    const creator = spec.ctx.beneficiary;
    const mine = a.parse(normalizeTransaction(lockCollectTx({ lockPda: creatorLock, signer: creator, recipientOwner: creator, amount0: 1_000n, amount1: 2_000n, slot: lM.slot + 10 }, spec))).attributions!;
    expect(mine.map((r) => [r.kind, r.phase, r.creatorAmount, r.payoutEligible])).toEqual([
      ["locked_lp_fee_collection", "migrated_lp", 1_000n, true],
      ["locked_lp_fee_collection", "migrated_lp", 2_000n, true],
    ]);
    // The platform's lock (100% of LP on this real platform) is never the creator's.
    const platformLock = lM.locks![0]!.lockPda;
    const theirs = a.parse(normalizeTransaction(lockCollectTx({ lockPda: platformLock, signer: llPlatform.platformLockNftWallet!, recipientOwner: llPlatform.platformLockNftWallet!, amount0: 5_000n, amount1: 7_000n, slot: lM.slot + 11 }, spec))).attributions!;
    expect(theirs.every((r) => r.creatorAmount === 0n && !r.payoutEligible && r.excludedReason === "platform_owned_locked_lp")).toBe(true);
    // The creator's lock collected by someone who bought the fee-key NFT: not the creator's anymore.
    const buyer = new PublicKey(Buffer.alloc(32, 8)).toBase58();
    const moved = a.parse(normalizeTransaction(lockCollectTx({ lockPda: creatorLock, signer: buyer, recipientOwner: buyer, amount0: 1n, amount1: 1n, slot: lM.slot + 12 }, spec))).attributions!;
    expect(moved.every((r) => r.creatorAmount === 0n && !r.payoutEligible)).toBe(true);
  });
});

// ── post-PR #3 coverage: holder changes, both mints, boundaries, multi-instruction collections ──
function tokenAccountData(mint: string, owner: string, amount = 1n): Buffer {
  const d = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(d, 0);
  new PublicKey(owner).toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  return d;
}

describe("DAMM v2 destination — entitlement follows the position NFT", () => {
  const stranger = Keypair.generate().publicKey.toBase58();
  const heldBy = (owner: string, which = 0) => (addr: string, x: any) => {
    const p = dM.positions[which]!;
    return addr === p.nftAccount ? { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: tokenAccountData(p.nftMint, owner) } : x;
  };

  test("creator and partner migration positions are each attributed to their actual holder", async () => {
    const spec = await dammSpec();
    expect(spec.dammV2!.positions.map((p) => p.position)).toEqual(dVerified.positionStates.map((p) => p.position)); // only positions that exist on-chain
    // Position 0 handed to the partner (or anyone else): its growth is excluded; others stay the creator's.
    const recs = await buildDestination(spec, fixtureRpc(migFx, heldBy(stranger, 0))).checkpoint!(migFx.slot, async () => null);
    const p0 = recs.filter((r) => r.evidence.position === dM.positions[0]!.position);
    expect(p0.length).toBeGreaterThan(0);
    expect(p0.every((r) => r.creatorAmount === 0n && r.excludedReason === "position_not_held_by_beneficiary" && r.evidence.holder === stranger)).toBe(true);
    for (const r of recs.filter((r) => r.evidence.position !== dM.positions[0]!.position)) expect(r.evidence.holder).not.toBe(stranger);
  });

  test("an NFT sold between checkpoints: growth before the sale is the creator's, after it is not", async () => {
    const spec = await dammSpec();
    const store = new Map<string, CheckpointState>();
    const prev = async (k: string) => store.get(k) ?? null;
    const before = await buildDestination(spec, fixtureRpc(migFx)).checkpoint!(migFx.slot, prev);
    const mine = before.filter((r) => r.evidence.position === dM.positions[0]!.position);
    expect(mine.some((r) => r.payoutEligible && r.creatorAmount > 0n)).toBe(true);
    // Pretend the counters were 100 lower at the previous checkpoint, then the NFT moved.
    for (const r of mine) store.set(r.evidence.checkpointKey as string, { cumulative: BigInt(r.evidence.cumulative as string) - 100n, slot: r.slot });
    const after = (await buildDestination(spec, fixtureRpc(migFx, heldBy(stranger, 0))).checkpoint!(migFx.slot + 50, prev)).filter((r) => r.evidence.position === dM.positions[0]!.position);
    expect(after.length).toBe(mine.length);
    expect(after.every((r) => r.grossAmount === 100n && r.creatorAmount === 0n && r.excludedAmount === 100n && !r.payoutEligible)).toBe(true);
  });

  test("fee growth is tracked per mint (both pool tokens), each with its own checkpoint key", async () => {
    const spec = await dammSpec();
    const recs = await buildDestination(spec, fixtureRpc(migFx)).checkpoint!(migFx.slot, async () => null);
    const mints = new Set(recs.map((r) => r.feeMint));
    for (const m of mints) expect([dVerified.tokenAMint, dVerified.tokenBMint]).toContain(m);
    const keys = recs.map((r) => r.evidence.checkpointKey);
    expect(new Set(keys).size).toBe(keys.length);
    // the non-payout mint is recorded as such, never converted (it stays in its own mint)
    for (const r of recs) expect(r.key).toContain(r.feeMint);
  });

  test("an increase since the previous checkpoint is attributed exactly once; re-reading the same snapshot is idempotent", async () => {
    const spec = await dammSpec();
    const a = buildDestination(spec, fixtureRpc(migFx));
    const first = await a.checkpoint!(migFx.slot, async () => null);
    const again = await a.checkpoint!(migFx.slot, async () => null);
    expect(again.map((r) => r.key)).toEqual(first.map((r) => r.key)); // same keys → persistAttributions keeps one
    const r0 = first.find((r) => r.creatorAmount > 0n)!;
    const inc = await a.checkpoint!(migFx.slot + 1, async (k) => (k === r0.evidence.checkpointKey ? { cumulative: BigInt(r0.evidence.cumulative as string) - 7n, slot: migFx.slot } : { cumulative: BigInt(first.find((x) => x.evidence.checkpointKey === k)?.evidence.cumulative as string ?? "0"), slot: migFx.slot }));
    expect(inc.map((r) => [r.evidence.checkpointKey, r.creatorAmount])).toEqual([[r0.evidence.checkpointKey, 7n]]);
  });

  test("migration-slot boundary: activity AT the migration slot is accepted, one slot before is not", async () => {
    const spec = await dammSpec();
    const at = buildDestination({ ...spec, ctx: { ...spec.ctx, migrationSlot: dFx.txs.swap.slot } }, null).parse(normalizeTransaction(dFx.txs.swap));
    expect(at.swaps).toHaveLength(1);
    expect(at.anomalies).toEqual([]);
    const before = buildDestination({ ...spec, ctx: { ...spec.ctx, migrationSlot: dFx.txs.swap.slot + 1 } }, null).parse(normalizeTransaction(dFx.txs.swap));
    expect(before.swaps).toHaveLength(0);
  });
});

describe("CPMM destination — collections", () => {
  test("accrued creator fee vs collected: only the collected transfer is payable; per-swap accruals are estimates", async () => {
    const spec = await cpmmSpec();
    const a = buildDestination(spec, null);
    const swap = a.parse(normalizeTransaction(cFx.txs.swapBaseInput)).swaps[0]!;
    expect(swap.eligibleFee).toBe(0n);
    expect(swap.estimatedCreatorFee).toBeGreaterThan(0n);
    expect(swap.excludedReason).toBe("creator_fee_accounted_at_collection");
    const coll = a.parse(normalizeTransaction(cFx.txs.collectCreatorFee)).attributions!.filter((r) => r.kind === "creator_fee_collection");
    // The protocol's creator_fee_share (AmmConfig or a per-creator CreatorFeeShare PDA) is retained in
    // the pool at collection; it is never transferred to the creator, so it is never counted.
    expect(coll.every((r) => r.status === "collected" && r.grossAmount === null)).toBe(true);
    expect(String(spec.allocation.params.creatorFeeShareRate)).toMatch(/^\d+$/);
  });

  test("the CPMM creator-fee basis is distributable only when the bonding allocation was verified", async () => {
    const s = await cpmmSpec(); // no declaration → not_declared → not distributable
    expect(s.allocation.verification).toBe("not_declared");
    const p = await cpmmSpec("platform");
    expect(p.allocation.verification).toBe("unverifiable"); // pool_creator is not the platform wallet
  });

  test("creator_scale > 0 declared as expected but no creator lock at migration → no creator entitlement, never distributable (2026-08-17 LaunchLab semantics)", async () => {
    const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role: "creator", expected: { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: 500_000 } });
    const plat = { ...llPlatform, creatorScale: 500_000n };
    const info = ll.hydrate(llBonding, plat, { baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    expect(ll.lpCheck.verification).toBe("verified"); // the config matches the declaration …
    const v = await verifyMigration(fixtureRpc({ ...llFx, accounts: { ...cFx.accounts, ...llFx.accounts } }), lM, { base: lM.baseMint, quote: lM.quoteMint, bondingCreator: llBonding.creator, platform: { cpConfig: llPlatform.cpConfig, platformCpCreator: null } });
    const spec = destinationSpec(info, v, ll.lpCheck, { creatorScale: "500000", platformScale: String(llPlatform.platformScale), platformNftWallet: llPlatform.platformLockNftWallet })!;
    // … but the migration minted no creator Fee Key: the declared config value matched, yet there is
    // no creator entitlement to pay — creator_scale is not payable to the creator.
    expect(spec.lpAllocation!.verification).toBe("unverifiable");
    expect(spec.cpmm!.beneficiaryLocks).toEqual([]);
    expect(spec.cpmm!.platformLocks!.map((l) => l.lockPda)).toEqual([lM.locks![0]!.lockPda]);
    expect(spec.lpAllocation!.problems.join()).toContain("2026-08-17");
  });

  function lockSpec(base: Awaited<ReturnType<typeof cpmmSpec>>, lockPda: string) {
    return { ...base, cpmm: { ...base.cpmm!, beneficiaryLocks: [{ lockPda, nftMint: Keypair.generate().publicKey.toBase58() }] } };
  }

  test("collection by the beneficiary's fee key but to the WRONG recipient is excluded", async () => {
    const lock = Keypair.generate().publicKey.toBase58();
    const spec = lockSpec(await cpmmSpec(), lock);
    const other = Keypair.generate().publicKey.toBase58();
    // reuse the synthetic builder from above via a fresh describe-scope copy
    const recs = buildDestination(spec, null).parse(normalizeTransaction(lockTx({ lockPda: lock, signer: spec.ctx.beneficiary, recipientOwner: other, amount0: 10n, amount1: 20n, slot: lM.slot + 20 }, spec))).attributions!;
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.creatorAmount === 0n && !r.payoutEligible && r.excludedReason === "position_not_held_by_beneficiary")).toBe(true);
  });

  test("several collection instructions in one transaction are each counted once, with distinct keys", async () => {
    const lock = Keypair.generate().publicKey.toBase58();
    const spec = lockSpec(await cpmmSpec(), lock);
    const raw: any = lockTx({ lockPda: lock, signer: spec.ctx.beneficiary, recipientOwner: spec.ctx.beneficiary, amount0: 10n, amount1: 20n, slot: lM.slot + 21 }, spec);
    const ix = raw.transaction.message.instructions[0];
    raw.transaction.message.instructions.push({ ...ix });
    raw.meta.innerInstructions.push({ ...raw.meta.innerInstructions[0], index: 1 });
    const recs = buildDestination(spec, null).parse(normalizeTransaction(raw)).attributions!;
    expect(recs).toHaveLength(4);
    expect(new Set(recs.map((r) => r.key)).size).toBe(4);
    expect(recs.reduce((s, r) => s + r.creatorAmount, 0n)).toBe(60n);
  });
});

// Synthetic collect_cp_fees (same account order as the builder in the CPMM block above).
function lockTx(o: { lockPda: string; signer: string; recipientOwner: string; amount0: bigint; amount1: bigint; slot: number }, spec: Awaited<ReturnType<typeof cpmmSpec>>) {
  const c = spec.cpmm!;
  const k = () => Keypair.generate().publicKey.toBase58();
  const userA = k(), userB = k();
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const keys = [k(), o.signer, k(), o.lockPda, "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", k(), spec.pool, k(), userA, userB, c.token0Vault, c.token1Vault, c.token0Mint, c.token1Mint, k(), RAYDIUM_CP_LOCK_PROGRAM_ID, TOKEN];
  const idx = (a: string) => keys.indexOf(a);
  const transfer = (src: string, dst: string, amount: bigint) => {
    const d = Buffer.alloc(9);
    d[0] = 3;
    d.writeBigUInt64LE(amount, 1);
    return { programIdIndex: idx(TOKEN), accounts: [idx(src), idx(dst), 5], data: bs58.encode(d), stackHeight: 3 };
  };
  const bal = (acct: string, mint: string, amount: bigint) => ({ accountIndex: idx(acct), mint, owner: o.recipientOwner, programId: TOKEN, uiTokenAmount: { amount: amount.toString(), decimals: 9 } });
  return {
    slot: o.slot,
    blockTime: 1,
    transaction: { signatures: [bs58.encode(Buffer.alloc(64, o.slot % 251))], message: { accountKeys: keys, header: { numRequiredSignatures: 2 }, instructions: [{ programIdIndex: idx(RAYDIUM_CP_LOCK_PROGRAM_ID), accounts: keys.slice(0, 15).map(idx), data: bs58.encode(Buffer.concat([COLLECT_CP_FEES_DISC, Buffer.alloc(8)])) }] } },
    meta: { err: null, fee: 5000, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: idx("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"), accounts: [], data: bs58.encode(Buffer.alloc(8)), stackHeight: 2 }, transfer(c.token0Vault, userA, o.amount0), transfer(c.token1Vault, userB, o.amount1)] }], preTokenBalances: [bal(userA, c.token0Mint, 0n), bal(userB, c.token1Mint, 0n)], postTokenBalances: [bal(userA, c.token0Mint, o.amount0), bal(userB, c.token1Mint, o.amount1)], preBalances: [], postBalances: [], logMessages: [] },
  };
}
