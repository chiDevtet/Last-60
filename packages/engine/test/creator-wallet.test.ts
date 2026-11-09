/**
 * Launch creator wallet automation (docs/CREATOR_WALLET.md) and the forge_phase_aware_v2 default.
 *
 * Over a synthetic Forge launch whose creator is a throwaway key (never a real key), on the FakeChain
 * (signature-verified System transfers, blockhash expiry, fault injection) and a real MongoDB replica set:
 *   - the creator's verified, finalized bonding-curve claim → exactly 75 % sent to the payout wallet with
 *     the `last60:v1:<claim>` memo → linked by the normal pipeline → payable, `direct` custody;
 *   - Forge's post-migration creator payout → custody request opened automatically → exact SOL swept
 *     with `last60:custody:v1:<id>` → bound by the normal custody verification → finalized;
 *   - never twice: repeated passes, dropped / timed-out broadcasts, restarts; never in dry-run, when
 *     paused, before the claim is final, or with a key that is not the pool's creator.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { big } from "../src/db/decimal";
import type { Models } from "../src/db/models";
import { WSOL_MINT } from "../src/accounting/revenueStreams";
import { normalizeTransaction } from "../src/chain/tx";
import { ConfigError, loadConfig } from "../src/config/env";
import { FUNDING_ACTIVATION_STATE_ID, resolveFundingActivation } from "../src/config/activation";
import { SettingsStore } from "../src/config/runtime";
import { CreatorWalletAutomation } from "../src/creator/creatorWallet";
import { custodyCoverage, custodyRequirement } from "../src/custody/custody";
import { FeeCollector } from "../src/rewards/feeCollector";
import { ingestRevenue, revenueRuntimeOf } from "../src/revenue/ingest";
import { TerminalWriter } from "../src/terminal/terminal";
import { FakeChain } from "../src/testing/fakeChain";
import { MockProvider, MOCK_PROGRAM_ID } from "../src/providers/mock/MockProvider";
import { FakeClock, freshDb, SOL, startDb, stopDb, T0, testConfig } from "./harness";
import { addr, buildTx } from "./revenueTx";
import { ACT, bondingClaimIx, FORGE } from "./revenueLaunch";
import { forgeSplit, harvestTx, markCovered, payoutTx, syntheticLaunch, type Launch } from "./forgeFlow";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const secretOf = (kp: Keypair) => bs58.encode(kp.secretKey);

/** Wraps the FakeChain so transactions ingested directly (claims, Forge payouts) can be reported finalized. */
function rpcWith(chain: FakeChain, external: Map<string, number>, hidden?: { raw: boolean }) {
  return new Proxy(chain, {
    get(t, p) {
      if (p === "getTransactionRaw" && hidden?.raw) return async () => null; // RPC cannot serve the transaction (lag)
      if (p === "getSignatureStatuses")
        return async (sigs: string[]) => {
          const base = await t.getSignatureStatuses(sigs);
          return sigs.map((s, i) => base[i] ?? (external.has(s) ? { slot: external.get(s)!, confirmations: null, err: null, confirmationStatus: "finalized" as const } : null));
        };
      const v = (t as any)[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as FakeChain;
}

interface Env {
  db: Models;
  chain: FakeChain;
  external: Map<string, number>;
  creator: Keypair;
  payout: string;
  l: Launch;
  cfg: ReturnType<typeof testConfig>;
  auto: CreatorWalletAutomation;
  settings: SettingsStore;
  /** Set `raw = true` to make the RPC unable to return transactions (confirmed effects cannot be recorded). */
  hidden: { raw: boolean };
  /** Ingest a NormalizedTx through the normal revenue pipeline (as the indexer would). */
  ingest(tx: ReturnType<typeof buildTx>, finalized?: boolean): Promise<void>;
}

async function setup(o: { env?: Record<string, string>; creatorBalance?: bigint; keyFor?: Keypair } = {}): Promise<Env> {
  const db = await freshDb();
  const creator = Keypair.generate();
  const payout = addr();
  const l = await syntheticLaunch({ creator: creator.publicKey.toBase58() });
  const cfg = testConfig({
    REWARD_FUNDING_POLICY: "forge_phase_aware_v2",
    REWARD_FUNDING_POLICY_ACTIVATION_SLOT: String(ACT),
    FORGE_PLATFORM_LP_BENEFICIARY: FORGE,
    LAST60_PAYOUT_WALLET_ADDRESS: payout,
    LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(o.keyFor ?? creator),
    PAYOUT_MODE: "live",
    ...(o.env ?? {}),
  });
  const chain = new FakeChain();
  chain.slot = ACT + 1_000;
  const clock = new FakeClock(T0);
  chain.now = () => clock.now();
  chain.setBalance(creator.publicKey.toBase58(), o.creatorBalance ?? 10n * SOL);
  const external = new Map<string, number>();
  const hidden = { raw: false };
  const rpc = rpcWith(chain, external, hidden);
  const settings = new SettingsStore(db, cfg, 0);
  const auto = new CreatorWalletAutomation({ db, cfg, settings, rpc, provider: () => l.p, creator: o.keyFor ?? creator, terminal: new TerminalWriter(db), clock });
  const r = revenueRuntimeOf(cfg)!;
  return {
    db,
    chain,
    external,
    creator,
    payout,
    l,
    cfg,
    auto,
    settings,
    hidden,
    ingest: async (tx, finalized = true) => {
      await ingestRevenue(db, tx, l.p.parseTransaction(tx), l.p, r, { commitment: "confirmed" });
      if (finalized) external.set(tx.signature, tx.slot);
    },
  };
}

/** The creator's own bonding-curve fee claim (LaunchLab claim_creator_fee into the creator's WSOL account). */
const claimTx = (e: Env, amount: bigint, slot = ACT + 5) => {
  const c = bondingClaimIx(e.l.p, amount, e.creator.publicKey.toBase58());
  return buildTx({ slot, feePayer: e.creator.publicKey.toBase58(), ixs: [c.ix], tokens: c.tokens });
};
const toPayout = (e: Env) => e.chain.transfersTo(e.payout);

describe("forge_phase_aware_v2 is the default policy; its activation slot is pinned once", () => {
  test("pinned at the first start, shared by every process, stable across restarts and concurrent starts", async () => {
    const db = await freshDb();
    const env = { SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com", MONGODB_URI: "mongodb://x", LAUNCH_PROVIDER: "mock", NODE_ENV: "test", LAST60_PAYOUT_WALLET_ADDRESS: addr() };
    let slot = 470_000_000;
    const rpc = { getSlot: async () => slot++ };
    const cfgs = Array.from({ length: 5 }, () => loadConfig("test", env));
    expect(cfgs[0]!.revenue.policy.version).toBe("forge_phase_aware_v2");
    const out = await Promise.all(cfgs.map((c) => resolveFundingActivation(c, db, rpc)));
    const slots = new Set(out.map((x) => x.slot));
    expect(slots.size).toBe(1); // concurrent first starts agree
    expect(out.filter((x) => x.pinnedNow).length).toBe(1);
    for (const c of cfgs) expect(c.revenue).toMatchObject({ activation: { source: "auto", pending: false }, policy: { activationSlot: [...slots][0] } });
    expect(revenueRuntimeOf(cfgs[0]!)).not.toBeNull();
    // A restart later reads the same slot, whatever the chain says now.
    const later = loadConfig("test", env);
    slot = 999_000_000;
    expect((await resolveFundingActivation(later, db, rpc)).slot).toBe([...slots][0]!);
    expect(((await db.SystemState.findById(FUNDING_ACTIVATION_STATE_ID).lean()) as any).value.version).toBe("forge_phase_aware_v2");
    // An explicit slot always wins and pins nothing.
    const explicit = loadConfig("test", { ...env, REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "123" });
    expect(await resolveFundingActivation(explicit, db, rpc)).toMatchObject({ slot: 123, source: "configured", pinnedNow: false });
  });
});

describe("creator wallet configuration", () => {
  const base = { SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com", MONGODB_URI: "mongodb://x", TOKEN_MINT: "So11111111111111111111111111111111111111112", POOL_ADDRESS: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", LAUNCH_PROVIDER: "raydium_launchlab", SCHEDULE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig("rewards", { ...base, ...env });
      return [];
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      return e.problems;
    }
  };
  test("with the creator key: automation on, auto_claim by default, the creator claims its own fees; never echoes the key", () => {
    const creator = Keypair.generate();
    const payout = Keypair.generate();
    const c = loadConfig("rewards", { ...base, LAST60_PAYOUT_WALLET_ADDRESS: payout.publicKey.toBase58(), LAST60_CREATOR_WALLET_ADDRESS: creator.publicKey.toBase58(), LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator) });
    expect(c.creatorWallet).toMatchObject({ address: creator.publicKey.toBase58(), keyConfigured: true, automationEnabled: true });
    expect(c.feeCollection.mode).toBe("auto_claim");
    expect(c.revenue.custody.enabled).toBe(true);
    // The API only knows the public address; it shows the same fee-collection default.
    expect(loadConfig("api", { ...base, LAST60_PAYOUT_WALLET_ADDRESS: payout.publicKey.toBase58(), LAST60_CREATOR_WALLET_ADDRESS: creator.publicKey.toBase58() }).feeCollection.mode).toBe("auto_claim");
    // Explicit opt-outs win.
    expect(loadConfig("rewards", { ...base, LAST60_PAYOUT_WALLET_ADDRESS: payout.publicKey.toBase58(), LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator), LAST60_CREATOR_AUTOMATION_ENABLED: "false", FEE_COLLECTION_MODE: "manual" })).toMatchObject({ creatorWallet: { automationEnabled: false }, feeCollection: { mode: "manual" } });
    const all = JSON.stringify([problems({ LAST60_PAYOUT_WALLET_ADDRESS: payout.publicKey.toBase58(), LAST60_CREATOR_WALLET_ADDRESS: addr(), LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator) })]);
    expect(all).toContain("derives a different address");
    expect(all.includes(secretOf(creator))).toBe(false);
  });
  test("refused: malformed key, the payout wallet's key, legacy policy, custody disabled, no payout wallet, two key sources", () => {
    const creator = Keypair.generate();
    const payout = Keypair.generate();
    const P = payout.publicKey.toBase58();
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: P, LAST60_CREATOR_WALLET_PRIVATE_KEY: "not-a-key" }).join("\n")).toContain("not a valid 64-byte secret key");
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: P, LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(payout) }).join("\n")).toContain("is the payout wallet key");
    // Not explicitly enabled: an incompatible setup just leaves the automation off (never a startup failure).
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: P, LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator), REWARD_FUNDING_POLICY: "legacy_creator_fee_v1" })).toEqual([]);
    expect(loadConfig("rewards", { ...base, LAST60_PAYOUT_WALLET_ADDRESS: P, LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator), REWARD_FUNDING_POLICY: "legacy_creator_fee_v1" }).creatorWallet.automationEnabled).toBe(false);
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: P, LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator), LAST60_CREATOR_AUTOMATION_ENABLED: "true", REWARD_FUNDING_POLICY: "legacy_creator_fee_v1" }).join("\n")).toContain("requires REWARD_FUNDING_POLICY=forge_phase_aware_v2");
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: P, LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator), LAST60_CREATOR_AUTOMATION_ENABLED: "true", LAST60_CUSTODY_ENABLED: "false" }).join("\n")).toContain("requires the custody workflow");
    // No payout wallet yet: not fatal — the automation stays idle until one is generated.
    expect(problems({ LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator) })).toEqual([]);
    expect(loadConfig("rewards", { ...base, LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator) }).creatorWallet.automationEnabled).toBe(true);
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: P, LAST60_CREATOR_WALLET_PRIVATE_KEY: secretOf(creator), LAST60_CREATOR_WALLET_KEYPAIR_PATH: "/tmp/x.json" }).join("\n")).toContain("Set only one of LAST60_CREATOR_WALLET_PRIVATE_KEY");
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: P, LAST60_CREATOR_WALLET_ADDRESS: P })).toContainEqual(expect.stringContaining("must not be LAST60_PAYOUT_WALLET_ADDRESS"));
  });
});

describe("bonding curve: 75 % of each collected creator-fee claim reaches the payout wallet", () => {
  test("exactly 75 % with the claim memo, linked and payable as direct custody; the creator keeps 25 %; never repeated", async () => {
    const e = await setup();
    const claim = claimTx(e, 1_000_000_001n);
    await e.ingest(claim);
    const r1 = await e.auto.run();
    expect(r1).toMatchObject({ blocked: null, settlementsSent: 1 });
    expect(toPayout(e).map((t) => t.lamports)).toEqual([750_000_000n]); // ⌊1 000 000 001 × 75 %⌋
    expect(toPayout(e)[0]!.from).toBe(e.creator.publicKey.toBase58());
    // The landed transaction is transfer-only and names its claim.
    const raw = await e.chain.getTransactionRaw(toPayout(e)[0]!.signature);
    const tx = normalizeTransaction(raw);
    expect(tx.instructions.map((i) => i.programId)).toEqual(["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "11111111111111111111111111111111", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"]);
    expect(Buffer.from(tx.instructions[3]!.data).toString()).toBe(`last60:v1:${claim.signature}`);
    // Next pass records the effect through the normal pipeline: one payable memo credit, direct custody.
    const r2 = await e.auto.run();
    expect(r2.settlementsSent).toBe(0);
    const credit: any = await e.db.RewardFunding.findOne({ signature: toPayout(e)[0]!.signature }).lean();
    expect(credit).toMatchObject({ correlationMethod: "memo", payoutEligible: true, sourceWallet: e.creator.publicKey.toBase58(), destinationWallet: e.payout, collectionSignature: claim.signature, stream: "bonding_curve_last60_reward_contribution" });
    expect(big(credit.creditableAmount)).toBe(750_000_000n);
    expect(custodyRequirement(credit, e.payout).mode).toBe("direct");
    expect((await custodyCoverage(e.db, [credit], e.payout)).get(credit.key)?.satisfied).toBe(true);
    const rec: any = await e.db.RevenueReconciliation.findOne({ collectionSignature: claim.signature }).lean();
    expect(rec.status).toBe("reconciled");
    expect(await e.db.CreatorWalletTransfer.countDocuments({ status: "confirmed", effectRecorded: true })).toBe(1);
    // Repeated passes never send again.
    for (let i = 0; i < 3; i++) expect((await e.auto.run()).settlementsSent).toBe(0);
    expect(toPayout(e).length).toBe(1);
  });

  test("waits until the claim is finalized; skips unverified claims; a later claim is settled on its own", async () => {
    const e = await setup();
    const c1 = claimTx(e, 400_000_000n);
    await e.ingest(c1, false); // confirmed, not finalized
    expect((await e.auto.run()).settlementsSent).toBe(0);
    e.external.set(c1.signature, c1.slot);
    expect((await e.auto.run()).settlementsSent).toBe(1);
    const c2 = claimTx(e, 200_000_000n, ACT + 50);
    await e.ingest(c2);
    await e.auto.run();
    expect(toPayout(e).map((t) => t.lamports)).toEqual([300_000_000n, 150_000_000n]);
    // A claim by another wallet (not the creator) is never settled from the creator wallet.
    const other = bondingClaimIx(e.l.p, 500_000_000n, addr());
    await e.ingest(buildTx({ slot: ACT + 60, ixs: [other.ix], tokens: other.tokens }));
    await e.auto.run();
    await e.auto.run();
    expect(toPayout(e).length).toBe(2);
  });

  test("a dropped broadcast is retired only after proven expiry and then re-sent once; a timeout after acceptance is never re-sent", async () => {
    const e = await setup();
    await e.ingest(claimTx(e, 1_000_000_000n));
    e.chain.sendFaults = ["drop"];
    await e.auto.run();
    expect(toPayout(e).length).toBe(0);
    expect(await e.db.CreatorWalletTransfer.countDocuments({ status: "submitted" })).toBe(1);
    await e.auto.run(); // still within the blockhash window: rebroadcast only, no second transfer
    expect(await e.db.CreatorWalletTransfer.countDocuments()).toBe(1);
    e.chain.advance(e.chain.blockhashValidity + e.chain.finalityLag + 5);
    await e.auto.run(); // expiry proven → retired → re-sent in the same pass
    expect(await e.db.CreatorWalletTransfer.countDocuments({ status: "failed" })).toBe(1);
    expect(toPayout(e).map((t) => t.lamports)).toEqual([750_000_000n]);
    // Accepted, then the RPC call times out: the transfer landed and must not be repeated.
    const e2 = await setup();
    await e2.ingest(claimTx(e2, 1_000_000_000n));
    e2.chain.sendFaults = ["timeout_after_accept"];
    await e2.auto.run();
    for (let i = 0; i < 3; i++) await e2.auto.run();
    expect(toPayout(e2).length).toBe(1);
    expect(await e2.db.RewardFunding.countDocuments({ payoutEligible: true })).toBe(1);
  });

  test("a confirmed transfer whose credit cannot be recorded yet still counts as sent: never re-sent, recorded once the RPC serves it", async () => {
    const e = await setup();
    await e.ingest(claimTx(e, 1_000_000_000n));
    e.hidden.raw = true;
    await e.auto.run();
    e.chain.advance(e.chain.finalityLag + 1);
    for (let i = 0; i < 4; i++) expect((await e.auto.run()).settlementsSent).toBe(0);
    expect(toPayout(e).length).toBe(1);
    expect(await e.db.CreatorWalletTransfer.countDocuments({ status: "confirmed", effectRecorded: false })).toBe(1);
    e.hidden.raw = false;
    await e.auto.run();
    expect(await e.db.CreatorWalletTransfer.countDocuments({ status: "confirmed", effectRecorded: true })).toBe(1);
    expect(await e.db.RewardFunding.countDocuments({ payoutEligible: true })).toBe(1);
    expect(toPayout(e).length).toBe(1);
  });

  test("a restarted worker (new instance, same database) does not send again", async () => {
    const e = await setup();
    await e.ingest(claimTx(e, 1_000_000_000n));
    await e.auto.run();
    const again = new CreatorWalletAutomation({ db: e.db, cfg: e.cfg, settings: e.settings, rpc: rpcWith(e.chain, e.external), provider: () => e.l.p, creator: e.creator, terminal: new TerminalWriter(e.db), clock: new FakeClock(T0 + 60_000) });
    await Promise.all([again.run(), e.auto.run(), again.run()]);
    expect(toPayout(e).length).toBe(1);
  });

  test("keeps the fee reserve: a low balance sends only what fits, the rest follows when funds arrive", async () => {
    const e = await setup({ creatorBalance: 2_000_000n + 20_000n + 100_000_000n }); // reserve + fee budget + 0.1 SOL
    await e.ingest(claimTx(e, 1_000_000_000n));
    await e.auto.run();
    expect(toPayout(e).map((t) => t.lamports)).toEqual([100_000_000n]);
    await e.auto.run(); // records the partial credit; nothing left to send
    e.chain.setBalance(e.creator.publicKey.toBase58(), 5n * SOL);
    await e.auto.run();
    expect(toPayout(e).map((t) => t.lamports)).toEqual([100_000_000n, 650_000_000n]);
    await e.auto.run();
    const rec: any = await e.db.RevenueReconciliation.findOne({}).lean();
    expect(rec.status).toBe("reconciled");
  });
});

describe("post-migration: Forge's creator payout is swept into the payout wallet", () => {
  const Q = 2_000_000_001n;
  const TK = 77_000_003n;
  async function forgePayout(e: Env) {
    await markCovered(e.db, e.l, ACT + 10_000, revenueRuntimeOf(e.cfg)!);
    await e.ingest(harvestTx(e.l, { slot: ACT + 5, quote: Q, token: TK }));
    const p = payoutTx(e.l, { slot: ACT + 7, ...forgeSplit(Q, TK) });
    await e.ingest(p);
    return p;
  }

  test("custody request opened automatically, exact SOL swept with its memo, bound and finalized; never twice", async () => {
    const e = await setup();
    const p = await forgePayout(e);
    const r1 = await e.auto.run(); // attributes the payout (reconcile), opens the request, sends
    expect(r1.sweepsSent).toBe(1);
    const credit: any = await e.db.RewardFunding.findOne({ route: "forge_creator_distribution", fundingMint: WSOL_MINT }).lean();
    expect(credit).toMatchObject({ payoutEligible: true, destinationWallet: e.creator.publicKey.toBase58(), signature: p.signature });
    expect(toPayout(e).map((t) => t.lamports)).toEqual([Q / 2n]);
    const req: any = await e.db.CustodyTransfer.findOne({ fundingKey: credit.key }).lean();
    expect(req).toMatchObject({ requestedBy: "creator-wallet-automation", sourceWallet: e.creator.publicKey.toBase58(), destinationWallet: e.payout });
    await e.auto.run(); // binds the confirmed transfer through the normal custody verification
    const bound: any = await e.db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean();
    expect(bound).toMatchObject({ method: "creator_wallet_sweep", status: "awaiting_finality", signature: toPayout(e)[0]!.signature });
    expect(big(bound.creditedAmount)).toBe(Q / 2n);
    e.chain.advance(e.chain.finalityLag + 1);
    await e.auto.run(); // finality refresh
    expect(((await e.db.CustodyTransfer.findOne({ custodyId: req.custodyId }).lean()) as any).status).toBe("reconciled");
    expect((await custodyCoverage(e.db, [credit], e.payout)).get(credit.key)).toMatchObject({ mode: "transfer", satisfied: true });
    // The sweep is a custody transfer, never a second contribution.
    expect(await e.db.RewardFunding.countDocuments({ signature: toPayout(e)[0]!.signature })).toBe(0);
    for (let i = 0; i < 3; i++) expect((await e.auto.run()).sweepsSent).toBe(0);
    expect(toPayout(e).length).toBe(1);
  });

  test("a confirmed sweep that cannot be bound yet is never repeated", async () => {
    const e = await setup();
    await forgePayout(e);
    e.hidden.raw = true;
    await e.auto.run();
    for (let i = 0; i < 4; i++) expect((await e.auto.run()).sweepsSent).toBe(0);
    expect(toPayout(e).length).toBe(1);
    e.hidden.raw = false;
    await e.auto.run();
    expect(await e.db.CustodyTransfer.countDocuments({ method: "creator_wallet_sweep" })).toBe(1);
    expect(toPayout(e).length).toBe(1);
  });

  test("waits for Forge's payout to be finalized", async () => {
    const e = await setup();
    const p = await forgePayout(e);
    e.external.delete(p.signature);
    await e.auto.run();
    expect(toPayout(e).length).toBe(0);
    e.external.set(p.signature, p.slot);
    await e.auto.run();
    expect(toPayout(e).length).toBe(1);
  });
});

describe("never signs when it must not", () => {
  test("dry-run, paused payouts, or a key that is not the pool's creator: nothing is sent", async () => {
    const dry = await setup({ env: { PAYOUT_MODE: "dry_run" } });
    await dry.ingest(claimTx(dry, 1_000_000_000n));
    expect((await dry.auto.run()).blocked).toContain("dry_run");
    expect(toPayout(dry).length).toBe(0);

    const paused = await setup();
    await paused.db.Settings.create({ _id: "active", version: 1, overrides: { pausePayouts: true } });
    await paused.ingest(claimTx(paused, 1_000_000_000n));
    expect((await paused.auto.run()).blocked).toContain("paused");
    expect(toPayout(paused).length).toBe(0);

    const stranger = Keypair.generate();
    const wrong = await setup({ keyFor: stranger });
    wrong.chain.setBalance(stranger.publicKey.toBase58(), 10n * SOL);
    await wrong.ingest(claimTx(wrong, 1_000_000_000n));
    expect((await wrong.auto.run()).blocked).toContain("not this pool's on-chain creator");
    expect(wrong.chain.transfers.length).toBe(0);
    expect(await wrong.db.TerminalEvent.countDocuments({ type: "ERROR" })).toBe(1);
  });
});

describe("fee claims under forge_phase_aware_v2 land in the creator wallet", () => {
  test("auto_claim unwraps into the claimer (the creator), not the payout wallet; legacy is unchanged", async () => {
    for (const [policy, expectInto] of [["forge_phase_aware_v2", "claimer"], ["legacy_creator_fee_v1", "payout"]] as const) {
      const db = await freshDb();
      const claimer = Keypair.generate();
      const payout = Keypair.generate().publicKey;
      const env: Record<string, string> = { REWARD_FUNDING_POLICY: policy, PAYOUT_MODE: "live", FEE_COLLECTION_MODE: "auto_claim" };
      if (policy === "forge_phase_aware_v2") Object.assign(env, { REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "5", FORGE_PLATFORM_LP_BENEFICIARY: FORGE, LAST60_PAYOUT_WALLET_ADDRESS: payout.toBase58() });
      const cfg = testConfig(env);
      const chain = new FakeChain();
      chain.setBalance(claimer.publicKey.toBase58(), SOL);
      const provider = new MockProvider();
      (provider as any).unclaimed = 50_000_000n;
      const clock = new FakeClock(T0);
      const fc = new FeeCollector({ db, cfg, settings: new SettingsStore(db, cfg, 0), rpc: chain, provider: () => provider, claimer, payoutWallet: payout, terminal: new TerminalWriter(db), clock });
      const sig = await fc.maybeClaim();
      expect(sig).toBeTruthy();
      const tx = normalizeTransaction(await chain.getTransactionRaw(sig!));
      const ix = tx.instructions.find((i) => i.programId === MOCK_PROGRAM_ID)!;
      expect(ix.accounts[1]).toBe(expectInto === "claimer" ? claimer.publicKey.toBase58() : payout.toBase58());
    }
  });
});
