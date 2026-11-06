/**
 * Pure (DB-free) guards added after PR #3:
 *   - historicalRecordConflict: role / provider / beneficiary / legacy / internally inconsistent
 *     snapshots, for swaps AND non-swap fee attributions;
 *   - snapshotFor: a record naming a basis the provider cannot produce gets no snapshot (fail closed);
 *   - storedSpecProblems: a persisted destination spec attaches only to the exact launch it was
 *     verified for (supported path, provider, pool, beneficiary, role, mints, verification record).
 */
import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { basesOf, basisDistributable, historicalRecordConflict, makeBasis, snapshotOf, type AllocationBasis } from "../src/accounting/attribution";
import { snapshotFor } from "../src/indexer/ingest";
import { storedSpecProblems } from "../src/providers/migrationAttach";

const k = () => Keypair.generate().publicKey.toBase58();
const POOL = k();
const DEST = k();
const CREATOR = k();
const basis = (o: Partial<AllocationBasis> = {}) => makeBasis({ provider: "meteora_dbc", pool: POOL, phase: "bonding_curve", role: "creator", beneficiary: CREATOR, params: { creatorTradingFeePercentage: 75 }, source: "cfg", verification: "verified", problems: [], ...o });
const B = basis();
const swap = (o: any = {}) => ({ provider: "meteora_dbc", pool: POOL, sourcePool: POOL, feePhase: "bonding_curve", beneficiary: CREATOR, basisId: B.id, basis: snapshotOf(B, POOL), signature: "s", slot: 1, ...o });
const LP = basis({ pool: DEST, phase: "migrated_lp", params: { positions: "p" } });
const attr = (o: any = {}) => ({ provider: "meteora_dbc", pool: DEST, sourcePool: POOL, destinationPool: DEST, phase: "migrated_lp", beneficiary: CREATOR, basisId: LP.id, basis: snapshotOf(LP, POOL), key: "cp", slot: 2, ...o });
const exp = { provider: "meteora_dbc", role: "creator", beneficiary: CREATOR };

describe("historicalRecordConflict", () => {
  test("matching swaps and LP checkpoints are compatible", () => {
    expect(historicalRecordConflict(swap(), exp, "swaps")).toBeNull();
    expect(historicalRecordConflict(attr(), exp, "fee_attributions")).toBeNull();
  });
  test("a different role conflicts — for swaps, LP checkpoints and fee collections alike", () => {
    const partner = { ...exp, role: "partner" };
    expect(historicalRecordConflict(swap(), partner, "swaps")).toContain('role "creator"');
    expect(historicalRecordConflict(attr(), partner, "fee_attributions")).toContain('role "creator"');
    expect(historicalRecordConflict(attr({ phase: "post_migration_trading", basis: snapshotOf(basis({ pool: DEST, phase: "post_migration_trading" }), POOL), basisId: basis({ pool: DEST, phase: "post_migration_trading" }).id }), partner, "fee_attributions")).toContain('role "creator"');
  });
  test("a different beneficiary or provider conflicts", () => {
    expect(historicalRecordConflict(swap(), { ...exp, beneficiary: k() }, "swaps")).toContain("beneficiary");
    expect(historicalRecordConflict(swap(), { ...exp, provider: "raydium_launchlab" }, "swaps")).toContain("provider");
  });
  test("legacy records without a snapshot conflict unless their basisId is a current basis", () => {
    expect(historicalRecordConflict(swap({ basis: null }), exp, "swaps")).toContain("legacy");
    expect(historicalRecordConflict(attr({ basis: null }), exp, "fee_attributions")).toContain("legacy");
    expect(historicalRecordConflict(attr({ basis: null }), { ...exp, currentBasisIds: new Set([LP.id]) }, "fee_attributions")).toBeNull();
    expect(historicalRecordConflict(attr({ basis: null, basisId: null }), { ...exp, currentBasisIds: new Set([LP.id]) }, "fee_attributions")).toContain("legacy");
  });
  test("a partial (pre-v1) snapshot is accepted only when its id proves a current basis", () => {
    const partial = { id: B.id, role: "creator", beneficiary: CREATOR, params: {} };
    expect(historicalRecordConflict(swap({ basis: partial }), exp, "swaps")).toContain("partial");
    expect(historicalRecordConflict(swap({ basis: partial }), { ...exp, currentBasisIds: new Set([B.id]) }, "swaps")).toBeNull();
  });
  test("internally inconsistent snapshots conflict (pool, phase, id, record beneficiary)", () => {
    expect(historicalRecordConflict(swap({ pool: k() }), exp, "swaps")).toContain("snapshot pool");
    expect(historicalRecordConflict(attr({ phase: "bonding_curve" }), exp, "fee_attributions")).toContain("phase");
    expect(historicalRecordConflict(swap({ basisId: "other" }), exp, "swaps")).toContain("basisId");
    expect(historicalRecordConflict(swap({ beneficiary: k() }), { ...exp, beneficiary: null }, "swaps")).toContain("record beneficiary");
  });
  test("DAMM v2 destination swaps carry the migrated-LP basis (no false conflict)", () => {
    expect(historicalRecordConflict(swap({ pool: DEST, feePhase: "post_migration_trading", basisId: LP.id, basis: snapshotOf(LP, POOL) }), exp, "swaps")).toBeNull();
  });
});

describe("snapshots", () => {
  test("snapshotOf keeps the complete basis; snapshotFor fails closed for unknown ids", () => {
    const info: any = { poolAddress: POOL, allocation: B, destination: { allocation: LP } };
    const s = snapshotFor(info, LP.id)!;
    expect(s).toEqual({ v: 1, id: LP.id, provider: "meteora_dbc", sourcePool: POOL, destinationPool: DEST, pool: DEST, phase: "migrated_lp", role: "creator", beneficiary: CREATOR, params: { positions: "p" }, source: "cfg", verification: "verified", problems: [] });
    expect(snapshotFor(info, "unknown")).toBeNull();
    expect(snapshotFor(info, null)).toBeNull();
    expect([...basesOf(info).keys()].sort()).toEqual([B.id, LP.id].sort());
  });
  test("only a verified basis is distributable", () => {
    expect(basisDistributable(B)).toBe(true);
    for (const v of ["not_declared", "mismatch", "unverifiable"] as const) expect(basisDistributable(basis({ verification: v }))).toBe(false);
    expect(basisDistributable(null)).toBe(false);
  });
});

describe("storedSpecProblems — reattachment never attaches a stale or mismatched destination", () => {
  const QUOTE = "So11111111111111111111111111111111111111112";
  const MINT = k();
  const info: any = { provider: "meteora_dbc", poolAddress: POOL, beneficiary: CREATOR, feeBeneficiaryRole: "creator", tokenMint: MINT, quoteMint: QUOTE };
  const spec = (o: any = {}) => ({ kind: "dbc_damm_v2", pool: DEST, program: "cpamd", ctx: { sourceProvider: "meteora_dbc", sourcePool: POOL, baseMint: MINT, quoteMint: QUOTE, beneficiary: CREATOR, migrationSlot: 10, migrationSignature: "sig" }, allocation: LP, ...o });
  const migration = (o: any = {}) => ({ status: "verified", verified: true, supported: true, requiredChecks: ["a", "b"], checks: { a: true, b: true }, destinationPool: DEST, signature: "sig", spec: spec(), ...o });
  test("a matching verified spec attaches", () => expect(storedSpecProblems(info, migration())).toEqual([]));
  test("unverified, failed checks, unsupported → refused", () => {
    expect(storedSpecProblems(info, migration({ status: "unverified", verified: false })).length).toBeGreaterThan(0);
    expect(storedSpecProblems(info, migration({ checks: { a: true, b: false } })).join()).toContain("required check");
    expect(storedSpecProblems(info, migration({ requiredChecks: [] })).join()).toContain("required check");
    expect(storedSpecProblems(info, migration({ supported: false })).join()).toContain("not a supported");
  });
  test("unsupported paths (DAMM v1, AMM v4) and cross-provider kinds are refused", () => {
    expect(storedSpecProblems(info, migration({ spec: spec({ kind: "dbc_damm_v1" }) })).join()).toContain("not the supported path");
    expect(storedSpecProblems(info, migration({ spec: spec({ kind: "launchlab_cpmm" }) })).join()).toContain("not the supported path");
    expect(storedSpecProblems({ ...info, provider: "raydium_launchlab" }, migration({ spec: spec({ kind: "launchlab_amm_v4" }) })).join()).toContain("not the supported path");
  });
  test("another pool's / beneficiary's / mint pair's / migration's spec is refused", () => {
    expect(storedSpecProblems({ ...info, poolAddress: k() }, migration()).join()).toContain("source pool");
    expect(storedSpecProblems({ ...info, beneficiary: k() }, migration()).join()).toContain("beneficiary");
    expect(storedSpecProblems({ ...info, tokenMint: k() }, migration()).join()).toContain("mints");
    expect(storedSpecProblems(info, migration({ destinationPool: k() })).join()).toContain("destination pool");
    expect(storedSpecProblems(info, migration({ signature: "other" })).join()).toContain("signature");
    expect(storedSpecProblems({ ...info, feeBeneficiaryRole: "partner" }, migration()).join()).toContain("basis");
  });
});
