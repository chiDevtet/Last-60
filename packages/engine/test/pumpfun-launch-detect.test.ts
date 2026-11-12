/**
 * pump.fun launch detection from a dedicated creator wallet (providers/pumpfun/launchDetect.ts): the coin's
 * mint is unknown before launch, so the indexer finds the coin the creator wallet itself created and sets
 * the token mint automatically. Real mainnet create_v2 transactions (pumpfun-txs.json `bonding-buy-v2`,
 * pumpfun-launch.json `create-v2`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { normalizeTransaction } from "../src/chain/tx";
import { loadConfig } from "../src/config/env";
import { pumpLaunchKey, resolveSettings, SettingsStore, validateEffective } from "../src/config/runtime";
import { Indexer } from "../src/indexer/Indexer";
import { pumpLaunchesIn, PumpLaunchDetector, type PumpLaunch } from "../src/providers/pumpfun/launchDetect";
import { derivePumpBondingCurve } from "../src/providers/pumpfun/pda";
import { loadFixture } from "./fixtureRpc";
import { freshDb, startDb, stopDb, testConfig } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const MAMA_RAW = loadFixture("pumpfun-txs.json")["bonding-buy-v2"];
const MAMA = { creator: "7FVfSdnR9VPGjMtmBP1Hz9C2DFTpoNX8gVVRmnimnGt9", mint: "A8CtkJoX9U7cVdoXAubzHH92bPpPy1HnoK7j74bbpump" };
const OTHER_RAW = loadFixture("pumpfun-launch.json")["create-v2"];
const OTHER = { creator: "7J7pG2EuXhrYBSweh4PRPcGUmW1jPgRjgv1MTd337Fja", mint: "2VjWUuWvduVdt3xiUsr9E1ASUvrkKTddY6pFSTjRpump" };
const sigOf = (raw: any) => raw.transaction.signatures[0] as string;

/** A wallet's history (newest first) served like getSignaturesForAddress / getTransaction. */
function historyRpc(byWallet: Record<string, any[]>) {
  const calls = { sigs: 0, txs: [] as string[] };
  const all = () => new Map(Object.values(byWallet).flat().map((r) => [sigOf(r), r]));
  return {
    calls,
    rpc: {
      getSignaturesForAddress: async (addr: string, o: { limit?: number; before?: string; until?: string } = {}) => {
        calls.sigs++;
        let list = (byWallet[addr] ?? []).map((r) => ({ signature: sigOf(r), err: r.meta?.err ?? null, slot: r.slot, blockTime: r.blockTime }));
        if (o.until) list = list.slice(0, Math.max(0, list.findIndex((x) => x.signature === o.until)));
        if (o.before) list = list.slice(list.findIndex((x) => x.signature === o.before) + 1);
        return list.slice(0, o.limit ?? 1000) as any;
      },
      getTransactionRaw: async (sig: string) => {
        calls.txs.push(sig);
        return all().get(sig) ?? null;
      },
    },
  };
}
/** An unrelated transaction of `wallet` (a plain transfer it signed). */
function noise(wallet: string, n: number) {
  return { slot: 1, blockTime: 1, meta: { err: null, fee: 5000, preBalances: [10, 0], postBalances: [5, 5], innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: [`noise${n}${"1".repeat(80)}`.slice(0, 88)], message: { accountKeys: [wallet, Keypair.generate().publicKey.toBase58()], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [], recentBlockhash: "11111111111111111111111111111111" } }, version: "legacy" };
}

describe("a pump.fun launch is found from the creator wallet that signed it", () => {
  test("real create_v2 transactions: the mint, its canonical bonding curve, name and symbol", () => {
    const [mama] = pumpLaunchesIn(normalizeTransaction(MAMA_RAW), MAMA.creator);
    expect(mama).toMatchObject({ mint: MAMA.mint, bondingCurve: derivePumpBondingCurve(MAMA.mint), signature: sigOf(MAMA_RAW), symbol: "MAMA" });
    const [other] = pumpLaunchesIn(normalizeTransaction(OTHER_RAW), OTHER.creator);
    expect(other).toMatchObject({ mint: OTHER.mint, bondingCurve: derivePumpBondingCurve(OTHER.mint) });
  });

  test("never attributed to a wallet that did not create it or did not sign it", () => {
    const tx = normalizeTransaction(MAMA_RAW);
    expect(pumpLaunchesIn(tx, OTHER.creator)).toEqual([]); // another wallet
    tx.signers.delete(MAMA.creator); // `creator` is an argument: without the wallet's signature it proves nothing
    expect(pumpLaunchesIn(tx, MAMA.creator)).toEqual([]);
    expect(pumpLaunchesIn({ ...normalizeTransaction(MAMA_RAW), err: { InstructionError: [0, "x"] } }, MAMA.creator)).toEqual([]);
  });

  test("the scanner waits, then finds the launch reading only new signatures; refuses a busy or reused wallet", async () => {
    const history: Record<string, any[]> = { [MAMA.creator]: [noise(MAMA.creator, 1)] };
    const { rpc, calls } = historyRpc(history);
    const d = new PumpLaunchDetector(rpc as any, MAMA.creator);
    expect(await d.scan()).toEqual({ status: "not_found", scanned: 1 });
    history[MAMA.creator]!.unshift(MAMA_RAW, noise(MAMA.creator, 2)); // launched (newest first)
    const r = await d.scan();
    expect(r).toMatchObject({ status: "found", launch: { mint: MAMA.mint }, scanned: 3 });
    expect(calls.txs.filter((s) => s.startsWith("noise1"))).toHaveLength(1); // the old history is not re-read
    // A wallet with a long history is not a fresh, dedicated creator wallet.
    const busy = historyRpc({ [MAMA.creator]: [MAMA_RAW, ...Array.from({ length: 6 }, (_, i) => noise(MAMA.creator, i + 10))] });
    expect((await new PumpLaunchDetector(busy.rpc as any, MAMA.creator, { maxSignatures: 5, pageSize: 3 }).scan()).status).toBe("too_much_history");
    // Two coins from one wallet: which one is ours is not guessed.
    const two: PumpLaunch[] = [{ mint: MAMA.mint, bondingCurve: "", signature: "a", slot: 2, blockTime: null, name: null, symbol: null }, { mint: OTHER.mint, bondingCurve: "", signature: "b", slot: 1, blockTime: null, name: null, symbol: null }];
    const amb = historyRpc({ [MAMA.creator]: [MAMA_RAW] });
    const a = await new PumpLaunchDetector(amb.rpc as any, MAMA.creator, { extract: () => two }).scan();
    expect(a).toMatchObject({ status: "ambiguous", launches: [{ mint: OTHER.mint }, { mint: MAMA.mint }] });
  });
});

describe("settings: the detected coin becomes the pump.fun token mint", () => {
  const env = { SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: "https://api.devnet.solana.com", MONGODB_URI: "mongodb://x", REWARD_FUNDING_POLICY: "legacy_creator_fee_v1" };
  const dbcEnv = { ...env, LAUNCH_PROVIDER: "meteora_dbc", TOKEN_MINT: "LVRmUKAzeQEs6BZvvzeDNELewxdMXQ1udVwEzK8woAP", LAST60_CREATOR_WALLET_ADDRESS: MAMA.creator };

  test("another provider's TOKEN_MINT never carries over; the creator wallet's launch is used; an explicit mint wins", () => {
    const cfg = loadConfig("api", dbcEnv);
    const waiting = resolveSettings(cfg, { launchProvider: "pump_fun" }, 1);
    expect(waiting).toMatchObject({ tokenMint: null, tokenMintSource: null, poolAddress: null });
    expect(validateEffective(cfg, waiting)).toEqual([]); // a valid waiting state: the launch will be detected
    const found = { [pumpLaunchKey(MAMA.creator)]: MAMA.mint, [pumpLaunchKey(OTHER.creator)]: OTHER.mint };
    const s = resolveSettings(cfg, { launchProvider: "pump_fun" }, 1, found);
    expect(s).toMatchObject({ tokenMint: MAMA.mint, tokenMintSource: "detected", poolAddress: derivePumpBondingCurve(MAMA.mint), poolAddressSource: "derived" });
    expect(validateEffective(cfg, s)).toEqual([]);
    expect(resolveSettings(cfg, { launchProvider: "pump_fun", tokenMint: OTHER.mint }, 1, found)).toMatchObject({ tokenMint: OTHER.mint, tokenMintSource: "configured" });
    // The DBC launch itself is unchanged.
    expect(resolveSettings(cfg, {}, 1, found)).toMatchObject({ launchProvider: "meteora_dbc", tokenMint: dbcEnv.TOKEN_MINT, tokenMintSource: "configured" });
    // Without a creator wallet nothing can be detected: a mint is required.
    const none = loadConfig("api", { ...dbcEnv, LAST60_CREATOR_WALLET_ADDRESS: "" });
    expect(validateEffective(none, resolveSettings(none, { launchProvider: "pump_fun" }, 1, found)).join()).toMatch(/creator wallet/);
  });

  test("the indexer records the launch it detects and the effective settings follow it", async () => {
    const db = await freshDb();
    const cfg = testConfig({ LAST60_CREATOR_WALLET_ADDRESS: MAMA.creator });
    const settings = new SettingsStore(db, cfg, 0);
    await settings.update({ launchProvider: "pump_fun" }, { actor: "admin", expectedVersion: 0 });
    const { rpc } = historyRpc({ [MAMA.creator]: [MAMA_RAW] });
    const idx = new Indexer({ db, cfg, settings, rpc: rpc as any, wsFactory: null });
    const next = await (idx as any).detectPumpLaunch(await settings.get(true));
    expect(next).toMatchObject({ tokenMint: MAMA.mint, tokenMintSource: "detected", poolAddress: derivePumpBondingCurve(MAMA.mint) });
    // Remembered for this creator wallet (survives restarts); never overwritten by a later scan.
    expect(await settings.get(true)).toMatchObject({ tokenMint: MAMA.mint });
    // Before the launch: a quiet waiting state.
    const db2 = await freshDb();
    const waiting = new Indexer({ db: db2, cfg, settings: new SettingsStore(db2, cfg, 0), rpc: historyRpc({}).rpc as any, wsFactory: null });
    await expect((waiting as any).detectPumpLaunch({ launchProvider: "pump_fun", tokenMint: null })).rejects.toThrow(/watching the creator wallet/);
  });
});
