/**
 * Phase-aware revenue model (pure): stream classification, fee rate vs allocation, deterministic
 * split, versioned policy, claim ↔ transfer correlation, reconciliation, assets, memo parsing, the
 * transaction decoder, and configuration validation. No database, no RPC.
 */
import { describe, expect, test } from "bun:test";
import {
  assetOf,
  correlateTransfer,
  expectedSplit,
  FORGE_POLICY_DEFAULTS,
  makeFundingPolicy,
  NATIVE_SOL,
  parseFundingMemo,
  phaseAwareInForce,
  reconcileCollection,
  REVENUE_STREAMS,
  SPLIT_OF,
  STREAM_INFO,
  WSOL_MINT,
  type CollectionFact,
  type TransferFact,
} from "../src/accounting/revenueStreams";
import { extractRevenue, fundingMemoOf, type RevenueLaunchFacts } from "../src/revenue/decode";
import { ConfigError, FORGEPAD_PLATFORM_NFT_WALLET, loadConfig, PENDING_ACTIVATION_SLOT } from "../src/config/env";
import { revenueRuntimeOf } from "../src/revenue/ingest";
import { Keypair } from "@solana/web3.js";
import { addr, buildTx, memo, sig, splTransfer, splTransferChecked, systemTransfer } from "./revenueTx";

const SOL = 1_000_000_000n;
const USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";

describe("revenue streams", () => {
  test("thirteen distinct streams; only the four Last-60 contributions are reward-eligible; all are CREATOR allocations", () => {
    expect(STREAM_INFO.forge_platform_lp_last60_contribution).toMatchObject({ beneficiary: "last60", allocationOwner: "creator", custodian: "forge", rewardEligible: true });
    expect(STREAM_INFO.bonding_curve_last60_reward_contribution).toMatchObject({ beneficiary: "last60", allocationOwner: "creator", custodian: "creator", rewardEligible: true });
    expect(STREAM_INFO.forge_platform_lp_retained).toMatchObject({ beneficiary: "forge", allocationOwner: "forge", rewardEligible: false });
    expect(STREAM_INFO.cpmm_creator_trading_fee).toMatchObject({ beneficiary: "creator", allocationOwner: "creator", rewardEligible: false });
    expect(REVENUE_STREAMS).toHaveLength(13);
    const eligible = REVENUE_STREAMS.filter((s) => STREAM_INFO[s].rewardEligible);
    expect(eligible.sort()).toEqual(["bonding_curve_last60_reward_contribution", "damm_v2_creator_lp_last60_contribution", "forge_platform_lp_last60_contribution", "pumpswap_creator_last60_contribution"]);
    expect(eligible.every((s) => STREAM_INFO[s].allocationOwner === "creator")).toBe(true);
    // Creator retained 25 %, CPMM creator fees and Forge retained 50 % are never buyer-reward funding.
    for (const s of ["bonding_curve_creator_retained", "cpmm_creator_trading_fee", "forge_platform_lp_retained", "bonding_curve_creator_fee", "forge_platform_lp_fee_collection"] as const) expect(STREAM_INFO[s].rewardEligible).toBe(false);
    expect(STREAM_INFO.forge_platform_lp_fee_collection.beneficiary).toBe("forge"); // platform-owned Fee Key, not creator-owned
    expect(STREAM_INFO.cpmm_creator_trading_fee.beneficiary).toBe("creator");
    expect(SPLIT_OF.cpmm_creator_trading_fee).toBeNull(); // never shared, never in the Forge LP split
    expect(SPLIT_OF.bonding_curve_creator_fee!.contribution).toBe("bonding_curve_last60_reward_contribution");
    expect(SPLIT_OF.forge_platform_lp_fee_collection!.retained).toBe("forge_platform_lp_retained");
  });

  test("a fee RATE is not an allocation: 0.50 % of volume is charged, then 25 / 75 of what was COLLECTED", () => {
    const volume = 1_000n * SOL;
    const rate = 5_000n; // 0.50 % in millionths (LaunchLab creator_fee_rate)
    const collected = (volume * rate) / 1_000_000n; // illustrative only: accounting uses observed amounts
    expect(collected).toBe(5n * SOL);
    const s = expectedSplit(collected, FORGE_POLICY_DEFAULTS.bondingCreatorFeeLast60Bps);
    expect(s.last60).toBe(3_750_000_000n); // 75 % of the 5 SOL collected — not 75 % of volume
    expect(s.retained).toBe(1_250_000_000n);
    // The example in the business rules: 1 SOL collected → 0.25 creator, 0.75 Last-60.
    expect(expectedSplit(SOL, 7_500)).toEqual({ last60: 750_000_000n, retained: 250_000_000n });
    // Forge LP: 50 / 50 of the actual claim.
    expect(expectedSplit(SOL, FORGE_POLICY_DEFAULTS.forgeLpLast60Bps)).toEqual({ last60: 500_000_000n, retained: 500_000_000n });
  });

  test("deterministic integer rounding: the contribution floors, the residual stays with the retaining party", () => {
    expect(expectedSplit(3n, 7_500)).toEqual({ last60: 2n, retained: 1n });
    expect(expectedSplit(1n, 5_000)).toEqual({ last60: 0n, retained: 1n });
    expect(expectedSplit(999_999n, 7_500)).toEqual({ last60: 749_999n, retained: 250_000n }); // 6-decimals token
    expect(expectedSplit(0n, 7_500)).toEqual({ last60: 0n, retained: 0n });
    for (const g of [1n, 7n, 12_345_678_901n, 18_446_744_073_709_551_615n]) {
      for (const bps of [0, 1, 5_000, 7_500, 10_000]) {
        const x = expectedSplit(g, bps);
        expect(x.last60 + x.retained).toBe(g); // never creates or loses value
        expect(x.last60 * 10_000n).toBeLessThanOrEqual(g * BigInt(bps));
      }
    }
    expect(() => expectedSplit(-1n, 7_500)).toThrow();
    expect(() => expectedSplit(1n, 10_001)).toThrow();
  });
});

describe("versioned funding policy", () => {
  test("ids hash every parameter; phase-aware needs an activation slot; legacy and the retired v1 never fund from contributions", () => {
    const legacy = makeFundingPolicy({ version: "legacy_creator_fee_v1", activationSlot: null, ...FORGE_POLICY_DEFAULTS });
    const a = makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: 100, ...FORGE_POLICY_DEFAULTS });
    const b = makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: 101, ...FORGE_POLICY_DEFAULTS });
    expect(a.id).not.toBe(b.id);
    expect(makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: 100, ...FORGE_POLICY_DEFAULTS }).id).toBe(a.id);
    expect(() => makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: null, ...FORGE_POLICY_DEFAULTS })).toThrow();
    // The approved shares are fixed under v2.
    expect(() => makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: 100, bondingCreatorFeeLast60Bps: 7_000, forgeLpLast60Bps: 5_000 })).toThrow("approved model");
    expect(() => makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot: 100, bondingCreatorFeeLast60Bps: 7_500, forgeLpLast60Bps: 10_000 })).toThrow("approved model");
    expect(() => makeFundingPolicy({ version: "forge_phase_aware_v1", activationSlot: 1, bondingCreatorFeeLast60Bps: 10_001, forgeLpLast60Bps: 1 })).toThrow();
    expect(phaseAwareInForce(legacy, 10 ** 9)).toBe(false);
    expect(phaseAwareInForce(a, 100)).toBe(false); // strictly after the activation slot
    expect(phaseAwareInForce(a, 101)).toBe(true);
    // A retired v1 policy object (e.g. read back from a stored snapshot) is never in force.
    expect(phaseAwareInForce(makeFundingPolicy({ version: "forge_phase_aware_v1", activationSlot: 100, ...FORGE_POLICY_DEFAULTS }), 10 ** 9)).toBe(false);
  });
});

// ── correlation ─────────────────────────────────────────────────────────────────────────────
const FORGE = addr();
const DEST = addr();
const col = (o: Partial<CollectionFact> = {}): CollectionFact => ({ key: `c:${o.signature ?? "S1"}:${o.ordinal ?? 1}`, stream: "forge_platform_lp_fee_collection", signature: "S1", slot: 100, ordinal: 1, asset: WSOL_MINT, recipient: FORGE, gross: 1_000n, expectedLast60: 500n, linked: 0n, verified: true, ...o });
const xfer = (o: Partial<TransferFact> = {}): TransferFact => ({ key: `t:${o.signature ?? "S1"}:${o.ordinal ?? 3}`, signature: "S1", slot: 100, ordinal: 3, asset: WSOL_MINT, sourceOwner: FORGE, destinationOwner: DEST, amount: 500n, memoClaimSignature: null, ...o });

describe("claim ↔ transfer correlation", () => {
  test("Case A — claim and distribution in ONE transaction: linked by signature + instruction order + source + asset", () => {
    expect(correlateTransfer(xfer(), [col()], "strict")).toEqual({ linked: true, collectionKey: col().key, method: "same_transaction" });
    // A transfer that executes BEFORE the claim in the same transaction cannot distribute it.
    expect(correlateTransfer(xfer({ ordinal: 0 }), [col()], "strict").linked).toBe(false);
    // Another source or another asset is not the claim's distribution.
    expect(correlateTransfer(xfer({ sourceOwner: addr() }), [col()], "strict").linked).toBe(false);
    expect(correlateTransfer(xfer({ asset: USD1 }), [col()], "strict").linked).toBe(false);
  });

  test("Case B — separate transactions: linked only by an explicit memo naming the claim", () => {
    const claim = col({ signature: "CLAIM", slot: 100 });
    const later = xfer({ signature: "DIST", slot: 105, memoClaimSignature: "CLAIM" });
    expect(correlateTransfer(later, [claim], "strict")).toEqual({ linked: true, collectionKey: claim.key, method: "memo" });
    expect(correlateTransfer({ ...later, memoClaimSignature: "OTHER" }, [claim], "strict")).toEqual({ linked: false, reason: "memo_names_unknown_claim" });
    expect(correlateTransfer({ ...later, asset: USD1 }, [claim], "strict")).toEqual({ linked: false, reason: "memo_claim_asset_mismatch" });
    expect(correlateTransfer({ ...later, sourceOwner: addr() }, [claim], "strict")).toEqual({ linked: false, reason: "memo_claim_source_mismatch" });
    expect(correlateTransfer({ ...later, slot: 99 }, [claim], "strict")).toEqual({ linked: false, reason: "memo_claim_after_transfer" });
  });

  test("never by amount alone: an unrelated transfer with exactly the expected amount stays unlinked in strict mode", () => {
    const claim = col({ signature: "CLAIM" });
    const r = correlateTransfer(xfer({ signature: "OTHER", slot: 101, amount: 500n }), [claim], "strict");
    expect(r).toEqual({ linked: false, reason: "uncorrelated_separate_transaction" });
  });

  test("exclusive_window (opt-in): only the single, latest, still-open claim of that source; any ambiguity stays unlinked", () => {
    const c1 = col({ signature: "C1", slot: 100 });
    const t = xfer({ signature: "T", slot: 110, amount: 400n });
    expect(correlateTransfer(t, [c1], "exclusive_window")).toEqual({ linked: true, collectionKey: c1.key, method: "exclusive_window" });
    // A second open claim (e.g. an earlier distribution failed) makes the window ambiguous.
    const c0 = col({ signature: "C0", slot: 90 });
    expect(correlateTransfer(t, [c0, c1], "exclusive_window")).toEqual({ linked: false, reason: "ambiguous_window_multiple_open_claims" });
    // An already-funded older claim does not create ambiguity.
    expect(correlateTransfer(t, [{ ...c0, linked: 500n }, c1], "exclusive_window").linked).toBe(true);
    // The latest claim already funded → an extra transfer is not attributed to an older one.
    expect(correlateTransfer(t, [c0, { ...c1, linked: 500n }], "exclusive_window")).toEqual({ linked: false, reason: "window_latest_claim_not_open" });
    // More than the remaining expected amount is not inferred.
    expect(correlateTransfer({ ...t, amount: 501n }, [c1], "exclusive_window")).toEqual({ linked: false, reason: "window_transfer_exceeds_remaining_expected" });
    // A transfer before any claim from that source has nothing to distribute.
    expect(correlateTransfer({ ...t, slot: 50 }, [c1], "exclusive_window")).toEqual({ linked: false, reason: "no_preceding_collection_from_source" });
  });

  test("CPMM creator-fee collections are never candidates (no Last-60 split)", () => {
    const cpmm = col({ stream: "cpmm_creator_trading_fee", expectedLast60: null });
    expect(correlateTransfer(xfer(), [cpmm], "exclusive_window").linked).toBe(false);
  });
});

describe("reconciliation of one claim", () => {
  const t = (key: string, amount: bigint, slot = 101) => ({ key, amount, slot, ordinal: 1 });
  test("exact 50 % distribution → reconciled; Forge retained is implied, never assumed observed", () => {
    const r = reconcileCollection({ gross: 1_000n, expectedLast60: 500n, verified: true }, [t("a", 500n)]);
    expect(r).toMatchObject({ status: "reconciled", actualLast60: 500n, creditable: 500n, untransferred: 0n, excess: 0n, expectedRetained: 500n, impliedRetained: 500n });
  });
  test("claim succeeds but the transfer never happens → awaiting_distribution with the untransferred balance", () => {
    expect(reconcileCollection({ gross: 1_000n, expectedLast60: 500n, verified: true }, [])).toMatchObject({ status: "awaiting_distribution", untransferred: 500n, creditable: 0n });
  });
  test("partial distribution, then a retry completes it; credits never exceed the policy amount", () => {
    const p = reconcileCollection({ gross: 1_000n, expectedLast60: 500n, verified: true }, [t("a", 200n)]);
    expect(p).toMatchObject({ status: "partial", creditable: 200n, untransferred: 300n });
    expect(p.discrepancies[0]).toContain("partial_distribution");
    const done = reconcileCollection({ gross: 1_000n, expectedLast60: 500n, verified: true }, [t("a", 200n), t("b", 300n, 105)]);
    expect(done).toMatchObject({ status: "reconciled", creditable: 500n, untransferred: 0n });
  });
  test("over-distribution: the excess is recorded and never creditable", () => {
    const r = reconcileCollection({ gross: 1_000n, expectedLast60: 500n, verified: true }, [t("a", 400n), t("b", 300n, 102)]);
    expect(r).toMatchObject({ status: "excess", actualLast60: 700n, creditable: 500n, excess: 200n });
    expect(r.credits.map((c) => [c.transferKey, c.creditable, c.excess])).toEqual([["a", 400n, 0n], ["b", 100n, 200n]]);
  });
  test("an unverified claim credits nothing, whatever was transferred", () => {
    const r = reconcileCollection({ gross: 1_000n, expectedLast60: 500n, verified: false }, [t("a", 500n)]);
    expect(r).toMatchObject({ status: "unresolved", creditable: 0n });
  });
});

describe("assets and memos", () => {
  test("native SOL and WSOL are one asset (1:1 SPL native mint); everything else stays separate", () => {
    expect(assetOf(NATIVE_SOL)).toBe(WSOL_MINT);
    expect(assetOf(WSOL_MINT)).toBe(WSOL_MINT);
    expect(assetOf(USD1)).toBe(USD1); // a swap USD1 → SOL is a market conversion, never equivalent
  });
  test("memo format last60:v1:<claim signature>", () => {
    const s = sig();
    expect(parseFundingMemo(`last60:v1:${s}`)).toBe(s);
    expect(parseFundingMemo(`  last60:v1:${s}  `)).toBe(s);
    expect(parseFundingMemo(`last60:v2:${s}`)).toBeNull();
    expect(parseFundingMemo("last60:v1:not-a-signature")).toBeNull();
    const a = sig();
    const b = sig();
    expect(fundingMemoOf(buildTx({ slot: 1, ixs: [memo(`last60:v1:${a}`)] }))).toBe(a);
    expect(fundingMemoOf(buildTx({ slot: 1, ixs: [memo(`last60:v1:${a}`), memo(`last60:v1:${b}`)] }))).toBe("ambiguous");
    expect(fundingMemoOf(buildTx({ slot: 1, ixs: [memo("hello")] }))).toBeNull();
  });
});

describe("decoder — funding inflows", () => {
  const creator = addr();
  const facts = (o: Partial<RevenueLaunchFacts> = {}): RevenueLaunchFacts => ({ provider: "raydium_launchlab", tokenMint: addr(), quoteMint: WSOL_MINT, sourcePool: addr(), creator, role: "creator", creatorClaimVaults: [], destination: null, fundingDestinations: [DEST], forgePlatformLpBeneficiary: FORGE, ...o });
  const none = { swaps: [], claims: [], anomalies: [], attributions: [] };

  test("System transfer from the Forge beneficiary or the creator into a destination is an inflow (native SOL asset = WSOL)", () => {
    const f = facts();
    const tx = buildTx({ slot: 10, ixs: [systemTransfer(FORGE, DEST, 7n), systemTransfer(creator, DEST, 9n)] });
    const out = extractRevenue(tx, none, f);
    expect(out.map((d) => [d.kind, d.sourceOwner, d.netAmount, d.feeMint, d.asset, d.instructionIndex, d.innerInstructionIndex])).toEqual([
      ["funding_inflow", FORGE, 7n, NATIVE_SOL, WSOL_MINT, 0, null],
      ["funding_inflow", creator, 9n, NATIVE_SOL, WSOL_MINT, 1, null],
    ]);
  });

  test("ignored: transfers to non-destinations (incorrect recipient), from strangers, internal moves, zero amounts, failed transactions", () => {
    const f = facts();
    const other = addr();
    expect(extractRevenue(buildTx({ slot: 10, ixs: [systemTransfer(FORGE, other, 7n)] }), none, f)).toEqual([]);
    expect(extractRevenue(buildTx({ slot: 10, ixs: [systemTransfer(addr(), DEST, 7n)] }), none, f)).toEqual([]);
    expect(extractRevenue(buildTx({ slot: 10, ixs: [systemTransfer(FORGE, DEST, 0n)] }), none, f)).toEqual([]);
    expect(extractRevenue(buildTx({ slot: 10, ixs: [systemTransfer(FORGE, DEST, 7n)], err: { InstructionError: [0, "Custom"] } }), none, f)).toEqual([]);
    expect(extractRevenue(buildTx({ slot: 10, ixs: [systemTransfer(DEST, DEST, 7n)] }), none, facts({ forgePlatformLpBeneficiary: DEST }))).toEqual([]);
  });

  test("SPL transfer into a token account owned by a destination: owner and mint from the transaction's token metadata; TransferChecked mint must agree", () => {
    const f = facts();
    const src = addr();
    const dst = addr();
    const tokens = { [src]: { owner: FORGE, mint: USD1, decimals: 6 }, [dst]: { owner: DEST, mint: USD1, decimals: 6 } };
    const ok = extractRevenue(buildTx({ slot: 10, ixs: [splTransfer(src, dst, FORGE, 1_000_000n)], tokens }), none, f);
    expect(ok.map((d) => [d.feeMint, d.asset, d.decimals, d.destinationOwner, d.sourceOwner])).toEqual([[USD1, USD1, 6, DEST, FORGE]]);
    const bad = extractRevenue(buildTx({ slot: 10, ixs: [splTransferChecked(src, WSOL_MINT, dst, FORGE, 1n)], tokens }), none, f);
    expect(bad).toEqual([]); // declared mint ≠ the destination account's mint → not accepted
    const notOwned = extractRevenue(buildTx({ slot: 10, ixs: [splTransfer(src, dst, FORGE, 1n)], tokens: { ...tokens, [dst]: { owner: addr(), mint: USD1 } } }), none, f);
    expect(notOwned).toEqual([]); // destination ownership validated
  });

  test("a last60 memo in the transaction is carried on its inflows", () => {
    const claim = sig();
    const out = extractRevenue(buildTx({ slot: 10, ixs: [memo(`last60:v1:${claim}`), systemTransfer(FORGE, DEST, 7n)] }), none, facts());
    expect(out[0]!.memoClaimSignature).toBe(claim);
  });
});

describe("configuration", () => {
  const base = { NODE_ENV: "test", SOLANA_CLUSTER: "localnet", SOLANA_RPC_URL: "http://127.0.0.1:8899", LAUNCH_PROVIDER: "mock", MONGODB_URI: "mongodb://127.0.0.1:1" };
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig("test", { ...base, ...env });
      return [];
    } catch (e) {
      return (e as ConfigError).problems;
    }
  };
  test("default: forge_phase_aware_v2 with an automatic activation slot; Forgepad's Fee Key owner and custody default on mainnet", () => {
    const payout = Keypair.generate().publicKey.toBase58();
    const m = loadConfig("test", { ...base, SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com", LAST60_PAYOUT_WALLET_ADDRESS: payout });
    expect(m.revenue.policy.version).toBe("forge_phase_aware_v2");
    expect(m.revenue.activation).toEqual({ source: "auto", pending: true });
    expect(m.revenue.policy.activationSlot).toBe(PENDING_ACTIVATION_SLOT); // placeholder until pinned at boot
    expect(revenueRuntimeOf(m)).toBeNull(); // nothing is recorded under the placeholder
    expect(m.revenue.forgePlatformLpBeneficiary).toBe(FORGEPAD_PLATFORM_NFT_WALLET);
    expect(m.revenue.fundingDestinations).toEqual([payout]);
    expect(m.revenue.custody).toMatchObject({ enabled: true, payoutWallet: payout });
    expect(m.feeCollection.mode).toBe("manual"); // no creator wallet configured
    // An explicit slot is used as is; "auto" is the same as unset; an explicit Forge wallet wins.
    expect(loadConfig("test", { ...base, SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com", LAST60_PAYOUT_WALLET_ADDRESS: payout, REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "466000000" }).revenue).toMatchObject({ activation: { source: "configured", pending: false }, policy: { activationSlot: 466_000_000 } });
    expect(loadConfig("test", { ...base, SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com", LAST60_PAYOUT_WALLET_ADDRESS: payout, REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "auto", FORGE_PLATFORM_LP_BENEFICIARY: FORGE, LAST60_CUSTODY_ENABLED: "false" }).revenue).toMatchObject({ activation: { source: "auto" }, forgePlatformLpBeneficiary: FORGE, custody: { enabled: false } });
  });
  test("legacy policy stays selectable: REWARD_PERCENTAGE semantics unchanged, Forge's 75 / 50 recorded as policy parameters", () => {
    const c = loadConfig("test", { ...base, REWARD_FUNDING_POLICY: "legacy_creator_fee_v1" });
    expect(c.revenue.policy.version).toBe("legacy_creator_fee_v1");
    expect(c.revenue.policy.activationSlot).toBeNull();
    expect(c.revenue.activation).toEqual({ source: "not_applicable", pending: false });
    expect(c.revenue.custody.enabled).toBe(false);
    expect(c.rewards.rewardBps).toBe(7_500);
    expect(c.revenue.policy.bondingCreatorFeeLast60Bps).toBe(7_500);
    expect(c.revenue.policy.forgeLpLast60Bps).toBe(5_000);
    expect(c.revenue.correlationMode).toBe("strict");
    // Changing REWARD_PERCENTAGE never changes the source-specific allocation (and vice versa).
    const d = loadConfig("test", { ...base, REWARD_FUNDING_POLICY: "legacy_creator_fee_v1", REWARD_PERCENTAGE: "40" });
    expect(d.rewards.rewardBps).toBe(4_000);
    expect(d.revenue.policy.bondingCreatorFeeLast60Bps).toBe(7_500);
  });
  test("phase-aware policy requires a destination and the Forge Fee Key owner (outside mainnet-beta); fails closed otherwise; v1 is retired", () => {
    expect(problems({ REWARD_FUNDING_POLICY: "forge_phase_aware_v1", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "5", LAST60_FUNDING_DESTINATIONS: DEST, FORGE_PLATFORM_LP_BENEFICIARY: FORGE }).join("\n")).toContain("forge_phase_aware_v1 is retired");
    // No activation slot is no longer an error: it is pinned automatically at the first boot.
    expect(problems({ REWARD_FUNDING_POLICY: "forge_phase_aware_v2", LAST60_FUNDING_DESTINATIONS: DEST, FORGE_PLATFORM_LP_BENEFICIARY: FORGE })).toEqual([]);
    // No destination yet (no payout wallet generated) is reported at boot, not fatal; the Forge wallet still is (off mainnet).
    expect(problems({ REWARD_FUNDING_POLICY: "forge_phase_aware_v2", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "5" }).join("\n")).not.toContain("LAST60_FUNDING_DESTINATIONS");
    expect(problems({ REWARD_FUNDING_POLICY: "forge_phase_aware_v2", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "5", LAST60_FUNDING_DESTINATIONS: DEST }).join("\n")).toContain("FORGE_PLATFORM_LP_BENEFICIARY: is required");
    expect(problems({ REWARD_FUNDING_POLICY: "forge_phase_aware_v2", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "x", LAST60_FUNDING_DESTINATIONS: DEST }).join("\n")).toContain("non-negative integer");
    // The approved percentages cannot be changed, under any policy.
    expect(problems({ BONDING_CREATOR_FEE_LAST60_PERCENTAGE: "70" }).join("\n")).toContain("approved model is 75");
    expect(problems({ FORGE_PLATFORM_LP_LAST60_PERCENTAGE: "100" }).join("\n")).toContain("approved model is 50");
    expect(problems({ LAST60_FUNDING_DESTINATIONS: "not-a-key" }).length).toBeGreaterThan(0);
    expect(problems({ FORGE_PLATFORM_LP_BENEFICIARY: DEST, LAST60_FUNDING_DESTINATIONS: DEST }).join("\n")).toContain("must not include FORGE_PLATFORM_LP_BENEFICIARY");
    expect(problems({ BONDING_CREATOR_FEE_LAST60_PERCENTAGE: "101" }).length).toBeGreaterThan(0);
    expect(problems({ EXPECTED_CPMM_CREATOR_FEE_RATE: "1000001" }).length).toBeGreaterThan(0);
    const ok = loadConfig("test", { ...base, REWARD_FUNDING_POLICY: "forge_phase_aware_v2", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "466000000", LAST60_FUNDING_DESTINATIONS: DEST, FORGE_PLATFORM_LP_BENEFICIARY: FORGE, EXPECTED_CPMM_CREATOR_FEE_RATE: "500", FUNDING_CORRELATION_MODE: "exclusive_window" });
    expect(ok.revenue).toMatchObject({ fundingDestinations: [DEST], forgePlatformLpBeneficiary: FORGE, correlationMode: "exclusive_window" });
    expect(ok.revenue.policy).toMatchObject({ version: "forge_phase_aware_v2", activationSlot: 466_000_000, bondingCreatorFeeLast60Bps: 7_500, forgeLpLast60Bps: 5_000 });
    expect(ok.provider.expected.cpmmCreatorFeeRate).toBe(500);
  });
});
