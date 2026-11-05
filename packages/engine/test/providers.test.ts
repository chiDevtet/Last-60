/**
 * Provider adapters against REAL mainnet transactions and account data
 * (test/fixtures/mainnet, collected with scripts/fetch-fixtures.ts).
 *
 * Every decoded amount is cross-checked against an independent signal — vault token-balance
 * deltas in the same transaction — and account decoders / claim instructions are compared with
 * the official Meteora and Raydium SDKs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { LaunchpadPool, PlatformConfig, claimCreatorFee as sdkClaimCreatorFee, getPdaCreatorVault, getPdaCreatorFeeVaultAuth } from "@raydium-io/raydium-sdk-v2";
import { deriveDbcPoolAuthority, deriveDbcEventAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { normalizeTransaction, tokenAccountDelta } from "../src/chain/tx";
import { AnchorEventDecoder, toAddr, toBig } from "../src/chain/anchorEvents";
import { MeteoraDBCProvider, DBC_PROGRAM_ID, DBC_POOL_AUTHORITY, DBC_EVENT_AUTHORITY } from "../src/providers/meteora/MeteoraDBCProvider";
import {
  RaydiumLaunchLabProvider,
  LAUNCHLAB_PROGRAM_ID,
  decodeLaunchLabPool,
  decodeLaunchLabPlatformConfig,
  creatorFeeVault,
  CREATOR_FEE_VAULT_AUTH,
} from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { FakeChain } from "../src/testing/fakeChain";
import dbcIdl from "../src/providers/meteora/idl/dynamic_bonding_curve.json";
import llIdl from "../src/providers/raydium/idl/raydium_launchpad.json";

const FIX = join(import.meta.dir, "fixtures/mainnet");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const WSOL = "So11111111111111111111111111111111111111112";
const SPL = TOKEN_PROGRAM_ID.toBase58();
const dbcDecoder = new AnchorEventDecoder(DBC_PROGRAM_ID, dbcIdl as any);
const llDecoder = new AnchorEventDecoder(LAUNCHLAB_PROGRAM_ID, llIdl as any);

/** Build a DBC provider for whatever pool a fixture traded on, with a chosen creator fee %. */
function dbcProviderFor(raw: any, creatorPct: number, role: "creator" | "partner" = "creator") {
  const tx = normalizeTransaction(raw);
  const ev = dbcDecoder.decodeAll(tx).find((e) => e.name === "EvtSwap3")!;
  const parent = ev.parent!;
  const pool = toAddr(ev.data.pool);
  const p = new MeteoraDBCProvider(null, { poolAddress: pool, tokenMint: parent.accounts[7]!, role });
  p.hydrate(
    { config: toAddr(ev.data.config), creator: "11111111111111111111111111111111", baseMint: parent.accounts[7]!, baseVault: parent.accounts[5]!, quoteVault: parent.accounts[6]!, isMigrated: false, migrationProgress: 0, creatorQuoteFee: 0n, creatorBaseFee: 0n, partnerQuoteFee: 0n, partnerBaseFee: 0n, transferHook: false },
    { quoteMint: parent.accounts[8]!, feeClaimer: "11111111111111111111111111111111", collectFeeMode: 0, creatorTradingFeePercentage: creatorPct, migrationOption: 1 },
    { baseDecimals: 6, quoteDecimals: 9, baseTokenProgram: SPL, quoteTokenProgram: SPL },
  );
  return { p, tx, ev, parent };
}

describe("transaction normalisation", () => {
  test("handles legacy/v0 and v1 transactions", () => {
    for (const name of ["dbc-buy-direct.json", "dbc-v1.json", "launchlab-sell.json"]) {
      const raw = fixture(name);
      const tx = normalizeTransaction(raw);
      expect(tx.signature).toBe(raw.transaction.signatures[0]);
      expect(tx.accountKeys.length).toBe(raw.transaction.message.accountKeys.length + (raw.meta.loadedAddresses?.writable?.length ?? 0) + (raw.meta.loadedAddresses?.readonly?.length ?? 0));
      expect(tx.signers.has(tx.feePayer)).toBe(true);
      expect(tx.instructions.length).toBeGreaterThan(raw.transaction.message.instructions.length - 1);
    }
    expect(fixture("dbc-v1.json").version).toBe(1);
  });

  test("every inner event CPI resolves to its emitting instruction", () => {
    for (const name of ["dbc-buy-direct.json", "dbc-buy-cpi.json", "dbc-sell.json", "dbc-v1.json"]) {
      const tx = normalizeTransaction(fixture(name));
      const evs = dbcDecoder.decodeAll(tx).filter((e) => e.name.startsWith("EvtSwap"));
      expect(evs.length).toBeGreaterThanOrEqual(3); // EvtSwap + EvtSwap2 + EvtSwap3
      for (const e of evs) {
        expect(e.parent).not.toBeNull();
        expect(e.parent!.programId).toBe(DBC_PROGRAM_ID);
        expect(e.parent!.stackHeight).toBe(e.instruction.stackHeight - 1);
      }
    }
  });
});

describe("Meteora DBC adapter", () => {
  test("PDAs match the official SDK", () => {
    expect(DBC_POOL_AUTHORITY.toBase58()).toBe(deriveDbcPoolAuthority().toBase58());
    expect(DBC_EVENT_AUTHORITY.toBase58()).toBe(deriveDbcEventAuthority().toBase58());
  });

  for (const [name, expectedSide] of [["dbc-buy-direct.json", "buy"], ["dbc-buy-cpi.json", "buy"], ["dbc-v1.json", null], ["dbc-sell.json", "sell"]] as const) {
    test(`parses ${name} and reconciles with vault balance deltas`, () => {
      const { p, tx, ev, parent } = dbcProviderFor(fixture(name), 50);
      const parsed = p.parseTransaction(tx);
      expect(parsed.anomalies).toEqual([]);
      expect(parsed.swaps.length).toBe(1); // three swap events, ONE swap — never double counted
      const s = parsed.swaps[0]!;
      if (expectedSide) expect(s.side).toBe(expectedSide);
      const d: any = ev.data;
      expect(s.side).toBe(Number(d.trade_direction) === 1 ? "buy" : "sell");
      // The trader is always a signer. Direct buys: the swap's `payer`. Router CPIs that pass a
      // program-owned account as payer resolve to the signing wallet whose token balance moved.
      expect(tx.signers.has(s.trader)).toBe(true);
      if (tx.signers.has(parent.accounts[9]!)) {
        expect(s.trader).toBe(parent.accounts[9]!);
        expect(s.traderSource).toBe("payer");
      } else {
        expect(s.traderSource).not.toBe("payer");
      }
      // Independent check: DBC's quote vault keeps fees as accrued counters, so for a buy the
      // vault grows by the gross input, and for a sell it shrinks by the net output.
      const quoteVaultDelta = tokenAccountDelta(tx, parent.accounts[6]!);
      expect(quoteVaultDelta).toBe(s.side === "buy" ? s.quoteAmount : -s.quoteAmount);
      expect(s.totalFee).toBe(toBig(d.trading_fee) + toBig(d.protocol_fee) + toBig(d.referral_fee));
      expect(s.eligibleFee).toBe((toBig(d.trading_fee) * 50n) / 100n);
      expect(s.eligibleFeeMint).toBe(Boolean(d.fee_on_base_token) ? p.info().tokenMint : p.info().quoteMint);
    });
  }

  test("creator/partner split is exact integer math with Rounding::Down", () => {
    const { p } = dbcProviderFor(fixture("dbc-buy-direct.json"), 33);
    expect(p.eligibleShare(1_600_000n)).toBe(528_000n);
    expect(p.eligibleShare(101n)).toBe(33n); // floor(101*33/100) = 33
    const partner = dbcProviderFor(fixture("dbc-buy-direct.json"), 33, "partner").p;
    expect(partner.eligibleShare(101n)).toBe(68n); // partner gets the remainder
    const zero = dbcProviderFor(fixture("dbc-buy-direct.json"), 0).p;
    expect(zero.eligibleShare(1_600_000n)).toBe(0n);
  });

  test("swaps on other pools are ignored", () => {
    const { tx, parent } = dbcProviderFor(fixture("dbc-buy-direct.json"), 50);
    const other = new MeteoraDBCProvider(null, { poolAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", tokenMint: parent.accounts[7]!, role: "creator" });
    other.hydrate(
      { config: "11111111111111111111111111111111", creator: "11111111111111111111111111111111", baseMint: parent.accounts[7]!, baseVault: parent.accounts[5]!, quoteVault: parent.accounts[6]!, isMigrated: false, migrationProgress: 0, creatorQuoteFee: 0n, creatorBaseFee: 0n, partnerQuoteFee: 0n, partnerBaseFee: 0n, transferHook: false },
      { quoteMint: parent.accounts[8]!, feeClaimer: "11111111111111111111111111111111", collectFeeMode: 0, creatorTradingFeePercentage: 50, migrationOption: 1 },
      { baseDecimals: 6, quoteDecimals: 9, baseTokenProgram: SPL, quoteTokenProgram: SPL },
    );
    expect(other.parseTransaction(tx).swaps).toEqual([]);
  });

  test("OutputToken pools charge buy fees in the base token (real mainnet pool)", () => {
    const { p, tx, ev } = dbcProviderFor(fixture("dbc-buy-direct.json"), 50);
    const s = p.parseTransaction(tx).swaps[0]!;
    const feeOnBase = Boolean((ev.data as any).fee_on_base_token);
    expect(s.eligibleFeeMint).toBe(feeOnBase ? p.info().tokenMint : WSOL);
  });

  test("failed transactions produce nothing", () => {
    const raw = fixture("dbc-buy-direct.json");
    raw.meta.err = { InstructionError: [2, { Custom: 6001 }] };
    const { p, tx } = dbcProviderFor(raw, 50);
    expect(p.parseTransaction(tx).swaps).toEqual([]);
  });

  test("load() validates owner and mint, derives beneficiary from chain state", async () => {
    const f = fixture("dbc-accounts.json");
    const chain = new FakeChain();
    for (const [addr, a] of Object.entries<any>(f.accounts)) chain.accounts.set(addr, { owner: a.owner, data: Buffer.from(a.data, "base64"), lamports: 1, executable: false });
    const p = new MeteoraDBCProvider(chain, { poolAddress: f.pool, tokenMint: f.baseMint, role: "creator" });
    const info = await p.load();
    expect(info.tokenMint).toBe(f.baseMint);
    expect(info.quoteMint).toBe(f.quoteMint);
    expect(info.accounts.config).toBe(f.config);
    expect(info.beneficiary).toBe(info.creator);
    expect(info.quoteDecimals).toBe(9);
    expect(typeof info.feeParams.creatorTradingFeePercentage).toBe("number");
    expect(["bonding", "migrating", "migrated"]).toContain(info.status);
    // the same pool's swap fixture decodes against the loaded state
    const tx = normalizeTransaction(fixture("dbc-buy-direct.json"));
    expect(p.parseTransaction(tx).swaps.length).toBe(1);
    // wrong mint is rejected
    const wrong = new MeteoraDBCProvider(chain, { poolAddress: f.pool, tokenMint: WSOL, role: "creator" });
    await expect(wrong.load()).rejects.toThrow(/does not match TOKEN_MINT/);
    // payout asset must equal quote mint
    const mismatch = new MeteoraDBCProvider(chain, { poolAddress: f.pool, tokenMint: f.baseMint, role: "creator", payoutMint: f.baseMint });
    await expect(mismatch.load()).rejects.toThrow(/never converts/);
  });

  test("claim instruction matches the program IDL account order", async () => {
    const f = fixture("dbc-accounts.json");
    const chain = new FakeChain();
    for (const [addr, a] of Object.entries<any>(f.accounts)) chain.accounts.set(addr, { owner: a.owner, data: Buffer.from(a.data, "base64"), lamports: 1, executable: false });
    const p = new MeteoraDBCProvider(chain, { poolAddress: f.pool, tokenMint: f.baseMint, role: "creator" });
    const info = await p.load();
    const creator = new PublicKey(info.creator);
    const dest = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    const plan = await p.buildClaimInstructions(creator, dest);
    const claim = plan.instructions.find((i) => i.programId.toBase58() === DBC_PROGRAM_ID)!;
    const idlAccounts = (dbcIdl as any).instructions.find((i: any) => i.name === "claim_creator_trading_fee").accounts;
    expect(claim.keys.length).toBe(idlAccounts.length);
    idlAccounts.forEach((a: any, i: number) => {
      expect(claim.keys[i]!.isWritable).toBe(!!a.writable);
      expect(claim.keys[i]!.isSigner).toBe(!!a.signer);
      if (a.address) expect(claim.keys[i]!.pubkey.toBase58()).toBe(a.address);
    });
    expect(claim.keys[8]!.pubkey.equals(creator)).toBe(true);
    expect(claim.data.subarray(0, 8)).toEqual(Buffer.from((dbcIdl as any).instructions.find((i: any) => i.name === "claim_creator_trading_fee").discriminator));
    // unwrap WSOL into the destination when quote is SOL
    if (info.quoteMint === WSOL) expect(plan.instructions.at(-1)!.keys[1]!.pubkey.equals(dest)).toBe(true);
    // refuses to build for a non-beneficiary signer
    await expect(p.buildClaimInstructions(dest, dest)).rejects.toThrow(/not the pool's creator/);
  });
});

describe("Raydium LaunchLab adapter", () => {
  test("account decoders agree with the official Raydium SDK layouts on real data", () => {
    const f = fixture("launchlab-accounts.json");
    const poolData = Buffer.from(f.accounts[f.pool].data, "base64");
    const mine = decodeLaunchLabPool(poolData);
    const sdk: any = LaunchpadPool.decode(poolData);
    expect(mine.creator).toBe(sdk.creator.toBase58());
    expect(mine.baseMint).toBe(sdk.mintA.toBase58());
    expect(mine.quoteMint).toBe(sdk.mintB.toBase58());
    expect(mine.baseVault).toBe(sdk.vaultA.toBase58());
    expect(mine.quoteVault).toBe(sdk.vaultB.toBase58());
    expect(mine.platformConfig).toBe(sdk.platformId.toBase58());
    expect(mine.globalConfig).toBe(sdk.configId.toBase58());
    expect(mine.status).toBe(sdk.status);
    expect(mine.baseDecimals).toBe(sdk.mintDecimalsA);
    expect(mine.quoteDecimals).toBe(sdk.mintDecimalsB);
    expect(mine.platformFeeAccrued.toString()).toBe(sdk.platformFee.toString());
    const platData = Buffer.from(f.accounts[f.platformConfig].data, "base64");
    const pm = decodeLaunchLabPlatformConfig(platData);
    const ps: any = PlatformConfig.decode(platData);
    expect(pm.platformFeeWallet).toBe(ps.platformClaimFeeWallet.toBase58());
    expect(pm.feeRate.toString()).toBe(ps.feeRate.toString());
    expect(pm.creatorFeeRate.toString()).toBe(ps.creatorFeeRate.toString());
  });

  async function loadedProvider(role: "creator" | "platform" = "creator") {
    const f = fixture("launchlab-accounts.json");
    const chain = new FakeChain();
    for (const [addr, a] of Object.entries<any>(f.accounts)) chain.accounts.set(addr, { owner: a.owner, data: Buffer.from(a.data, "base64"), lamports: 1, executable: false });
    const p = new RaydiumLaunchLabProvider(chain, { poolAddress: f.pool, tokenMint: f.baseMint, role });
    return { p, info: await p.load(), f };
  }

  test("buy: creator fee equals the creator-vault inflow, amounts match the event", async () => {
    const { p, info } = await loadedProvider();
    const tx = normalizeTransaction(fixture("launchlab-buy-creatorfee.json"));
    const parsed = p.parseTransaction(tx);
    expect(parsed.anomalies).toEqual([]);
    expect(parsed.swaps.length).toBe(1);
    const s = parsed.swaps[0]!;
    const ev = llDecoder.decodeAll(tx).find((e) => e.name === "TradeEvent")!;
    const d: any = ev.data;
    expect(s.side).toBe("buy");
    expect(s.quoteAmount).toBe(toBig(d.amount_in));
    expect(s.baseAmount).toBe(toBig(d.amount_out));
    expect(s.trader).toBe(ev.parent!.accounts[0]!);
    expect(tx.signers.has(s.trader)).toBe(true);
    expect(s.eligibleFee).toBe(toBig(d.creator_fee));
    expect(s.eligibleFee).toBeGreaterThan(0n);
    // independent: the creator fee vault received exactly the attributed amount
    expect(tokenAccountDelta(tx, info.accounts.creatorFeeVault!)).toBe(s.eligibleFee);
    // and reserves grew by amount_in minus all fees
    expect(toBig(d.real_quote_after) - toBig(d.real_quote_before)).toBe(s.quoteAmount - s.totalFee);
  });

  test("platform role attributes the platform fee (equals platform-vault inflow)", async () => {
    const { p, info } = await loadedProvider("platform");
    const tx = normalizeTransaction(fixture("launchlab-buy-creatorfee.json"));
    const s = p.parseTransaction(tx).swaps[0]!;
    expect(tokenAccountDelta(tx, info.accounts.platformFeeVault!)).toBe(s.eligibleFee);
  });

  test("sell: quote is the net amount received", () => {
    const raw = fixture("launchlab-sell.json");
    const tx = normalizeTransaction(raw);
    const ev = llDecoder.decodeAll(tx).find((e) => e.name === "TradeEvent")!;
    const d: any = ev.data;
    const parent = ev.parent!;
    const p = new RaydiumLaunchLabProvider(null, { poolAddress: toAddr(d.pool_state), tokenMint: parent.accounts[9]!, role: "creator" });
    p.hydrate(
      { status: 0, baseDecimals: 6, quoteDecimals: 9, platformFeeAccrued: 0n, globalConfig: parent.accounts[2]!, platformConfig: parent.accounts[3]!, baseMint: parent.accounts[9]!, quoteMint: parent.accounts[10]!, baseVault: parent.accounts[7]!, quoteVault: parent.accounts[8]!, creator: "11111111111111111111111111111111" },
      { platformFeeWallet: "11111111111111111111111111111111", feeRate: 0n, creatorFeeRate: 0n },
      { baseTokenProgram: SPL, quoteTokenProgram: SPL },
    );
    const s = p.parseTransaction(tx).swaps[0]!;
    expect(s.side).toBe("sell");
    expect(s.quoteAmount).toBe(toBig(d.amount_out));
    expect(s.baseAmount).toBe(toBig(d.amount_in));
  });

  test("claim_creator_fee is detected with the vault outflow as amount", () => {
    const tx = normalizeTransaction(fixture("launchlab-claim-creator.json"));
    const ix = tx.instructions.find((i) => i.programId === LAUNCHLAB_PROGRAM_ID)!;
    const creator = ix.accounts[0]!;
    const quoteMint = ix.accounts[4]!;
    const p = new RaydiumLaunchLabProvider(null, { poolAddress: "11111111111111111111111111111111", tokenMint: "11111111111111111111111111111111", role: "creator" });
    p.hydrate(
      { status: 0, baseDecimals: 6, quoteDecimals: 9, platformFeeAccrued: 0n, globalConfig: creator, platformConfig: creator, baseMint: "11111111111111111111111111111111", quoteMint, baseVault: creator, quoteVault: creator, creator },
      { platformFeeWallet: creator, feeRate: 0n, creatorFeeRate: 0n },
      { baseTokenProgram: SPL, quoteTokenProgram: SPL },
    );
    expect(p.info().accounts.creatorFeeVault).toBe(ix.accounts[2]!); // our PDA derivation matches the real vault
    const parsed = p.parseTransaction(tx);
    expect(parsed.claims.length).toBe(1);
    expect(parsed.claims[0]!.quoteAmount).toBe(-tokenAccountDelta(tx, ix.accounts[2]!));
    expect(parsed.claims[0]!.claimer).toBe(creator);
  });

  test("claim instruction is byte-identical to the Raydium SDK builder", async () => {
    const { p, info } = await loadedProvider();
    const creator = new PublicKey(info.creator);
    const dest = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    const plan = await p.buildClaimInstructions(creator, dest);
    const mine = plan.instructions.find((i) => i.programId.toBase58() === LAUNCHLAB_PROGRAM_ID)!;
    const quoteMint = new PublicKey(info.quoteMint);
    const quoteProgram = new PublicKey(info.quoteTokenProgram);
    const programId = new PublicKey(LAUNCHLAB_PROGRAM_ID);
    const sdk = sdkClaimCreatorFee(
      programId,
      creator,
      getPdaCreatorFeeVaultAuth(programId).publicKey,
      getPdaCreatorVault(programId, creator, quoteMint).publicKey,
      getAssociatedTokenAddressSync(quoteMint, creator, true, quoteProgram),
      quoteMint,
      quoteProgram,
    );
    expect(CREATOR_FEE_VAULT_AUTH.toBase58()).toBe(getPdaCreatorFeeVaultAuth(programId).publicKey.toBase58());
    expect(creatorFeeVault(creator, quoteMint).toBase58()).toBe(getPdaCreatorVault(programId, creator, quoteMint).publicKey.toBase58());
    expect(mine.data.equals(sdk.data)).toBe(true);
    expect(mine.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(sdk.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  });
});
