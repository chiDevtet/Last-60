/**
 * Phase-aware revenue ingestion, claim ↔ transfer reconciliation, funding credits and round funding,
 * on a real MongoDB replica set. The launch is the REAL LaunchLab → CPMM graduation fixture (verified
 * migration, real platform lock); Forge's claim / distribution transactions are synthetic because no
 * Forgepad LaunchLab launch has graduated yet (see docs/REWARD_FUNDING.md).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { normalizeTransaction } from "../src/chain/tx";
import { instructionDiscriminator } from "../src/chain/anchorEvents";
import { big, dec } from "../src/db/decimal";
import type { Models } from "../src/db/models";
import { RaydiumLaunchLabProvider, decodeLaunchLabPlatformConfig, decodeLaunchLabPool, LAUNCHLAB_PROGRAM_ID } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { COLLECT_CP_FEES_DISC, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CP_LOCK_PROGRAM_ID, parseMigration, verifyMigration } from "../src/providers/migration";
import { destinationSpec, type DestinationSpec } from "../src/providers/destination";
import { MigrationAwareProvider } from "../src/providers/MigrationAwareProvider";
import { FORGE_POLICY_DEFAULTS, makeFundingPolicy, WSOL_MINT } from "../src/accounting/revenueStreams";
import { ingestRevenue, reconcileFunding, type RevenueRuntime } from "../src/revenue/ingest";
import { buildRevenueReport, renderRevenueReport } from "../src/revenue/report";
import { ingestRawTransaction } from "../src/indexer/ingest";
import { fixtureRpc, loadFixture } from "./fixtureRpc";
import { addr, buildTx, memo, opaque, splTransfer, systemTransfer } from "./revenueTx";
import { freshDb, rig, SOL, startDb, stopDb, T0, wallet } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const llFx = loadFixture("migration-launchlab-cpmm.json");
const cFx = loadFixture("destination-cpmm.json");
const lM = parseMigration(normalizeTransaction(llFx.tx), "raydium_launchlab", llFx.bondingPool)!;
const llBonding = decodeLaunchLabPool(Buffer.from(llFx.accounts[llFx.bondingPool].data, "base64"));
const llPlatform = decodeLaunchLabPlatformConfig(Buffer.from(llFx.accounts[llBonding.platformConfig].data, "base64"));
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CREATOR = llBonding.creator;
const FORGE = llPlatform.platformLockNftWallet!; // the platform NFT wallet owns the platform Fee Key
const DEST = Keypair.generate().publicKey.toBase58(); // Last-60 funding destination (test wallet)
const ACT = lM.slot + 10; // phase-aware activation slot
const PLATFORM_LOCK = lM.locks![0]!.lockPda;

let spec: DestinationSpec;
async function baseSpec() {
  if (spec) return spec;
  const v = await verifyMigration(fixtureRpc({ ...llFx, accounts: { ...cFx.accounts, ...llFx.accounts } }), lM, { base: lM.baseMint, quote: lM.quoteMint, bondingCreator: CREATOR, platform: { cpConfig: llPlatform.cpConfig, platformCpCreator: null } });
  spec = destinationSpec(launch().info, v, launch().ll.lpCheck, { platformNftWallet: FORGE, creatorScale: "0", platformScale: "1000000" })!;
  return spec;
}
function launch(o: { verified?: boolean; creator?: string } = {}) {
  const expected = { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: o.verified === false ? null : Number(llPlatform.creatorFeeRate), launchlabCreatorLpScale: null, launchlabPlatformConfig: o.verified === false ? null : llBonding.platformConfig };
  const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role: "creator", expected });
  const info = ll.hydrate(o.creator !== undefined ? { ...llBonding, creator: o.creator } : llBonding, llPlatform, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN });
  return { ll, info };
}
async function providerOf(o: { verified?: boolean; creator?: string; dropPlatformLocks?: boolean } = {}) {
  const s = await baseSpec();
  const p = new MigrationAwareProvider(launch(o).ll, null);
  const sp = o.dropPlatformLocks ? { ...s, cpmm: { ...s.cpmm!, allPlatformLocks: undefined, platformLocks: undefined } } : s;
  p.attach({ ...sp, ctx: { ...sp.ctx, beneficiary: o.creator ?? CREATOR } });
  return p;
}
const runtime = (o: Partial<RevenueRuntime> = {}): RevenueRuntime => ({ cluster: "mainnet-beta", policy: makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: ACT, ...FORGE_POLICY_DEFAULTS }), fundingDestinations: [DEST], forgePlatformLpBeneficiary: FORGE, correlationMode: "strict", ...o });

// ── synthetic Forge / creator transactions ──────────────────────────────────────────────────
const CLAIM_CREATOR = instructionDiscriminator("claim_creator_fee");
function lpClaimIx(lock = PLATFORM_LOCK, signer = FORGE, amount0 = 1_000_000n, amount1 = 0n) {
  const c = spec.cpmm!;
  const ata0 = addr();
  const ata1 = addr();
  const accts = [addr(), signer, addr(), lock, RAYDIUM_CPMM_PROGRAM_ID, addr(), spec.pool];
  const inner = [splTransfer(c.token0Vault, ata0, "auth", amount0), ...(amount1 > 0n ? [splTransfer(c.token1Vault, ata1, "auth", amount1)] : [])];
  return { ix: opaque(RAYDIUM_CP_LOCK_PROGRAM_ID, accts, Buffer.concat([COLLECT_CP_FEES_DISC, Buffer.alloc(8)]), inner), tokens: { [ata0]: { owner: signer, mint: c.token0Mint }, [ata1]: { owner: signer, mint: c.token1Mint, decimals: 6 } } };
}
function bondingClaimIx(provider: MigrationAwareProvider, amount: bigint, recipientOwner = CREATOR) {
  const vault = provider.info().accounts.creatorFeeVault!;
  const ata = addr();
  return { ix: opaque(LAUNCHLAB_PROGRAM_ID, [recipientOwner, addr(), vault, ata], Buffer.from(CLAIM_CREATOR), [splTransfer(vault, ata, "auth", amount)]), tokens: { [ata]: { owner: recipientOwner, mint: WSOL_MINT } } };
}
async function ingest(db: Models, provider: MigrationAwareProvider, tx: ReturnType<typeof buildTx>, r = runtime()) {
  return ingestRevenue(db, tx, provider.parseTransaction(tx), provider, r, { commitment: "confirmed" });
}
const launchRef = (p: MigrationAwareProvider) => ({ sourcePool: p.info().poolAddress, quoteMint: p.info().quoteMint, provider: p.info().provider, tokenMint: p.info().tokenMint });

describe("Forge platform LP claims → 50 % Last-60 contribution", () => {
  test("Case A: claim and distribution in ONE transaction — instruction-level attribution, reconciled, creditable 50 %", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const tx = buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: claim.tokens });
    const res = await ingest(db, p, tx);
    expect(res).toEqual({ newEvents: 2, newCredits: 1 });
    const col: any = await db.RevenueEvent.findOne({ stream: "forge_platform_lp_fee_collection" }).lean();
    expect(col).toMatchObject({ kind: "collection", launchPhase: "post_migration", instructionIndex: 0, innerInstructionIndex: 0, ordinal: 1, beneficiary: FORGE, status: "collected", feeMint: WSOL_MINT, cluster: "mainnet-beta" });
    expect(col.snapshot).toMatchObject({ v: 1, verification: "verified", stream: "forge_platform_lp_fee_collection", policy: { version: "forge_phase_aware_v2", forgeLpLast60Bps: 5_000 } });
    const credit: any = await db.RewardFunding.findOne({}).lean();
    expect(credit).toMatchObject({ stream: "forge_platform_lp_last60_contribution", correlationMethod: "same_transaction", payoutEligible: true, status: "reconciled", fundingMint: WSOL_MINT, collectionKey: col.key });
    expect(big(credit.creditableAmount)).toBe(500_000n);
    const rec: any = await db.RevenueReconciliation.findOne({ key: col.key }).lean();
    expect(rec.status).toBe("reconciled");
    expect([rec.gross, rec.expectedLast60, rec.actualLast60, rec.expectedRetained, rec.impliedRetained, rec.untransferred].map(big)).toEqual([1_000_000n, 500_000n, 500_000n, 500_000n, 500_000n, 0n]);
  });

  test("Case B: separate transactions linked by memo; transfer indexed BEFORE the claim is linked once the claim arrives", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    const distTx = buildTx({ slot: ACT + 6, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 500_000n)] });
    expect((await ingest(db, p, distTx)).newCredits).toBe(0); // claim not indexed yet → stays unlinked
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    expect((await ingest(db, p, claimTx)).newCredits).toBe(1); // arrives later → linked by the durable claim record
    const c: any = await db.RewardFunding.findOne({}).lean();
    expect(c.correlationMethod).toBe("memo");
    expect(big(c.creditableAmount)).toBe(500_000n);
  });

  test("claim succeeds but the transfer fails / never happens: awaiting_distribution, untransferred balance, nothing creditable", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens }));
    // the distribution transaction failed on-chain: never counted
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [systemTransfer(FORGE, DEST, 500_000n)], err: { InstructionError: [0, "InsufficientFunds"] } }));
    const rec: any = await db.RevenueReconciliation.findOne({}).lean();
    expect(rec.status).toBe("awaiting_distribution");
    expect(big(rec.untransferred)).toBe(500_000n);
    expect(await db.RewardFunding.countDocuments()).toBe(0);
  });

  test("duplicate claim and duplicate distribution indexing (retries / re-indexing / restarts) never add funding", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const tx = buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: claim.tokens });
    await ingest(db, p, tx);
    for (let i = 0; i < 3; i++) expect(await ingest(db, await providerOf(), tx)).toEqual({ newEvents: 0, newCredits: 0 }); // fresh provider = worker restart
    expect(await db.RevenueEvent.countDocuments()).toBe(2);
    expect(await db.RewardFunding.countDocuments()).toBe(1);
    expect(await reconcileFunding(db, launchRef(p), runtime())).toBe(0);
    const report = await buildRevenueReport(db, { sourcePool: llFx.bondingPool, policy: runtime().policy, currentSlot: ACT + 100 });
    expect(report.buyerRewards.duplicateEventsRejected).toBe(6);
  });

  test("partial 50 % distribution, then the retry completes it; an extra transfer beyond the policy is excess, never creditable", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 200_000n)], tokens: claim.tokens });
    await ingest(db, p, claimTx);
    let rec: any = await db.RevenueReconciliation.findOne({}).lean();
    expect(rec.status).toBe("partial");
    expect(big(rec.untransferred)).toBe(300_000n);
    await ingest(db, p, buildTx({ slot: ACT + 8, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 300_000n)] }));
    rec = await db.RevenueReconciliation.findOne({}).lean();
    expect(rec.status).toBe("reconciled");
    await ingest(db, p, buildTx({ slot: ACT + 9, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 50_000n)] }));
    rec = await db.RevenueReconciliation.findOne({}).lean();
    expect(rec.status).toBe("excess");
    const credits: any[] = await db.RewardFunding.find({}).sort({ slot: 1 }).lean();
    expect(credits.map((c) => [big(c.observedAmount), big(c.creditableAmount), c.payoutEligible])).toEqual([[200_000n, 200_000n, true], [300_000n, 300_000n, true], [50_000n, 0n, false]]);
    expect(credits[2].ineligibleReason).toContain("exceeds_policy_amount");
    expect(credits.reduce((s, c) => s + big(c.creditableAmount), 0n)).toBe(500_000n); // never above 50 %
  });

  test("incorrect recipient, incorrect mint and an amount-only match never fund", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, p, claimTx);
    // incorrect recipient: Forge pays someone else → not an inflow at all
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, addr(), 500_000n)] }));
    // incorrect mint: an SPL transfer of another token into the destination, naming the WSOL claim
    const src = addr();
    const dst = addr();
    const other = Keypair.generate().publicKey.toBase58();
    await ingest(db, p, buildTx({ slot: ACT + 7, ixs: [memo(`last60:v1:${claimTx.signature}`), splTransfer(src, dst, FORGE, 500_000n)], tokens: { [src]: { owner: FORGE, mint: other }, [dst]: { owner: DEST, mint: other } } }));
    // exact expected amount, separate tx, no memo (strict): not linked by amount
    await ingest(db, p, buildTx({ slot: ACT + 8, ixs: [systemTransfer(FORGE, DEST, 500_000n)] }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    const report = await buildRevenueReport(db, { sourcePool: llFx.bondingPool, policy: runtime().policy, currentSlot: ACT + 100 });
    expect(report.buyerRewards.unlinkedFundingInflows.count).toBe(2);
    expect(report.postMigration.forgePlatformLp[WSOL_MINT]!.untransferred).toBe("500000");
  });

  test("multiple claims for the same token and multiple fee mints are reconciled independently, per mint", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const c1 = lpClaimIx(PLATFORM_LOCK, FORGE, 1_000_000n, 77n);
    const c2 = lpClaimIx(PLATFORM_LOCK, FORGE, 3_000_000n);
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [c1.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: c1.tokens }));
    await ingest(db, p, buildTx({ slot: ACT + 65, ixs: [c2.ix, systemTransfer(FORGE, DEST, 1_500_000n)], tokens: c2.tokens }));
    const recs: any[] = await db.RevenueReconciliation.find({}).sort({ collectionSlot: 1, collectionOrdinal: 1 }).lean();
    expect(recs.map((r) => [r.feeMint, r.status, big(r.actualLast60)])).toEqual([
      [WSOL_MINT, "reconciled", 500_000n],
      [spec.cpmm!.token1Mint, "awaiting_distribution", 0n], // token leg: never mixed with SOL
      [WSOL_MINT, "reconciled", 1_500_000n],
    ]);
    const report = await buildRevenueReport(db, { sourcePool: llFx.bondingPool, policy: runtime().policy });
    expect(report.postMigration.forgePlatformLp[WSOL_MINT]).toMatchObject({ collections: 2, grossClaimed: "4000000", last60FundingCreditable: "2000000", forgeRetainedExpected: "2000000", forgeRetainedObserved: null });
    expect(report.postMigration.forgePlatformLp[spec.cpmm!.token1Mint]).toMatchObject({ collections: 1, grossClaimed: "77", last60ExpectedContribution: "38" });
    expect(report.buyerRewards.eligibleBalanceByMint).toEqual({ [WSOL_MINT]: "2000000" });
    expect(renderRevenueReport(report)).toContain("Forge platform Fee Key LP fees claimed (gross)");
    expect(renderRevenueReport(report)).toContain("creator allocation → Last-60");
  });

  test("Forge beneficiary undeclared or ≠ platform_nft_wallet, or lock facts missing: claim unresolved, contribution never payable", async () => {
    for (const [r, o] of [[runtime({ forgePlatformLpBeneficiary: null }), {}], [runtime({ forgePlatformLpBeneficiary: addr() }), {}], [runtime(), { dropPlatformLocks: true }]] as const) {
      const db = await freshDb();
      const p = await providerOf(o);
      const claim = lpClaimIx();
      await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: claim.tokens }), r);
      const col: any = await db.RevenueEvent.findOne({ kind: "collection" }).lean();
      expect(col.status).toBe("unresolved");
      expect(col.snapshot.verification).not.toBe("verified");
      const c: any = await db.RewardFunding.findOne({}).lean();
      expect(c.payoutEligible).toBe(false);
      expect(c.ineligibleReason).toContain("collection_not_verified");
    }
  });

  test("exclusive_window (opt-in) links a separate, memo-less distribution only to the single open latest claim — recorded, never payable", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const r = runtime({ correlationMode: "exclusive_window" });
    const c1 = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [c1.ix], tokens: c1.tokens }), r);
    await ingest(db, p, buildTx({ slot: ACT + 6, ixs: [systemTransfer(FORGE, DEST, 500_000n)] }), r);
    const w: any = await db.RewardFunding.findOne({}).lean();
    expect(w.correlationMethod).toBe("exclusive_window");
    // Linked for reconciliation, but a positional link never names its claim: never payable (v2).
    expect(w.payoutEligible).toBe(false);
    expect(w.ineligibleReason).toContain("correlation_exclusive_window_not_payable");
    // Two open claims, then one memo-less transfer: ambiguous → stays unlinked.
    const c2 = lpClaimIx();
    const c3 = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 10, ixs: [c2.ix], tokens: c2.tokens }), r);
    await ingest(db, p, buildTx({ slot: ACT + 11, ixs: [c3.ix], tokens: c3.tokens }), r);
    await ingest(db, p, buildTx({ slot: ACT + 12, ixs: [systemTransfer(FORGE, DEST, 500_000n)] }), r);
    expect(await db.RewardFunding.countDocuments()).toBe(1);
  });

  test("worker restart between claim and distribution: durable claim record, linked exactly once", async () => {
    const db = await freshDb();
    const claim = lpClaimIx();
    const claimTx = buildTx({ slot: ACT + 5, ixs: [claim.ix], tokens: claim.tokens });
    await ingest(db, await providerOf(), claimTx);
    const restarted = await providerOf(); // new process, new provider instance
    await ingest(db, restarted, buildTx({ slot: ACT + 7, ixs: [memo(`last60:v1:${claimTx.signature}`), systemTransfer(FORGE, DEST, 500_000n)] }));
    expect(await db.RewardFunding.countDocuments({ payoutEligible: true })).toBe(1);
    expect((await db.RevenueReconciliation.findOne({}).lean() as any).status).toBe("reconciled");
  });

  test("policy gating: legacy policy records links but never funds; before activation never funds", async () => {
    for (const [r, slot, reason] of [[runtime({ policy: makeFundingPolicy({ version: "legacy_creator_fee_v1", activationSlot: null, ...FORGE_POLICY_DEFAULTS }) }), ACT + 5, "policy_legacy_creator_fee_v1"], [runtime(), ACT - 1, "before_policy_activation_slot"]] as const) {
      const db = await freshDb();
      const p = await providerOf();
      const claim = lpClaimIx();
      await ingest(db, p, buildTx({ slot, ixs: [claim.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: claim.tokens }), r);
      const c: any = await db.RewardFunding.findOne({}).lean();
      expect(c.payoutEligible).toBe(false);
      expect(c.ineligibleReason).toContain(reason);
      expect(big(c.creditableAmount)).toBe(0n);
    }
  });
});

describe("bonding-curve creator fees → 25 % creator / 75 % Last-60", () => {
  test("collected creator fee split 25 / 75: creator's contribution in the same transaction is verified and creditable", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = bondingClaimIx(p, 1_000_000_001n);
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(CREATOR, DEST, 750_000_000n)], tokens: claim.tokens }));
    const col: any = await db.RevenueEvent.findOne({ stream: "bonding_curve_creator_fee" }).lean();
    expect(col).toMatchObject({ launchPhase: "bonding_curve", beneficiary: CREATOR, status: "collected" });
    const rec: any = await db.RevenueReconciliation.findOne({ key: col.key }).lean();
    expect([rec.gross, rec.expectedLast60, rec.expectedRetained].map(big)).toEqual([1_000_000_001n, 750_000_000n, 250_000_001n]); // floor → dust stays with the creator
    expect(rec.status).toBe("reconciled");
    const c: any = await db.RewardFunding.findOne({}).lean();
    expect(c).toMatchObject({ stream: "bonding_curve_last60_reward_contribution", payoutEligible: true });
  });

  test("no contribution observed → nothing funded (the 75 % is never assumed); a contribution never comes from Forge for this stream", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = bondingClaimIx(p, 1_000_000n);
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 750_000n)], tokens: claim.tokens }));
    expect(await db.RewardFunding.countDocuments()).toBe(0); // Forge is not the recipient of the creator fee
    expect((await db.RevenueReconciliation.findOne({ stream: "bonding_curve_creator_fee" }).lean() as any).status).toBe("awaiting_distribution");
  });

  test("creator wallet changed (claim paid to another wallet) and missing creator association fail closed", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const old = addr();
    const claim = bondingClaimIx(p, 1_000_000n, old);
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(old, DEST, 750_000n)], tokens: claim.tokens }));
    const col: any = await db.RevenueEvent.findOne({ kind: "collection" }).lean();
    expect(col.status).toBe("unresolved");
    expect(col.snapshot.problems.join(" ")).toContain("is not the pool creator");
    expect(await db.RewardFunding.countDocuments()).toBe(0); // the old wallet is not a recognised funding source

    const db2 = await freshDb();
    const base = await providerOf();
    const q = Object.create(base) as MigrationAwareProvider; // same launch, but no creator association
    q.info = () => ({ ...base.info(), creator: "" });
    const c2 = bondingClaimIx(q, 1_000_000n, CREATOR);
    await ingest(db2, q, buildTx({ slot: ACT + 5, ixs: [c2.ix], tokens: c2.tokens }));
    const col2: any = await db2.RevenueEvent.findOne({ kind: "collection" }).lean();
    expect(col2.snapshot.problems).toContain("missing_creator_association");
  });

  test("an unverified bonding allocation (no declaration) never funds", async () => {
    const db = await freshDb();
    const p = await providerOf({ verified: false });
    const claim = bondingClaimIx(p, 1_000_000n);
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(CREATOR, DEST, 750_000n)], tokens: claim.tokens }));
    const c: any = await db.RewardFunding.findOne({}).lean();
    expect(c.payoutEligible).toBe(false);
    expect(c.ineligibleReason).toContain("bonding_curve_allocation_not_declared");
  });

  test("fees accrued before activation were already distributed under the legacy policy: absorbed first, never funded twice", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const info = p.info();
    // 400 000 creator-allocated lamports accrued at/before activation and never claimed before it.
    await db.Swap.create({ signature: "pre", eventIndex: 0, provider: info.provider, pool: info.poolAddress, tokenMint: info.tokenMint, quoteMint: info.quoteMint, side: "buy", trader: wallet(), traderSource: "payer", quoteAmount: dec(1n), baseAmount: dec(1n), totalFee: dec(1n), eligibleFee: dec(400_000n), eligibleFeeMint: info.quoteMint, slot: ACT - 3, commitment: "finalized", source: "indexer" });
    const claim = bondingClaimIx(p, 1_000_000n);
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(CREATOR, DEST, 750_000n)], tokens: claim.tokens }));
    const rec: any = await db.RevenueReconciliation.findOne({ stream: "bonding_curve_creator_fee" }).lean();
    expect(big(rec.expectedLast60)).toBe(450_000n); // 75 % of (1 000 000 − 400 000)
    expect(rec.discrepancies.join(" ")).toContain("pre_activation_accrual_excluded: 400000");
    const c: any = await db.RewardFunding.findOne({}).lean();
    expect([big(c.creditableAmount), big(c.excessAmount)]).toEqual([450_000n, 300_000n]);
  });
});

describe("CPMM creator trading fees stay direct creator revenue", () => {
  test("a real collect_creator_fee is recorded as cpmm_creator_trading_fee; a transfer to Last-60 can never be linked to it", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const real = normalizeTransaction(cFx.txs.collectCreatorFee);
    const res = await ingestRevenue(db, real, p.parseTransaction(real), p, runtime(), { commitment: "finalized" });
    expect(res.newEvents).toBe(1);
    const e: any = await db.RevenueEvent.findOne({}).lean();
    expect(e).toMatchObject({ stream: "cpmm_creator_trading_fee", launchPhase: "post_migration", grossAmount: null, beneficiary: CREATOR });
    expect(big(e.netAmount)).toBe(1_683_458_372n);
    expect(e.snapshot.effectiveFeeConfig).toMatchObject({ creatorFeeOn: "only_token_0", effectiveCreatorFeeShareRate: "50000", ammConfigCreatorFeeShareRate: "50000", creatorFeeShareOverride: "absent" });
    expect((await db.RevenueReconciliation.findOne({ key: e.key }).lean() as any).status).toBe("not_applicable");
    // The creator forwards an amount to Last-60 afterwards: no bonding / LP claim to link → never funding.
    await ingest(db, p, buildTx({ slot: real.slot + 1, ixs: [memo(`last60:v1:${real.signature}`), systemTransfer(CREATOR, DEST, 1_000n)] }));
    expect(await db.RewardFunding.countDocuments()).toBe(0);
    const report = await buildRevenueReport(db, { sourcePool: llFx.bondingPool, policy: runtime().policy });
    expect(report.postMigration.cpmmCreatorFees[WSOL_MINT]).toMatchObject({ collections: 1, netCreatorTransfers: "1683458372", rewardEligible: false });
    expect(report.buyerRewards.eligibleBalanceByMint).toEqual({});
  });
});

describe("immutability", () => {
  test("revenue events and credit amounts cannot be rewritten; only round bookkeeping changes", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const claim = lpClaimIx();
    await ingest(db, p, buildTx({ slot: ACT + 5, ixs: [claim.ix, systemTransfer(FORGE, DEST, 500_000n)], tokens: claim.tokens }));
    await expect(db.RevenueEvent.updateOne({}, { $set: { netAmount: dec(1n) } }).exec()).rejects.toThrow(/immutable/);
    await expect(db.RevenueEvent.updateOne({}, { $set: { "snapshot.verification": "verified" } }).exec()).rejects.toThrow(/immutable/);
    await expect(db.RewardFunding.updateOne({}, { $set: { creditableAmount: dec(9n) } }).exec()).rejects.toThrow(/immutable/);
    await expect(db.RewardFunding.updateOne({}, { $set: { payoutEligible: true } }).exec()).rejects.toThrow(/immutable/);
    await db.RewardFunding.updateOne({}, { $set: { roundNumber: 3 } }); // bookkeeping only
  });
});

describe("round funding (phase-aware policy)", () => {
  const W = 240_000;
  const EXEC = T0 + W + 30_000;
  test("verified, finalized credits fund the round once; REWARD_PERCENTAGE is not applied; unresolved / other-mint / unfinalized credits are not consumed", async () => {
    const r = await rig({ env: { REWARD_FUNDING_POLICY: "forge_phase_aware_v2", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "0", LAST60_FUNDING_DESTINATIONS: DEST, FORGE_PLATFORM_LP_BENEFICIARY: FORGE } });
    await r.worker.scheduler.tick(r.clock.now());
    const buyers = Array.from({ length: 6 }, wallet);
    const sigs: string[] = [];
    for (const w of buyers) {
      sigs.push(r.trade({ trader: w, quote: SOL / 10n }));
      r.chain.advance(2);
    }
    const policy = r.cfg.revenue.policy;
    const credit = async (o: { key: string; signature: string; amount: bigint; eligible?: boolean; mint?: string; slot?: number }) => {
      // Claim and distribution in the same transaction: both signatures are the credited one.
      await r.db.RevenueReconciliation.create({ key: `c:${o.key}`, stream: "forge_platform_lp_fee_collection", status: "reconciled", expectedLast60: dec(o.amount) });
      return r.db.RewardFunding.create({ key: o.key, stream: "forge_platform_lp_last60_contribution", collectionKey: `c:${o.key}`, collectionSignature: o.signature, correlationMethod: "same_transaction", provider: "mock", tokenMint: "m", sourcePool: "p", pool: "p", signature: o.signature, ordinal: 1, slot: o.slot ?? 5, collectionSlot: o.slot ?? 5, fundingMint: o.mint ?? WSOL_MINT, route: "last60_destination", destinationWallet: r.payer.publicKey.toBase58() /* direct into the payout wallet */, observedAmount: dec(o.amount), creditableAmount: dec(o.eligible === false ? 0n : o.amount), excessAmount: dec(0n), status: o.eligible === false ? "unresolved" : "reconciled", payoutEligible: o.eligible !== false, policy: { ...policy, v: 1 }, snapshot: { v: 1 } });
    };
    await credit({ key: "a", signature: sigs[0]!, amount: 300_000_000n });
    await credit({ key: "b", signature: sigs[1]!, amount: 200_000_000n });
    await credit({ key: "bad", signature: sigs[2]!, amount: 999_000_000n, eligible: false });
    await credit({ key: "usd", signature: sigs[3]!, amount: 5n, mint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB" });
    r.chain.advance(40); // finalize the credited transactions
    const late = r.trade({ trader: wallet(), kind: "sell", quote: 1n });
    await credit({ key: "unfinalized", signature: late, amount: 1_000_000n, slot: 6 });
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(EXEC);
    await r.worker.scheduler.tick(r.clock.now());
    const round: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(big(round.fees)).toBe(0n); // creator-allocated fees after activation are not distributed
    expect(big(round.funding)).toBe(500_000_000n);
    expect(big(round.reward)).toBe(500_000_000n); // 100 % of verified contributions; REWARD_PERCENTAGE (75 %) not applied
    expect(round.fundingPolicy).toMatchObject({ version: "forge_phase_aware_v2", inForce: "forge_phase_aware_v2", legacyFeeSlotCap: 0 });
    expect(round.fundingBreakdown).toMatchObject({ credits: 2, pendingFinality: 1, byStream: { forge_platform_lp_last60_contribution: "500000000" } });
    expect(BigInt(round.fundingBreakdown.creatorFeesRecordedNotDistributed)).toBeGreaterThan(0n);
    const consumed: any[] = await r.db.RewardFunding.find({ roundNumber: 1 }).lean();
    expect(consumed.map((c) => c.key).sort()).toEqual(["a", "b"]);
    expect(await r.db.RewardFunding.countDocuments({ key: { $in: ["bad", "usd", "unfinalized"] }, roundNumber: null })).toBe(3);
    const ledger: any[] = await r.db.LedgerEntry.find({ roundNumber: 1, type: "FUNDING_CREDITED" }).lean();
    expect(ledger.map((l) => big(l.amount))).toEqual([500_000_000n]);
    expect(big(round.perRecipient) * BigInt(round.recipientCount) + big(round.dust)).toBe(500_000_000n);
    const recon = await r.worker.reconciler.ledger();
    expect(recon.problems).toEqual([]);
    // A re-run of the same round can never consume the credits again.
    expect(await r.db.RewardFunding.countDocuments({ roundNumber: { $ne: null } })).toBe(2);
  });

  test("legacy policy (default): rounds are unchanged — contributions are never consumed", async () => {
    const r = await rig();
    await r.worker.scheduler.tick(r.clock.now());
    for (const w of Array.from({ length: 5 }, wallet)) {
      r.trade({ trader: w, quote: SOL / 10n });
      r.chain.advance(2);
    }
    const s = r.trade({ trader: wallet(), quote: SOL / 10n });
    await r.db.RewardFunding.create({ key: "x", stream: "forge_platform_lp_last60_contribution", collectionKey: "c", correlationMethod: "memo", provider: "mock", tokenMint: "m", sourcePool: "p", pool: "p", signature: s, ordinal: 1, slot: 5, collectionSlot: 5, fundingMint: WSOL_MINT, observedAmount: dec(9n * SOL), creditableAmount: dec(9n * SOL), excessAmount: dec(0n), status: "reconciled", payoutEligible: true, policy: { v: 1, version: "forge_phase_aware_v2" }, snapshot: { v: 1 } });
    r.chain.advance(40);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(T0 + W);
    await r.worker.scheduler.tick(r.clock.now());
    r.clock.set(EXEC);
    await r.worker.scheduler.tick(r.clock.now());
    const round: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(big(round.funding)).toBe(0n);
    expect(big(round.reward)).toBe((big(round.fees) * 7_500n) / 10_000n);
    expect(round.fundingPolicy.inForce).toBe("legacy_creator_fee_v1");
    expect(await r.db.RewardFunding.countDocuments({ roundNumber: null })).toBe(1);
    expect((await r.worker.reconciler.ledger()).problems).toEqual([]);
  });

  test("the indexer path records revenue too (ingestRawTransaction with a revenue runtime)", async () => {
    const r = await rig({ env: { LAST60_FUNDING_DESTINATIONS: DEST } });
    const s = r.trade({ trader: wallet(), quote: SOL / 10n });
    const raw = await r.chain.getTransactionRaw(s);
    const out = await ingestRawTransaction({ db: r.db, provider: r.provider, minBuyQuote: 0n, revenue: { cluster: "localnet", ...r.cfg.revenue } }, raw, { source: "indexer", commitment: "confirmed" });
    expect(out.newSwaps).toBe(1);
    expect(out.newRevenueEvents ?? 0).toBe(0); // a trade is not revenue of any stream
  });
});
