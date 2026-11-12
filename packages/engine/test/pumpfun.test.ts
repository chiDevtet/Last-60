/**
 * pump.fun launches end to end on REAL mainnet transactions and accounts
 * (test/fixtures/mainnet/pumpfun-*.json, collected with scripts/fetch-pumpfun-fixtures.ts):
 *   - the bonding curve is derived from the token mint; every trade instruction (legacy, _v2, _v3) is
 *     decoded from its TradeEvent and cross-checked against lamport balances of the same transaction;
 *   - the creator fee is attributed only when it is paid to the declared creator (not to holders, not
 *     as cashback, not to another creator); other coins' deposits into the shared vault are excluded;
 *   - claims: collect_creator_fee (bonding curve, native SOL) and, after a strictly verified
 *     graduation, PumpSwap collect_coin_creator_fee — both built byte-for-byte like the real ones;
 *   - both collections fund buyer rewards at 75 %, credited only from a memo'd creator transfer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { normalizeTransaction, tokenAccountDelta, type NormalizedTx } from "../src/chain/tx";
import { AnchorEventDecoder, instructionDiscriminator, toAddr, toBig } from "../src/chain/anchorEvents";
import { big } from "../src/db/decimal";
import { basisDistributable } from "../src/accounting/attribution";
import { APPROVED_SHARES, makeFundingPolicy, NATIVE_SOL, SPLIT_OF, STREAM_INFO, WSOL_MINT } from "../src/accounting/revenueStreams";
import { PumpFunProvider, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, decodePumpBondingCurve, lamportDelta, verifyPumpCreator, PUMP_VAULT_TOP_UP, type PumpBondingCurve } from "../src/providers/pumpfun/PumpFunProvider";
import { canonicalPumpSwapPool, derivePumpBondingCurve, pumpCreatorVault, pumpPoolAuthority, pumpSwapCreatorVaultAta, pumpSwapCreatorVaultAuthority } from "../src/providers/pumpfun/pda";
import { PumpSwapDestination, decodePumpSwapPool } from "../src/providers/destination/pumpSwap";
import { destinationSpec } from "../src/providers/destination";
import { MigrationAwareProvider } from "../src/providers/MigrationAwareProvider";
import { migrationVerified, parseMigration, verifyMigration, type VerifiedMigration } from "../src/providers/migration";
import { storedSpecProblems } from "../src/providers/migrationAttach";
import { createProvider } from "../src/providers";
import { extractRevenue } from "../src/revenue/decode";
import { ingestRevenue, revenueFactsOf, type RevenueRuntime } from "../src/revenue/ingest";
import { buildRevenueReport } from "../src/revenue/report";
import { loadFixture } from "./fixtureRpc";
import { buildTx, memo, systemTransfer } from "./revenueTx";
import { freshDb, startDb, stopDb } from "./harness";
import pumpIdl from "../src/providers/pumpfun/idl/pump.json";
import ammIdl from "../src/providers/destination/idl/pump_amm.json";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const TXS = loadFixture("pumpfun-txs.json");
const GRAD = loadFixture("pumpfun-graduation.json");
const tx = (name: string): NormalizedTx => normalizeTransaction(TXS[name]);
const pumpEvents = new AnchorEventDecoder(PUMP_PROGRAM_ID, pumpIdl as any);
const ammEvents = new AnchorEventDecoder(PUMP_AMM_PROGRAM_ID, ammIdl as any);
const ZERO = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const RENT_FLOOR = 650_240;

const curveOf = (creator: string, over: Partial<PumpBondingCurve> = {}): PumpBondingCurve => ({ virtualTokenReserves: 0n, virtualQuoteReserves: 0n, realTokenReserves: 0n, realQuoteReserves: 0n, tokenTotalSupply: 0n, complete: false, creator, isMayhemMode: false, isCashbackCoin: false, quoteMint: ZERO, creatorFeeBps: 0n, isHolderReward: false, creatorFee: 0n, protocolFees: 0n, ...over });

/** A provider for `mint` whose on-chain creator is `creator`; `declared` is the operator's declaration. */
function bonding(mint: string, creator: string, declared: string | null = creator, rpc: any = null, over: Partial<PumpBondingCurve> = {}) {
  const p = new PumpFunProvider(rpc, { poolAddress: derivePumpBondingCurve(mint), tokenMint: mint, role: "creator", payoutMint: WSOL_MINT, expected: { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: null, launchlabCreatorLpScale: null, pumpfunCreator: declared } });
  p.hydrate(curveOf(creator, over), { baseDecimals: 6, baseTokenProgram: TOKEN_2022 });
  return p;
}
/** The provider of the coin a fixture trades, as its real creator would run it. */
function bondingFor(name: string, declared?: string | null) {
  const t = tx(name);
  const ev = pumpEvents.decodeAll(t).find((e) => e.name === "TradeEvent")!;
  const mint = toAddr((ev.data as any).mint);
  const creator = toAddr((ev.data as any).creator);
  return { t, ev: ev.data as any, parent: ev.parent!, mint, creator, p: bonding(mint, creator, declared === undefined ? creator : declared) };
}

describe("pump.fun addresses and accounts", () => {
  test("the bonding curve, the PumpSwap pool and both creator vaults derive from the mint and the creator", () => {
    expect(derivePumpBondingCurve(GRAD.mint)).toBe(GRAD.bondingCurve);
    expect(canonicalPumpSwapPool(GRAD.mint)).toBe(GRAD.pool);
    // real instructions: the legacy buy names the creator vault (#9), the crank sweep its recipient (#9)
    const { parent, creator } = bondingFor("bonding-buy-legacy");
    expect(parent.accounts[9]).toBe(pumpCreatorVault(creator));
    const collect = tx("amm-sweep-collect").instructions.find((i) => i.programId === PUMP_AMM_PROGRAM_ID && i.data.subarray(0, 8).equals(instructionDiscriminator("collect_coin_creator_fee")))!;
    expect(collect.accounts[3]).toBe(pumpSwapCreatorVaultAuthority(collect.accounts[2]!));
    expect(collect.accounts[4]).toBe(pumpSwapCreatorVaultAta(collect.accounts[2]!));
  });

  test("BondingCurve and Pool decode from real accounts (and shorter, older layouts read as zero)", () => {
    const data = Buffer.from(GRAD.accounts[GRAD.bondingCurve].data, "base64");
    const c = decodePumpBondingCurve(data);
    expect(c).toMatchObject({ complete: true, creator: GRAD.creator, quoteMint: ZERO, isHolderReward: false, isCashbackCoin: false });
    expect(decodePumpBondingCurve(data.subarray(0, 81))).toMatchObject({ creator: GRAD.creator, creatorFee: 0n, isHolderReward: false, quoteMint: ZERO });
    expect(decodePumpBondingCurve(data.subarray(0, 49)).creator).toBe(ZERO);
    expect(() => decodePumpBondingCurve(Buffer.alloc(166))).toThrow("not a pump.fun BondingCurve");
    const pool = decodePumpSwapPool(Buffer.from(GRAD.accounts[GRAD.pool].data, "base64"));
    expect(pool).toMatchObject({ index: 0, creator: pumpPoolAuthority(GRAD.mint), baseMint: GRAD.mint, quoteMint: WSOL_MINT, coinCreator: GRAD.coinCreator });
    expect(Object.keys(GRAD.accounts)).toContain(pool.poolQuoteTokenAccount);
  });

  test("the vendored IDLs carry the instructions and events the adapters rely on", () => {
    const has = (idl: any, kind: "instructions" | "events", names: string[]) => names.every((n) => idl[kind].some((x: any) => x.name === n));
    expect(has(pumpIdl, "instructions", ["buy", "sell", "buy_v2", "sell_v2", "buy_v3", "sell_v3", "collect_creator_fee", "sweep_creator_fee", "migrate", "migrate_v2"])).toBe(true);
    expect(has(pumpIdl, "events", ["TradeEvent", "CollectCreatorFeeEvent", "SweepBondingCurveFeeEvent"])).toBe(true);
    expect(has(ammIdl, "instructions", ["buy", "sell", "buy_v2", "sell_v2", "collect_coin_creator_fee", "sweep_creator_fee"])).toBe(true);
    expect(has(ammIdl, "events", ["BuyEvent", "SellEvent", "CollectCoinCreatorFeeEvent", "SweepPoolFeeEvent"])).toBe(true);
    for (const [idl, name] of [[pumpIdl, "collect_creator_fee"], [pumpIdl, "sweep_creator_fee"], [ammIdl, "collect_coin_creator_fee"], [ammIdl, "sweep_creator_fee"]] as const) {
      expect([...instructionDiscriminator(name)]).toEqual((idl as any).instructions.find((i: any) => i.name === name).discriminator);
    }
  });
});

describe("pump.fun bonding-curve trades", () => {
  test("legacy buy: the creator fee of the event is exactly what reached the creator vault", () => {
    const { t, ev, p, mint, creator } = bondingFor("bonding-buy-legacy");
    const r = p.parseTransaction(t);
    expect(r.anomalies).toEqual([]);
    expect(r.attributions).toEqual([]);
    expect(r.swaps).toHaveLength(1);
    const s = r.swaps[0]!;
    expect(s).toMatchObject({ side: "buy", trader: toAddr(ev.user), traderSource: "payer", feePhase: "bonding_curve", payoutEligible: true, feeStatus: "observed", eligibleFeeMint: WSOL_MINT });
    expect(s.eligibleFee).toBe(toBig(ev.creator_fee));
    expect(s.eligibleFee).toBeGreaterThan(0n);
    expect(s.totalFee).toBe(toBig(ev.fee) + toBig(ev.creator_fee));
    // independent signals: the vault's and the curve's lamport changes in the same transaction
    expect(lamportDelta(t, pumpCreatorVault(creator))).toBe(s.eligibleFee);
    expect(lamportDelta(t, derivePumpBondingCurve(mint))).toBe(s.quoteAmount - s.totalFee);
    expect(s.evidence).toMatchObject({ event: "TradeEvent", ix: "buy", settledTo: "creator_vault", creator });
  });

  test("_v2 trades also pay the vault in the trade; a sell reports what the seller received", () => {
    for (const [name, side] of [["bonding-buy-v2", "buy"], ["bonding-sell-v2", "sell"]] as const) {
      const { t, ev, p, creator } = bondingFor(name);
      const r = p.parseTransaction(t);
      expect(r.anomalies).toEqual([]);
      const s = r.swaps[0]!;
      expect(s.side).toBe(side);
      expect(s.eligibleFee).toBe(toBig(ev.creator_fee));
      expect(lamportDelta(t, pumpCreatorVault(creator))).toBe(s.eligibleFee);
      expect(s.quoteAmount).toBe(side === "buy" ? toBig(ev.sol_amount) + s.totalFee : toBig(ev.sol_amount) - s.totalFee);
      expect(s.evidence!.settledTo).toBe("creator_vault");
    }
  });

  test("_v3 trades leave the creator fee on the curve: attributed from the event, vault untouched", () => {
    const sell = bondingFor("bonding-sell-v3");
    const rs = sell.p.parseTransaction(sell.t);
    expect(rs.anomalies).toEqual([]);
    expect(rs.attributions).toEqual([]);
    const s = rs.swaps[0]!;
    expect(s).toMatchObject({ side: "sell", payoutEligible: true });
    expect(s.eligibleFee).toBe(30_030n);
    expect(s.evidence).toMatchObject({ ix: "sell_v3", settledTo: "bonding_curve_bucket" });
    expect(lamportDelta(sell.t, pumpCreatorVault(sell.creator))).toBeNull();
    // the curve paid out only the seller's net proceeds: both fees stayed on it
    expect(lamportDelta(sell.t, derivePumpBondingCurve(sell.mint))).toBe(-s.quoteAmount);
    expect(toBig(sell.ev.creator_fee_unclaimed)).toBeGreaterThanOrEqual(s.eligibleFee);

    const buy = bondingFor("bonding-buy-v3");
    const b = buy.p.parseTransaction(buy.t).swaps[0]!;
    expect(b).toMatchObject({ side: "buy", payoutEligible: true });
    expect(b.eligibleFee).toBe(toBig(buy.ev.creator_fee));
    expect(b.evidence!.settledTo).toBe("bonding_curve_bucket");
    // the buyer's SOL entered the curve; only the buyback slice of the protocol fee left it
    expect(lamportDelta(buy.t, derivePumpBondingCurve(buy.mint))).toBe(b.quoteAmount - toBig(buy.ev.buyback_fee));
  });

  test("a holder-reward coin pays its creator fee to holders: recorded, never eligible", () => {
    const { t, ev, p } = bondingFor("bonding-buy-v3-holder-reward");
    expect(toBig(ev.holder_rewards)).toBe(toBig(ev.creator_fee));
    const s = p.parseTransaction(t).swaps[0]!;
    expect(s).toMatchObject({ eligibleFee: 0n, payoutEligible: false, excludedReason: "creator_fee_paid_to_holders" });
    expect(s.excludedFee).toBe(s.totalFee);
  });

  test("fees are distributable only when the on-chain creator is the declared creator wallet", () => {
    const real = bondingFor("bonding-buy-legacy");
    expect(real.p.info().allocation).toMatchObject({ verification: "verified", beneficiary: real.creator, phase: "bonding_curve" });
    expect(basisDistributable(real.p.info().allocation!)).toBe(true);

    const undeclared = bondingFor("bonding-buy-legacy", null);
    expect(undeclared.p.info().allocation!.verification).toBe("not_declared");
    expect(basisDistributable(undeclared.p.info().allocation!)).toBe(false);
    expect(undeclared.p.info().warnings!.join(" ")).toContain("EXPECTED_PUMPFUN_CREATOR");

    const other = bondingFor("bonding-buy-legacy", Keypair.generate().publicKey.toBase58());
    expect(other.p.info().allocation!.verification).toBe("mismatch");
    const s = other.p.parseTransaction(other.t).swaps[0]!;
    expect(s.payoutEligible).toBe(false);
    expect(s.feeStatus).toBe("unresolved");
    expect(s.excludedReason).toContain("allocation_mismatch");

    expect(verifyPumpCreator({ creator: real.creator, isHolderReward: true, isCashbackCoin: false }, { pumpfunCreator: real.creator }).verification).toBe("unverifiable");
    expect(verifyPumpCreator({ creator: real.creator, isHolderReward: false, isCashbackCoin: true }, { pumpfunCreator: real.creator }).verification).toBe("unverifiable");
    expect(verifyPumpCreator({ creator: ZERO, isHolderReward: false, isCashbackCoin: false }, { pumpfunCreator: real.creator }).verification).toBe("unverifiable");
  });

  test("a trade whose event names another creator is never attributed to the beneficiary", () => {
    const { t, mint } = bondingFor("bonding-buy-legacy");
    const stranger = Keypair.generate().publicKey.toBase58();
    const s = bonding(mint, stranger).parseTransaction(t).swaps[0]!;
    expect(s).toMatchObject({ eligibleFee: 0n, payoutEligible: false });
    expect(s.excludedReason).toStartWith("creator_fee_paid_to_");
  });

  test("another coin of the same creator paying the shared vault is recorded and excluded", () => {
    const { t, ev, creator } = bondingFor("bonding-buy-legacy");
    const otherCoin = Keypair.generate().publicKey.toBase58();
    const r = bonding(otherCoin, creator).parseTransaction(t);
    expect(r.swaps).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.attributions).toHaveLength(1);
    expect(r.attributions![0]).toMatchObject({ kind: "shared_vault_inflow", excludedReason: "shared_vault_other_pool", creatorAmount: 0n, payoutEligible: false, destinationPool: null, feeMint: WSOL_MINT });
    expect(r.attributions![0]!.excludedAmount).toBe(toBig(ev.creator_fee));
  });

  test("transactions of unrelated coins and creators produce nothing", () => {
    const p = bonding(Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58());
    for (const name of Object.keys(TXS)) expect(p.parseTransaction(tx(name))).toEqual({ swaps: [], claims: [], anomalies: [], attributions: [] });
  });

  test("only SOL-quoted coins with the creator role are accepted", async () => {
    expect(() => new PumpFunProvider(null, { poolAddress: GRAD.bondingCurve, tokenMint: GRAD.mint, role: "platform" })).toThrow('must be "creator"');
    const curveData = Buffer.from(GRAD.accounts[GRAD.bondingCurve].data, "base64");
    const usdc = Buffer.from(curveData);
    new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").toBuffer().copy(usdc, 83);
    const rpcWith = (data: Buffer | null) => ({ getAccountInfo: async (a: string) => ({ slot: 1, value: a === GRAD.bondingCurve ? (data ? { owner: PUMP_PROGRAM_ID, data, lamports: 1, executable: false } : null) : accountOf(a) }) });
    const make = (rpc: any, pool = GRAD.bondingCurve) => new PumpFunProvider(rpc, { poolAddress: pool, tokenMint: GRAD.mint, role: "creator", payoutMint: WSOL_MINT });
    await expect(make(rpcWith(usdc)).load()).rejects.toThrow("only SOL-quoted coins are supported");
    await expect(make(rpcWith(null)).load()).rejects.toThrow("waiting for the launch");
    await expect(make(rpcWith(curveData), GRAD.pool).load()).rejects.toThrow("is not the pump.fun bonding curve of TOKEN_MINT");
    const info = await make(rpcWith(curveData)).load();
    expect(info).toMatchObject({ provider: "pump_fun", poolAddress: GRAD.bondingCurve, tokenMint: GRAD.mint, quoteMint: WSOL_MINT, creator: GRAD.creator, beneficiary: GRAD.creator, status: "migrated", baseDecimals: 6 });
    expect(info.watchAddresses).toEqual([GRAD.bondingCurve, pumpCreatorVault(GRAD.creator)]);
  });
});

const accountOf = (a: string) => (GRAD.accounts[a] ? { owner: GRAD.accounts[a].owner, lamports: GRAD.accounts[a].lamports, data: Buffer.from(GRAD.accounts[a].data, "base64"), executable: false } : null);
/** Read-only RPC over the graduation snapshot, with optional per-account overrides. */
function gradRpc(over: Record<string, { owner?: string; lamports?: number; data?: Buffer } | null> = {}): any {
  const acc = (a: string) => {
    if (a in over) return over[a] === null ? null : { ...(accountOf(a) ?? { owner: ZERO, lamports: 0, data: Buffer.alloc(0), executable: false }), ...over[a] };
    return accountOf(a);
  };
  return {
    getAccountInfo: async (a: string) => ({ slot: GRAD.slot, value: acc(a) }),
    getMultipleAccounts: async (as: string[]) => ({ slot: GRAD.slot, value: as.map(acc) }),
    getMinimumBalanceForRentExemption: async () => RENT_FLOOR,
  };
}

describe("pump.fun bonding-curve sweeps and claims", () => {
  test("the crank's sweep_creator_fee moves this coin's fees into the vault: no new fee, nothing foreign", () => {
    const t = tx("bonding-sweep-crank");
    const sweeps = pumpEvents.decodeAll(t).filter((e) => e.name === "SweepBondingCurveFeeEvent" && Number((e.data as any).bucket) === 1);
    expect(sweeps.length).toBeGreaterThan(0);
    for (const ev of sweeps) {
      const mint = toAddr((ev.data as any).mint);
      const creator = GRAD.sweepCreators[mint];
      expect(toAddr((ev.data as any).recipient)).toBe(pumpCreatorVault(creator));
      expect(lamportDelta(t, pumpCreatorVault(creator))).toBe(toBig((ev.data as any).amount));
      expect(bonding(mint, creator).parseTransaction(t)).toEqual({ swaps: [], claims: [], anomalies: [], attributions: [] });
      // seen from another coin of that creator, the same lamports are a foreign deposit
      const foreign = bonding(Keypair.generate().publicKey.toBase58(), creator).parseTransaction(t).attributions!;
      expect(foreign).toHaveLength(1);
      expect(foreign[0]).toMatchObject({ kind: "shared_vault_inflow", excludedReason: "shared_vault_other_pool" });
      expect(foreign[0]!.excludedAmount).toBe(toBig((ev.data as any).amount));
    }
  });

  const collectFx = () => {
    const t = tx("bonding-sweep-collect");
    const ev = pumpEvents.decodeAll(t).find((e) => e.name === "CollectCreatorFeeEvent")!;
    const sweepIx = t.instructions.find((i) => i.programId === PUMP_PROGRAM_ID && i.data.subarray(0, 8).equals(instructionDiscriminator("sweep_creator_fee")))!;
    const collectIx = ev.parent!;
    return { t, creator: toAddr((ev.data as any).creator), amount: toBig((ev.data as any).creator_fee), mint: sweepIx.accounts[2]!, sweepIx, collectIx };
  };

  test("collect_creator_fee: the claim is the event amount, which is what the creator wallet received", () => {
    const { t, creator, amount, mint } = collectFx();
    expect(amount).toBe(20_123_736n);
    const r = bonding(mint, creator).parseTransaction(t);
    expect(r.anomalies).toEqual([]);
    expect(r.attributions).toEqual([]);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({ claimer: creator, quoteAmount: amount, baseAmount: 0n });
    expect(r.claims[0]!.pool).toBeUndefined();
    expect(lamportDelta(t, creator)).toBe(amount); // a third party paid the transaction fee
    expect(lamportDelta(t, pumpCreatorVault(creator))).toBe(-amount);
    // the vault keeps its rent floor
    expect(t.postBalances[t.accountKeys.indexOf(pumpCreatorVault(creator))]).toBe(BigInt(RENT_FLOOR));
    // somebody else's collection is not ours; an empty collection (no event, no transfer) is no claim
    expect(bonding(mint, Keypair.generate().publicKey.toBase58()).parseTransaction(t).claims).toEqual([]);
    const empty = tx("collect-both-empty");
    const emptyIx = empty.instructions.find((i) => i.programId === PUMP_PROGRAM_ID)!;
    expect(bonding(mint, emptyIx.accounts[0]!).parseTransaction(empty).claims).toEqual([]);
  });

  test("the claim plan is sweep + collect, account for account like the real transaction, and forwards to the payout wallet", async () => {
    const { creator, mint, sweepIx, collectIx } = collectFx();
    const curve = derivePumpBondingCurve(mint);
    const vault = pumpCreatorVault(creator);
    const curveData = Buffer.from(GRAD.accounts[GRAD.bondingCurve].data, "base64");
    const withBucket = (bucket: bigint) => {
      const d = Buffer.from(curveData);
      new PublicKey(creator).toBuffer().copy(d, 49);
      d.writeBigUInt64LE(bucket, 125);
      return d;
    };
    const rpc = (vaultLamports: number, bucket: bigint) => gradRpc({ [vault]: { owner: ZERO, lamports: vaultLamports, data: Buffer.alloc(0) }, [curve]: { owner: PUMP_PROGRAM_ID, lamports: 1, data: withBucket(bucket) } });
    const claimer = new PublicKey(creator);
    const payout = Keypair.generate().publicKey;

    const p = bonding(mint, creator, creator, rpc(5_000_000, 1_250_000n));
    const state = await p.getFeeSourceState();
    expect(state).toMatchObject({ unclaimedQuote: 6_250_000n, claimableQuote: 6_250_000n - BigInt(RENT_FLOOR), unclaimedBase: 0n, mayIncludeOtherPools: true });
    const plan = await p.buildClaimInstructions(claimer, payout);
    expect(plan.signer.toBase58()).toBe(creator);
    expect(plan.instructions).toHaveLength(3);
    const [sweep, collect, forward] = plan.instructions as [any, any, any];
    // sweep_creator_fee: identical to the real instruction except for who pays
    expect(sweep.programId.toBase58()).toBe(PUMP_PROGRAM_ID);
    expect(Buffer.from(sweep.data).equals(sweepIx.data)).toBe(true);
    expect(sweep.keys.map((k: any) => k.pubkey.toBase58()).slice(1)).toEqual(sweepIx.accounts.slice(1));
    expect(sweep.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(sweep.keys[0].pubkey.toBase58()).toBe(creator);
    // collect_creator_fee: identical to the real instruction
    expect(Buffer.from(collect.data).equals(collectIx.data)).toBe(true);
    expect(collect.keys.map((k: any) => k.pubkey.toBase58())).toEqual(collectIx.accounts);
    expect(collect.keys.map((k: any) => k.isWritable)).toEqual([true, true, false, false, false]);
    // the program pays the creator wallet; what is claimable now is forwarded to the payout wallet
    expect(forward.programId.equals(SystemProgram.programId)).toBe(true);
    expect(forward.keys.map((k: any) => k.pubkey.toBase58())).toEqual([creator, payout.toBase58()]);
    expect(forward.data.readBigUInt64LE(4)).toBe(6_250_000n - BigInt(RENT_FLOOR));

    // claiming into the creator wallet itself (phase-aware funding): no forwarding; no bucket: no sweep
    const own = await bonding(mint, creator, creator, rpc(5_000_000, 0n)).buildClaimInstructions(claimer, claimer);
    expect(own.instructions).toHaveLength(1);
    expect(Buffer.from(own.instructions[0]!.data).equals(collectIx.data)).toBe(true);
    // a vault holding only its rent floor has nothing to claim
    expect((await bonding(mint, creator, creator, rpc(RENT_FLOOR, 0n)).getFeeSourceState()).claimableQuote).toBe(0n);
    await expect(p.buildClaimInstructions(payout, payout)).rejects.toThrow("is not the coin's creator");
  });

  test("lamports reaching the vault outside any pump.fun fee are a top-up, not another coin's fees", () => {
    const { mint, creator } = collectFx();
    const vault = pumpCreatorVault(creator);
    const topUp = buildTx({ slot: 10, ixs: [systemTransfer(Keypair.generate().publicKey.toBase58(), vault, 650_240n)] });
    topUp.accountKeys.push(vault);
    const i = topUp.accountKeys.indexOf(vault);
    for (let k = 0; k <= i; k++) {
      topUp.preBalances[k] ??= 0n;
      topUp.postBalances[k] ??= 0n;
    }
    topUp.postBalances[i] = 650_240n;
    const r = bonding(mint, creator).parseTransaction(topUp);
    expect(r.attributions).toHaveLength(1);
    expect(r.attributions![0]).toMatchObject({ kind: "shared_vault_inflow", excludedReason: PUMP_VAULT_TOP_UP, excludedAmount: 650_240n, payoutEligible: false });
  });
});

// ── graduation to PumpSwap ───────────────────────────────────────────────────────────────────

const migTx = normalizeTransaction(GRAD.migration);
const M = parseMigration(migTx, "pump_fun", GRAD.bondingCurve)!;
const CTX = { base: GRAD.mint, quote: WSOL_MINT, bondingCreator: GRAD.creator };
let verified: VerifiedMigration;
async function graduated(declared: string | null = GRAD.creator, rpc: any = null) {
  verified ??= await verifyMigration(gradRpc(), M, CTX);
  const inner = bonding(GRAD.mint, GRAD.creator, declared, rpc, { complete: true });
  const spec = destinationSpec(inner.info(), verified, inner.lpCheck)!;
  const p = new MigrationAwareProvider(inner, rpc);
  p.attach(spec);
  return { p, inner, spec, dest: p.destination as PumpSwapDestination };
}
const poolTx = (name: string) => normalizeTransaction(GRAD.poolTxs[name]);

describe("pump.fun → PumpSwap graduation", () => {
  test("migrate_v2 names the canonical PumpSwap pool of the coin", () => {
    expect(M).toMatchObject({ kind: "pumpfun_pumpswap", bondingPool: GRAD.bondingCurve, destinationProgram: PUMP_AMM_PROGRAM_ID, destinationPool: GRAD.pool, baseMint: GRAD.mint, quoteMint: WSOL_MINT, signature: migTx.signature, slot: migTx.slot });
    expect(parseMigration(migTx, "pump_fun", derivePumpBondingCurve(Keypair.generate().publicKey.toBase58()))).toBeNull();
    expect(parseMigration(migTx, "raydium_launchlab", GRAD.bondingCurve)).toBeNull();
    // the event of the same transaction agrees
    const ev: any = pumpEvents.decodeAll(migTx).find((e) => e.name === "CompletePumpAmmMigrationEvent")!.data;
    expect([toAddr(ev.pool), toAddr(ev.bonding_curve), toAddr(ev.mint)]).toEqual([GRAD.pool, GRAD.bondingCurve, GRAD.mint]);
  });

  test("the graduation is verified strictly against chain state", async () => {
    const v = await verifyMigration(gradRpc(), M, CTX);
    expect(v.failed).toEqual([]);
    expect(migrationVerified(v)).toBe(true);
    expect(v.requiredChecks).toEqual(["destinationExists", "destinationProgramIsPumpSwap", "ownedByExpectedProgram", "layoutMatches", "mintsMatch", "canonicalPoolOfMint", "createdByPumpPoolAuthority", "quoteVaultOwnedByTokenProgram"]);
    expect(v.pumpSwap).toMatchObject({ coinCreator: GRAD.coinCreator, poolCreator: pumpPoolAuthority(GRAD.mint), quoteTokenProgram: TOKEN, holderReward: false, cashback: false });

    const poolData = Buffer.from(GRAD.accounts[GRAD.pool].data, "base64");
    const tamper = (f: (d: Buffer) => void) => {
      const d = Buffer.from(poolData);
      f(d);
      return d;
    };
    const failing = async (over: Parameters<typeof gradRpc>[0], m = M) => (await verifyMigration(gradRpc(over), m, CTX)).failed;
    expect(await failing({ [GRAD.pool]: null })).toContain("destinationExists");
    expect(await failing({ [GRAD.pool]: { owner: PUMP_PROGRAM_ID } })).toContain("ownedByExpectedProgram");
    expect(await failing({ [GRAD.pool]: { data: tamper((d) => d.fill(0, 0, 8)) } })).toContain("layoutMatches");
    expect(await failing({ [GRAD.pool]: { data: tamper((d) => Keypair.generate().publicKey.toBuffer().copy(d, 43)) } })).toContain("mintsMatch");
    expect(await failing({ [GRAD.pool]: { data: tamper((d) => Keypair.generate().publicKey.toBuffer().copy(d, 11)) } })).toContain("createdByPumpPoolAuthority");
    expect(await failing({ [GRAD.pool]: { data: tamper((d) => d.writeUInt16LE(1, 9)) } })).toContain("canonicalPoolOfMint");
    // a pool at any other address is not this coin's graduation
    const elsewhere = Keypair.generate().publicKey.toBase58();
    expect(await failing({ [elsewhere]: { owner: PUMP_AMM_PROGRAM_ID, lamports: 1, data: poolData } }, { ...M, destinationPool: elsewhere })).toContain("canonicalPoolOfMint");
    expect(await failing({}, { ...M, destinationProgram: PUMP_PROGRAM_ID })).toContain("destinationProgramIsPumpSwap");
  });

  test("the destination continues the creator allocation only for the same, declared creator wallet", async () => {
    const { p, spec, dest } = await graduated();
    expect(spec).toMatchObject({ kind: "pumpfun_pumpswap", pool: GRAD.pool, program: PUMP_AMM_PROGRAM_ID });
    expect(spec.ctx).toMatchObject({ sourceProvider: "pump_fun", sourcePool: GRAD.bondingCurve, baseMint: GRAD.mint, quoteMint: WSOL_MINT, beneficiary: GRAD.creator, migrationSignature: migTx.signature });
    expect(spec.allocation).toMatchObject({ phase: "post_migration_trading", verification: "verified", beneficiary: GRAD.creator, pool: GRAD.pool, provider: "pump_fun" });
    expect(spec.lpAllocation).toBeUndefined(); // pump.fun gives the creator no LP
    const info = p.info();
    expect(info.accountingPools).toEqual([GRAD.bondingCurve, GRAD.pool]);
    expect(info.destination).toMatchObject({ kind: "pumpfun_pumpswap", pool: GRAD.pool, supported: true });
    expect(info.watchAddresses).toEqual([GRAD.bondingCurve, pumpCreatorVault(GRAD.creator), GRAD.pool, dest.vault]);
    expect(dest.vault).toBe(pumpSwapCreatorVaultAta(GRAD.creator));
    expect(info.watchFromSlot![GRAD.pool]).toBe(migTx.slot);
    expect(storedSpecProblems(p.inner.info(), { ...verified, status: "verified", verified: true, spec })).toEqual([]);

    expect((await graduated(null)).spec.allocation.verification).toBe("not_declared");
    // the pool pays someone else (e.g. fee sharing set up after launch): never the beneficiary's
    const other = Keypair.generate().publicKey.toBase58();
    const inner = bonding(GRAD.mint, GRAD.creator, GRAD.creator, null, { complete: true });
    const moved = destinationSpec(inner.info(), { ...verified, pumpSwap: { ...verified.pumpSwap!, coinCreator: other } }, inner.lpCheck)!;
    expect(moved.allocation.verification).toBe("unverifiable");
    expect(moved.allocation.problems.join(" ")).toContain("is not the beneficiary");
    expect(destinationSpec(inner.info(), { ...verified, pumpSwap: { ...verified.pumpSwap!, holderReward: true } }, inner.lpCheck)!.allocation.verification).toBe("unverifiable");
    // an unverified graduation never produces a destination
    expect(destinationSpec(inner.info(), { ...verified, checks: { ...verified.checks, canonicalPoolOfMint: false } }, inner.lpCheck)).toBeNull();
  });

  test("createProvider wires pump_fun as a migration-aware provider", () => {
    const p = createProvider({ id: "pump_fun", poolAddress: GRAD.bondingCurve, tokenMint: GRAD.mint, role: "creator", payoutMint: WSOL_MINT }, null);
    expect(p).toBeInstanceOf(MigrationAwareProvider);
    expect((p as MigrationAwareProvider).inner).toBeInstanceOf(PumpFunProvider);
    expect(p.id).toBe("pump_fun");
  });
});

describe("PumpSwap trades after graduation", () => {
  test("legacy pool trades: the coin creator fee of the event is what reached the creator's vault", async () => {
    const { p, dest } = await graduated();
    for (const [name, side] of [["buy_exact_quote_in", "buy"], ["sell", "sell"]] as const) {
      const t = poolTx(name);
      const ev: any = ammEvents.decodeAll(t).find((e) => (e.name === "BuyEvent" || e.name === "SellEvent") && toAddr((e.data as any).pool) === GRAD.pool)!.data;
      const r = p.parseTransaction(t);
      expect(r.anomalies).toEqual([]);
      expect(r.attributions).toEqual([]);
      expect(r.swaps).toHaveLength(1);
      const s = r.swaps[0]!;
      expect(s).toMatchObject({ side, pool: GRAD.pool, feePhase: "post_migration_trading", payoutEligible: true, feeStatus: "observed", eligibleFeeMint: WSOL_MINT, basisId: dest.allocation.id, trader: toAddr(ev.user) });
      expect(s.eligibleFee).toBe(toBig(ev.coin_creator_fee));
      expect(s.eligibleFee).toBeGreaterThan(0n);
      expect(s.totalFee).toBe(toBig(ev.lp_fee) + toBig(ev.protocol_fee) + toBig(ev.coin_creator_fee));
      expect(s.quoteAmount).toBe(side === "buy" ? toBig(ev.user_quote_amount_in) : toBig(ev.user_quote_amount_out));
      // independent signal: the vault's token balance change in the same transaction
      expect(tokenAccountDelta(t, dest.vault)).toBe(s.eligibleFee);
      expect(s.evidence).toMatchObject({ settledTo: "coin_creator_vault", coinCreator: GRAD.coinCreator });
    }
  });

  test("_v2 pool trades leave the fee in the pool: attributed from the event, vault untouched", async () => {
    const { p, dest } = await graduated();
    const t = poolTx("buy_exact_quote_in_v2");
    const ev: any = ammEvents.decodeAll(t).find((e) => e.name === "BuyEvent" && toAddr((e.data as any).pool) === GRAD.pool)!.data;
    const r = p.parseTransaction(t);
    expect(r.anomalies).toEqual([]);
    expect(r.attributions).toEqual([]);
    const s = r.swaps[0]!;
    expect(s).toMatchObject({ side: "buy", pool: GRAD.pool, payoutEligible: true });
    expect(s.eligibleFee).toBe(toBig(ev.coin_creator_fee));
    expect(s.evidence).toMatchObject({ ix: "buy_exact_quote_in_v2", settledTo: "pool_bucket" });
    expect(tokenAccountDelta(t, dest.vault)).toBe(0n);
    expect(toBig(ev.creator_fee_unclaimed)).toBeGreaterThanOrEqual(s.eligibleFee);
  });

  test("not payable without a verified creator; other pools and pre-migration activity are ignored", async () => {
    const t = poolTx("sell");
    const s = (await graduated(null)).p.parseTransaction(t).swaps[0]!;
    expect(s.payoutEligible).toBe(true); // recorded; a not_declared basis is never DISTRIBUTED (basisDistributable)
    expect(basisDistributable((await graduated(null)).dest.allocation)).toBe(false);
    const mism = (await graduated(Keypair.generate().publicKey.toBase58())).p.parseTransaction(t).swaps[0]!;
    expect(mism).toMatchObject({ payoutEligible: false, feeStatus: "unresolved" });
    const { p, dest } = await graduated();
    for (const name of ["amm-buy", "amm-sell", "amm-buy-v2", "amm-sell-v2", "amm-sweep-crank", "amm-collect-token-quote", "amm-sweep-collect"]) expect(p.parseTransaction(tx(name))).toEqual({ swaps: [], claims: [], anomalies: [], attributions: [] });
    const early = { ...t, slot: migTx.slot - 1 };
    const r = dest.parse(early);
    expect(r.swaps).toEqual([]);
    expect(r.anomalies[0]).toContain("precedes the verified migration slot");
  });
});

/** The PumpSwap adapter of the pool whose creator collected in the `amm-sweep-collect` fixture. */
function collectingPool(rpc: any = null) {
  const t = tx("amm-sweep-collect");
  const evs = ammEvents.decodeAll(t);
  const sweep: any = evs.find((e) => e.name === "SweepPoolFeeEvent")!;
  const collect: any = evs.find((e) => e.name === "CollectCoinCreatorFeeEvent")!;
  const creator = toAddr(collect.data.coin_creator);
  const pool = toAddr(sweep.data.pool);
  const mint = toAddr(sweep.data.base_mint);
  const inner = bonding(mint, creator, creator, rpc, { complete: true });
  const v = { ...verified, destinationPool: pool, baseMint: mint, tokenAMint: mint, pumpSwap: { ...verified.pumpSwap!, coinCreator: creator, poolQuoteTokenAccount: sweep.parent.accounts[5] } } as VerifiedMigration;
  const spec = destinationSpec(inner.info(), v, inner.lpCheck)!;
  const p = new MigrationAwareProvider(inner, rpc);
  p.attach(spec);
  return { t, p, inner, dest: p.destination as PumpSwapDestination, creator, pool, mint, sweepIx: sweep.parent, collectIx: collect.parent, swept: toBig(sweep.data.amount), collected: toBig(collect.data.coin_creator_fee) };
}

describe("PumpSwap creator-fee claims", () => {
  beforeAll(async () => {
    verified ??= await verifyMigration(gradRpc(), M, CTX);
  });

  test("collect_coin_creator_fee: the claim is the event amount, moved out of the creator's vault", () => {
    const { t, p, dest, creator, pool, swept, collected } = collectingPool();
    expect(collected).toBe(406_981_090n);
    const r = p.parseTransaction(t);
    expect(r.anomalies).toEqual([]);
    expect(r.swaps).toEqual([]);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({ claimer: creator, pool, quoteAmount: collected, baseAmount: 0n });
    // the vault received this pool's sweep and paid the collection: nothing foreign
    expect(tokenAccountDelta(t, dest.vault)).toBe(swept - collected);
    expect(r.attributions).toEqual([]);
    // the same collection seen from another pool of that creator: the sweep is another coin's deposit
    const other = { ...collectingPool() };
    const otherDest = new PumpSwapDestination(null, Keypair.generate().publicKey.toBase58(), dest.facts, { sourceProvider: "pump_fun", sourcePool: other.inner.info().poolAddress, baseMint: other.mint, quoteMint: WSOL_MINT, beneficiary: creator, migrationSlot: 1, migrationSignature: "x" }, dest.allocation);
    const seen = otherDest.parse(t);
    expect(seen.claims).toHaveLength(1);
    expect(seen.attributions).toHaveLength(1);
    expect(seen.attributions![0]).toMatchObject({ kind: "shared_vault_inflow", excludedReason: "shared_vault_other_pool", excludedAmount: swept, phase: "post_migration_trading" });
    // a collection in another quote token (pump-coin quote) is not this launch's SOL
    expect(p.parseTransaction(tx("amm-collect-token-quote")).claims).toEqual([]);
  });

  test("the claim plan is sweep + collect + unwrap, account for account like the real transaction", async () => {
    const fx = collectingPool();
    const poolData = Buffer.from(GRAD.accounts[GRAD.pool].data, "base64");
    const poolWith = (bucket: bigint, coinCreator = fx.creator) => {
      const d = Buffer.from(poolData);
      new PublicKey(coinCreator).toBuffer().copy(d, 211);
      d.writeBigUInt64LE(bucket, 279);
      return d;
    };
    const vaultWith = (amount: bigint) => {
      const d = Buffer.alloc(165);
      d.writeBigUInt64LE(amount, 64);
      return d;
    };
    const rpc = (vault: bigint | null, bucket: bigint, coinCreator?: string) => gradRpc({ [fx.dest.vault]: vault === null ? null : { owner: TOKEN, lamports: 2_039_280, data: vaultWith(vault) }, [fx.pool]: { owner: PUMP_AMM_PROGRAM_ID, lamports: 1, data: poolWith(bucket, coinCreator) }, [pumpCreatorVault(fx.creator)]: { owner: ZERO, lamports: RENT_FLOOR, data: Buffer.alloc(0) }, [derivePumpBondingCurve(fx.mint)]: null });
    const claimer = new PublicKey(fx.creator);
    const { p, dest } = collectingPool(rpc(405_682_212n, 1_298_878n));
    expect(await dest.claimState(fx.creator)).toMatchObject({ vaultBalance: 405_682_212n, poolBucket: 1_298_878n, vaultExists: true, coinCreator: fx.creator });
    // what a claim would pay now includes PumpSwap; the reconciled bonding-curve balance does not
    expect(await p.getFeeSourceState()).toMatchObject({ unclaimedQuote: BigInt(RENT_FLOOR), claimableQuote: 406_981_090n });

    const plan = await p.buildClaimInstructions(claimer, claimer);
    const amm = plan.instructions.filter((i) => i.programId.toBase58() === PUMP_AMM_PROGRAM_ID);
    expect(plan.instructions.some((i) => i.programId.toBase58() === PUMP_PROGRAM_ID)).toBe(false); // nothing left on the curve
    expect(amm).toHaveLength(2);
    const [sweep, collect] = amm as [any, any];
    expect(Buffer.from(sweep.data).equals(fx.sweepIx.data)).toBe(true);
    expect(sweep.keys.map((k: any) => k.pubkey.toBase58())).toEqual(fx.sweepIx.accounts); // the creator paid the real sweep too
    expect(sweep.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(Buffer.from(collect.data).equals(fx.collectIx.data)).toBe(true);
    expect(collect.keys.map((k: any) => k.pubkey.toBase58())).toEqual(fx.collectIx.accounts);
    expect(collect.keys.some((k: any) => k.isSigner)).toBe(false);
    // first the creator's WSOL account is created, last it is closed (fees arrive as native SOL)
    expect(plan.instructions[0]!.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const close = plan.instructions.at(-1)!;
    expect(close.programId.toBase58()).toBe(TOKEN);
    expect(close.data[0]).toBe(9);
    expect(close.keys.map((k) => k.pubkey.toBase58())).toEqual([fx.collectIx.accounts[5], fx.creator, fx.creator]);

    // residual bonding-curve fees are collected in the same transaction, before the PumpSwap leg
    const both = collectingPool(gradRpc({ [fx.dest.vault]: { owner: TOKEN, lamports: 2_039_280, data: vaultWith(1_000n) }, [fx.pool]: { owner: PUMP_AMM_PROGRAM_ID, lamports: 1, data: poolWith(0n) }, [pumpCreatorVault(fx.creator)]: { owner: ZERO, lamports: RENT_FLOOR + 777, data: Buffer.alloc(0) }, [derivePumpBondingCurve(fx.mint)]: null }));
    const payout = Keypair.generate().publicKey;
    const bothPlan = await both.p.buildClaimInstructions(claimer, payout);
    expect(bothPlan.instructions.map((i) => i.programId.toBase58())).toEqual([PUMP_PROGRAM_ID, ZERO, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", PUMP_AMM_PROGRAM_ID, TOKEN]);
    expect(bothPlan.instructions[1]!.data.readBigUInt64LE(4)).toBe(777n);
    expect(bothPlan.instructions.at(-1)!.keys[1]!.pubkey.equals(payout)).toBe(true);

    // nothing on PumpSwap: the plain bonding-curve claim; a pool paying another creator is never swept
    const none = collectingPool(rpc(null, 0n));
    expect((await none.p.buildClaimInstructions(claimer, claimer)).instructions.map((i) => i.programId.toBase58())).toEqual([PUMP_PROGRAM_ID]);
    const foreignPool = collectingPool(rpc(5n, 9_999n, Keypair.generate().publicKey.toBase58()));
    expect(await foreignPool.dest.claimState(fx.creator)).toMatchObject({ vaultBalance: 5n, poolBucket: 0n });
    expect(await fx.dest.claimState(fx.creator)).toBeNull(); // no RPC
  });
});

// ── reward funding ───────────────────────────────────────────────────────────────────────────

const DEST = Keypair.generate().publicKey.toBase58();
const runtime = (activationSlot: number): RevenueRuntime => ({ cluster: "mainnet-beta", policy: makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot, ...APPROVED_SHARES }), fundingDestinations: [DEST], forgePlatformLpBeneficiary: null, correlationMode: "strict" });

describe("pump.fun creator fees fund rewards in both phases", () => {
  beforeAll(async () => {
    verified ??= await verifyMigration(gradRpc(), M, CTX);
  });

  test("stream model: PumpSwap collections split 75 % rewards / 25 % creator, like the bonding curve", () => {
    expect(SPLIT_OF.pumpswap_creator_fee).toEqual({ contribution: "pumpswap_creator_last60_contribution", retained: "pumpswap_creator_retained" });
    expect(STREAM_INFO.pumpswap_creator_last60_contribution).toMatchObject({ phase: "post_migration", rewardEligible: true, allocationOwner: "creator", custodian: "creator" });
    expect(STREAM_INFO.pumpswap_creator_fee.rewardEligible).toBe(false);
  });

  const bondingClaim = () => {
    const t = tx("bonding-sweep-collect");
    const ev: any = pumpEvents.decodeAll(t).find((e) => e.name === "CollectCreatorFeeEvent")!;
    const creator = toAddr(ev.data.creator);
    const mint = t.instructions.find((i) => i.programId === PUMP_PROGRAM_ID)!.accounts[2]!;
    return { t, creator, mint, amount: toBig(ev.data.creator_fee) };
  };

  test("bonding curve: collect_creator_fee is a native-SOL collection of the creator", () => {
    const { t, creator, mint, amount } = bondingClaim();
    const p = new MigrationAwareProvider(bonding(mint, creator), null);
    const drafts = extractRevenue(t, p.parseTransaction(t), revenueFactsOf(p, runtime(1)));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: "collection", stream: "bonding_curve_creator_fee", launchPhase: "bonding_curve", pool: derivePumpBondingCurve(mint), feeMint: NATIVE_SOL, asset: WSOL_MINT, decimals: 9, netAmount: amount, sourceAccount: pumpCreatorVault(creator), destinationAccount: creator, beneficiary: creator });
    // a collection by another creator is not this launch's revenue
    const stranger = new MigrationAwareProvider(bonding(mint, Keypair.generate().publicKey.toBase58()), null);
    expect(extractRevenue(t, stranger.parseTransaction(t), revenueFactsOf(stranger, runtime(1)))).toEqual([]);
  });

  test("bonding curve: claim + memo'd creator transfer → payable credit of exactly 75 %", async () => {
    const db = await freshDb();
    const { t, creator, mint, amount } = bondingClaim();
    const p = new MigrationAwareProvider(bonding(mint, creator), null);
    const r = runtime(t.slot - 10);
    await ingestRevenue(db, t, p.parseTransaction(t), p, r, { commitment: "finalized" });
    const col: any = await db.RevenueEvent.findOne({ stream: "bonding_curve_creator_fee" }).lean();
    expect(col).toMatchObject({ status: "collected", sourcePool: derivePumpBondingCurve(mint), beneficiary: creator, provider: "pump_fun" });
    expect(col.snapshot.verification).toBe("verified");
    const share = (amount * 7_500n) / 10_000n;
    expect(big((await db.RevenueReconciliation.findOne({ key: col.key }).lean() as any).expectedLast60)).toBe(share);
    const transfer = buildTx({ slot: t.slot + 5, ixs: [systemTransfer(creator, DEST, share), memo(`last60:v1:${t.signature}`)], feePayer: creator });
    expect((await ingestRevenue(db, transfer, p.parseTransaction(transfer), p, r, { commitment: "finalized" })).newCredits).toBe(1);
    const credit: any = await db.RewardFunding.findOne({}).lean();
    expect(credit).toMatchObject({ stream: "bonding_curve_last60_reward_contribution", correlationMethod: "memo", payoutEligible: true, creator, collectionKey: col.key });
    expect(big(credit.creditableAmount)).toBe(share);
    expect((await db.RevenueReconciliation.findOne({ key: col.key }).lean() as any).status).toBe("reconciled");
  });

  test("bonding curve: an undeclared creator, or a vault mixed with another coin's fees, is not creditable", async () => {
    const { t, creator, mint } = bondingClaim();
    const r = runtime(t.slot - 10);
    let db = await freshDb();
    const undeclared = new MigrationAwareProvider(bonding(mint, creator, null), null);
    await ingestRevenue(db, t, undeclared.parseTransaction(t), undeclared, r, { commitment: "finalized" });
    let col: any = await db.RevenueEvent.findOne({ stream: "bonding_curve_creator_fee" }).lean();
    expect(col.status).toBe("unresolved");
    expect(col.snapshot.problems.join(" ")).toContain("bonding_curve_allocation_not_declared");

    db = await freshDb();
    const p = new MigrationAwareProvider(bonding(mint, creator), null);
    await db.FeeAttribution.create({ key: "vault-inflow:test", kind: "shared_vault_inflow", phase: "bonding_curve", provider: "pump_fun", sourcePool: derivePumpBondingCurve(mint), pool: derivePumpBondingCurve(mint), destinationPool: null, beneficiary: creator, feeMint: WSOL_MINT, creatorAmount: "0", excludedAmount: "5", excludedReason: "shared_vault_other_pool", slot: t.slot - 1, status: "observed", payoutEligible: false });
    await ingestRevenue(db, t, p.parseTransaction(t), p, r, { commitment: "finalized" });
    col = await db.RevenueEvent.findOne({ stream: "bonding_curve_creator_fee" }).lean();
    expect(col.snapshot.problems.join(" ")).toContain("shared_creator_vault_mixed_with_other_pools");
    expect(col.snapshot.verification).not.toBe("verified");
  });

  test("PumpSwap: the real collection is a creator collection; claim + memo'd transfer → 75 % credit", async () => {
    const db = await freshDb();
    const { t, p, creator, pool, collected, inner } = collectingPool();
    const r = runtime(1);
    const drafts = extractRevenue(t, p.parseTransaction(t), revenueFactsOf(p, r));
    expect(drafts).toHaveLength(1);
    // collected into a WSOL account the same transaction closes: the owner is proven from the ATA address
    expect(drafts[0]).toMatchObject({ kind: "collection", stream: "pumpswap_creator_fee", launchPhase: "post_migration", pool, feeMint: WSOL_MINT, netAmount: collected, beneficiary: creator, destinationOwner: creator });

    await ingestRevenue(db, t, p.parseTransaction(t), p, r, { commitment: "finalized" });
    const col: any = await db.RevenueEvent.findOne({ stream: "pumpswap_creator_fee" }).lean();
    expect(col).toMatchObject({ status: "collected", sourcePool: inner.info().poolAddress, beneficiary: creator });
    expect(col.snapshot.verification).toBe("verified");
    const share = (collected * 7_500n) / 10_000n;
    const transfer = buildTx({ slot: t.slot + 5, ixs: [systemTransfer(creator, DEST, share), memo(`last60:v1:${t.signature}`)], feePayer: creator });
    expect((await ingestRevenue(db, transfer, p.parseTransaction(transfer), p, r, { commitment: "finalized" })).newCredits).toBe(1);
    const credit: any = await db.RewardFunding.findOne({}).lean();
    expect(credit).toMatchObject({ stream: "pumpswap_creator_last60_contribution", correlationMethod: "memo", payoutEligible: true, launchPhase: "post_migration", creator, collectionKey: col.key });
    expect(big(credit.creditableAmount)).toBe(share);
    const report = await buildRevenueReport(db, { sourcePool: inner.info().poolAddress, policy: r.policy });
    expect(report.buyerRewards.verifiedPumpSwapCreatorFunding[WSOL_MINT]).toBe(share.toString());
    expect(report.postMigration.pumpSwapCreatorFees[WSOL_MINT]!.collections).toBe(1);
  });

  test("PumpSwap: a collection that includes another coin's fees cannot be apportioned", async () => {
    const db = await freshDb();
    const { t, p, creator, pool, inner } = collectingPool();
    const curve = inner.info().poolAddress;
    await db.FeeAttribution.create({ key: "vault-inflow:test", kind: "shared_vault_inflow", phase: "post_migration_trading", provider: "pump_fun", sourcePool: curve, pool, destinationPool: pool, beneficiary: creator, feeMint: WSOL_MINT, creatorAmount: "0", excludedAmount: "5", excludedReason: "shared_vault_other_pool", slot: t.slot - 1, status: "observed", payoutEligible: false });
    await ingestRevenue(db, t, p.parseTransaction(t), p, runtime(1), { commitment: "finalized" });
    const col: any = await db.RevenueEvent.findOne({ stream: "pumpswap_creator_fee" }).lean();
    expect(col.status).toBe("unresolved");
    expect(col.snapshot.problems.join(" ")).toContain("shared_creator_vault_mixed_with_other_pools");
  });
});
