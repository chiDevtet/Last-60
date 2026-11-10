/**
 * Meteora DBC launches end to end on REAL mainnet fixtures:
 *   - the pool is derived / discovered from the token mint (no POOL_ADDRESS needed);
 *   - after graduation to DAMM v2 the creator's migration-position LP fees are a collection stream
 *     (damm_v2_creator_lp_fee) that funds buyer rewards at the bonding-curve share (75 %), credited
 *     only from an observed creator → payout-wallet transfer naming the claim;
 *   - the auto-claim builds claim_position_fee for the creator's positions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { normalizeTransaction } from "../src/chain/tx";
import { instructionDiscriminator } from "../src/chain/anchorEvents";
import { big } from "../src/db/decimal";
import { MeteoraDBCProvider } from "../src/providers/meteora/MeteoraDBCProvider";
import { DBC_POOL_BASE_MINT_OFFSET, DBC_VIRTUAL_POOL_SIZE, deriveDbcPool, discoverDbcPool } from "../src/providers/meteora/pda";
import { parseMigration, verifyMigration, DAMM_V2_PROGRAM_ID, type VerifiedMigration } from "../src/providers/migration";
import { destinationSpec } from "../src/providers/destination";
import { DammV2Destination } from "../src/providers/destination/dammV2";
import { MigrationAwareProvider } from "../src/providers/MigrationAwareProvider";
import { APPROVED_SHARES, makeFundingPolicy, SPLIT_OF, STREAM_INFO, WSOL_MINT } from "../src/accounting/revenueStreams";
import { extractRevenue } from "../src/revenue/decode";
import { ingestRevenue, revenueFactsOf, type RevenueRuntime } from "../src/revenue/ingest";
import { buildRevenueReport } from "../src/revenue/report";
import { fixtureRpc, loadFixture } from "./fixtureRpc";
import { buildTx, memo, systemTransfer } from "./revenueTx";
import { freshDb, startDb, stopDb } from "./harness";
import idl from "../src/providers/destination/idl/damm_v2.json";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const migFx = loadFixture("migration-dbc-damm-v2.json");
const dFx = loadFixture("destination-damm-v2.json");
const dM = parseMigration(normalizeTransaction(migFx.tx), "meteora_dbc", migFx.bondingPool)!;
const PROGRAMS = { baseDecimals: 6, quoteDecimals: 9, baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };
const probe = new MeteoraDBCProvider(null, { poolAddress: migFx.bondingPool, tokenMint: dM.baseMint, role: "creator" });
const dPool = probe.decodePool(Buffer.from(migFx.accounts[migFx.bondingPool].data, "base64"));
const dCfg = probe.decodeConfig(Buffer.from(migFx.accounts[dPool.config].data, "base64"));
const onChainLp = Number(probe.hydrate(dPool, dCfg, PROGRAMS).feeParams.creatorLpPercentage);
const CREATOR = dPool.creator;
const claimTx = normalizeTransaction(dFx.txs.claimPositionFee);
const CLAIMED_SOL = 7_656_046n; // fee_b_claimed of the real claim (destination.test.ts)

function dbcOf(lpDeclared: number | null) {
  const dbc = new MeteoraDBCProvider(null, { poolAddress: migFx.bondingPool, tokenMint: dM.baseMint, role: "creator", expected: { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: lpDeclared, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: null } });
  const info = dbc.hydrate(dPool, dCfg, PROGRAMS);
  return { dbc, info };
}
let verified: VerifiedMigration;
async function providerOf(lpDeclared: number | null = onChainLp, rpc: ReturnType<typeof fixtureRpc> | null = null) {
  verified ??= await verifyMigration(fixtureRpc(migFx), dM, { base: dM.baseMint, quote: dM.quoteMint, bondingCreator: CREATOR, feeClaimer: dCfg.feeClaimer });
  const { dbc, info } = dbcOf(lpDeclared);
  const spec = destinationSpec(info, verified, dbc.lpCheck)!;
  const p = new MigrationAwareProvider(dbc, rpc);
  p.attach(spec);
  return p;
}
const DEST = Keypair.generate().publicKey.toBase58();
const ACT = dM.slot; // phase-aware activation before the graduation
const runtime = (): RevenueRuntime => ({ cluster: "mainnet-beta", policy: makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: ACT, ...APPROVED_SHARES }), fundingDestinations: [DEST], forgePlatformLpBeneficiary: null, correlationMode: "strict" });

describe("Meteora DBC pool from the token mint", () => {
  test("PDA [pool, config, max(base, quote), min(base, quote)] reproduces the real pool", () => {
    expect(deriveDbcPool(dPool.config, dM.baseMint, dCfg.quoteMint)).toBe(migFx.bondingPool);
  });

  test("the fixture pool stores base_mint at the discovery offset", () => {
    const data = Buffer.from(migFx.accounts[migFx.bondingPool].data, "base64");
    expect(data.length).toBe(DBC_VIRTUAL_POOL_SIZE);
    expect(new PublicKey(data.subarray(DBC_POOL_BASE_MINT_OFFSET, DBC_POOL_BASE_MINT_OFFSET + 32)).toBase58()).toBe(dM.baseMint);
  });

  test("discovery returns the canonical pool and ignores look-alike accounts", async () => {
    const real = migFx.accounts[migFx.bondingPool];
    const data = Buffer.from(real.data, "base64");
    const acc = (pubkey: string, owner = real.owner) => ({ pubkey, account: { data, owner, lamports: 1, executable: false } });
    let filters: any[] = [];
    const rpc = {
      getProgramAccounts: async (_p: string, o: { filters: unknown[] }) => {
        filters = o.filters as any[];
        // a copy at a non-canonical address and one owned by another program are both rejected
        return [acc(migFx.bondingPool), acc(Keypair.generate().publicKey.toBase58()), acc(Keypair.generate().publicKey.toBase58(), DAMM_V2_PROGRAM_ID)];
      },
    };
    expect(await discoverDbcPool(rpc, dM.baseMint)).toEqual({ status: "found", pool: migFx.bondingPool, config: dPool.config });
    expect(filters).toEqual([{ dataSize: DBC_VIRTUAL_POOL_SIZE }, { memcmp: { offset: DBC_POOL_BASE_MINT_OFFSET, bytes: dM.baseMint } }]);
    expect(await discoverDbcPool({ getProgramAccounts: async () => [] }, dM.baseMint)).toEqual({ status: "not_found" });
    expect((await discoverDbcPool({}, dM.baseMint)).status).toBe("unsupported");
  });
});

describe("DAMM v2 creator LP fees fund rewards after graduation", () => {
  test("stream model: a collection split 75 % rewards / 25 % creator, like the bonding curve", () => {
    expect(SPLIT_OF.damm_v2_creator_lp_fee).toEqual({ contribution: "damm_v2_creator_lp_last60_contribution", retained: "damm_v2_creator_lp_retained" });
    expect(STREAM_INFO.damm_v2_creator_lp_last60_contribution).toMatchObject({ phase: "post_migration", rewardEligible: true, allocationOwner: "creator", custodian: "creator" });
    expect(STREAM_INFO.damm_v2_creator_lp_fee.rewardEligible).toBe(false);
  });

  test("the real claim_position_fee of the creator's position is decoded as a creator LP collection", async () => {
    const p = await providerOf();
    const drafts = extractRevenue(claimTx, p.parseTransaction(claimTx), revenueFactsOf(p, runtime()));
    const cols = drafts.filter((d) => d.stream === "damm_v2_creator_lp_fee");
    const sol = cols.find((d) => d.feeMint === WSOL_MINT)!;
    expect(sol).toMatchObject({ kind: "collection", launchPhase: "post_migration", pool: dM.destinationPool, beneficiary: CREATOR, netAmount: CLAIMED_SOL });
    expect(sol.evidence.positionOwner).toBe(CREATOR);
    expect(cols.find((d) => d.feeMint === dM.baseMint)?.netAmount).toBe(15_462_119_758n);
  });

  test("a claim by anyone other than the launch creator is not this launch's revenue", async () => {
    const p = await providerOf();
    const facts = { ...revenueFactsOf(p, runtime()), creator: Keypair.generate().publicKey.toBase58() };
    expect(extractRevenue(claimTx, p.parseTransaction(claimTx), facts).filter((d) => d.stream === "damm_v2_creator_lp_fee")).toEqual([]);
  });

  test("claim + memo'd creator transfer → payable credit of exactly 75 % of the SOL claimed", async () => {
    const db = await freshDb();
    const p = await providerOf();
    const r = runtime();
    await ingestRevenue(db, claimTx, p.parseTransaction(claimTx), p, r, { commitment: "finalized" });
    const col: any = await db.RevenueEvent.findOne({ stream: "damm_v2_creator_lp_fee", feeMint: WSOL_MINT }).lean();
    expect(col).toMatchObject({ status: "collected", sourcePool: migFx.bondingPool, beneficiary: CREATOR });
    expect(col.snapshot.verification).toBe("verified");
    const rec: any = await db.RevenueReconciliation.findOne({ key: col.key }).lean();
    expect(big(rec.expectedLast60)).toBe((CLAIMED_SOL * 7_500n) / 10_000n);
    expect(rec.status).toBe("awaiting_distribution");

    const share = (CLAIMED_SOL * 7_500n) / 10_000n;
    const transfer = buildTx({ slot: claimTx.slot + 5, ixs: [systemTransfer(CREATOR, DEST, share), memo(`last60:v1:${claimTx.signature}`)], feePayer: CREATOR });
    expect((await ingestRevenue(db, transfer, p.parseTransaction(transfer), p, r, { commitment: "finalized" })).newCredits).toBe(1);
    const credit: any = await db.RewardFunding.findOne({}).lean();
    expect(credit).toMatchObject({ stream: "damm_v2_creator_lp_last60_contribution", correlationMethod: "memo", payoutEligible: true, launchPhase: "post_migration", creator: CREATOR, collectionKey: col.key });
    expect(big(credit.creditableAmount)).toBe(share);
    expect((await db.RevenueReconciliation.findOne({ key: col.key }).lean() as any).status).toBe("reconciled");
    const report = await buildRevenueReport(db, { sourcePool: migFx.bondingPool, policy: r.policy });
    expect(report.buyerRewards.verifiedDammV2CreatorLpFunding[WSOL_MINT]).toBe(share.toString());
    expect(report.postMigration.dammV2CreatorLp[WSOL_MINT]!.collections).toBe(1);
  });

  test("without a verified migrated-LP allocation (EXPECTED_DBC_CREATOR_LP_PERCENTAGE) nothing is creditable", async () => {
    const db = await freshDb();
    const p = await providerOf(null);
    const r = runtime();
    await ingestRevenue(db, claimTx, p.parseTransaction(claimTx), p, r, { commitment: "finalized" });
    const col: any = await db.RevenueEvent.findOne({ stream: "damm_v2_creator_lp_fee", feeMint: WSOL_MINT }).lean();
    expect(col.status).toBe("unresolved");
    expect(col.snapshot.problems.join(" ")).toContain("migrated_lp_allocation_not_declared");
    const transfer = buildTx({ slot: claimTx.slot + 5, ixs: [systemTransfer(CREATOR, DEST, 1_000n), memo(`last60:v1:${claimTx.signature}`)], feePayer: CREATOR });
    await ingestRevenue(db, transfer, p.parseTransaction(transfer), p, r, { commitment: "finalized" });
    const credit: any = await db.RewardFunding.findOne({}).lean();
    expect(credit.payoutEligible).toBe(false);
  });
});

describe("auto-claim of the creator's DAMM v2 position fees", () => {
  test("claim_position_fee discriminator matches the bundled IDL", () => {
    const ix = (idl as any).instructions.find((i: any) => i.name === "claim_position_fee");
    expect([...instructionDiscriminator("claim_position_fee")]).toEqual(ix.discriminator);
  });

  test("builds claim_position_fee for the creator's position with the IDL account order and unwraps WSOL", async () => {
    const p = await providerOf(onChainLp, fixtureRpc(migFx));
    const dest = p.destination as DammV2Destination;
    const claimer = new PublicKey(CREATOR);
    const info = p.inner.info();
    const plan = await dest.buildClaimInstructions(claimer, claimer, { [info.tokenMint]: info.baseTokenProgram, [info.quoteMint]: info.quoteTokenProgram });
    const state = plan.state!;
    expect(state.positions.map((x) => x.position)).toEqual([dM.positions[0]!.position]);
    const claims = plan.instructions.filter((i) => i.programId.toBase58() === DAMM_V2_PROGRAM_ID);
    // fixture state: fees accrued since the real claim (program formula), in both mints
    expect(state.unclaimedQuote).toBe(1_084_717n);
    expect(state.unclaimedBase).toBe(1_866_620_053_242n);
    expect(claims).toHaveLength(1);
    const keys = claims[0]!.keys.map((k) => k.pubkey.toBase58());
    const names = (idl as any).instructions.find((i: any) => i.name === "claim_position_fee").accounts.map((a: any) => a.name);
    expect(keys).toHaveLength(names.length);
    expect(keys[names.indexOf("pool")]).toBe(dM.destinationPool);
    expect(keys[names.indexOf("position")]).toBe(dM.positions[0]!.position);
    expect(keys[names.indexOf("signer")]).toBe(CREATOR);
    expect(claims[0]!.keys[names.indexOf("signer")]!.isSigner).toBe(true);
    // the WSOL account is closed back to the creator wallet after the claim
    expect(plan.instructions.at(-1)!.programId.toBase58()).toBe(PROGRAMS.quoteTokenProgram);
  });

  test("a stranger holding no position gets no DAMM v2 claim", async () => {
    const p = await providerOf(onChainLp, fixtureRpc(migFx));
    const st = await (p.destination as DammV2Destination).claimState(Keypair.generate().publicKey.toBase58());
    expect(st!.positions).toEqual([]);
  });
});
