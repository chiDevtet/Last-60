/**
 * Dedicated Last-60 payout wallet: configuration, the narrowly scoped payout signer, fail-closed key
 * validation and secret hygiene. Every key here is a throwaway generated per test — never a real key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Writable } from "node:stream";
import pino from "pino";
import bs58 from "bs58";
import { Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ConfigError, loadConfig, redactConfig } from "../src/config/env";
import { assertAuthorizedPayoutTx, PayoutSigner, type PayoutAuthorization } from "../src/signer/payoutSigner";
import { buildUnsignedPayoutTransaction, MEMO_PROGRAM_ID } from "../src/chain/payoutTx";
import { authorizePayout, PayoutExecutor } from "../src/rewards/payouts";
import { payoutWalletVerification } from "../src/custody/report";
import { TerminalWriter } from "../src/terminal/terminal";
import { LOG_REDACT_PATHS } from "../src/util/logger";
import { dec } from "../src/db/decimal";
import { WSOL_MINT } from "../src/accounting/revenueStreams";
import { rig, startDb, stopDb, wallet } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const base = { SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: "https://api.devnet.solana.com", MONGODB_URI: "mongodb://localhost/x", TOKEN_MINT: "So11111111111111111111111111111111111111112", POOL_ADDRESS: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", SCHEDULE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), REWARD_FUNDING_POLICY: "legacy_creator_fee_v1" };
const secretOf = (kp: Keypair) => bs58.encode(kp.secretKey);
/** Every textual form of a secret key that must never appear anywhere. */
const forms = (kp: Keypair) => [secretOf(kp), JSON.stringify([...kp.secretKey]), Buffer.from(kp.secretKey).toString("base64"), Buffer.from(kp.secretKey).toString("hex"), secretOf(kp).slice(0, 24)];
const noLeak = (text: string, kp: Keypair) => {
  for (const f of forms(kp)) expect(text.includes(f)).toBe(false);
};
const problems = (env: Record<string, string>, role: "rewards" | "api" | "test" = "rewards") => {
  try {
    loadConfig(role, { ...base, ...env });
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
};

describe("configuration", () => {
  test("LAST60_PAYOUT_WALLET_* are the canonical names; legacy PAYOUT_WALLET_* are aliases; conflicting values are refused without echoing them", () => {
    const kp = Keypair.generate();
    const c = loadConfig("rewards", { ...base, LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp) });
    expect(c.payout.walletPublicKey).toBe(kp.publicKey.toBase58());
    expect(c.revenue.custody).toMatchObject({ enabled: false, payoutWallet: kp.publicKey.toBase58() });
    expect(c.revenue.recoveryEnabled).toBe(false); // safe defaults: both new workflows disabled
    const legacy = loadConfig("rewards", { ...base, PAYOUT_WALLET_PUBLIC_KEY: kp.publicKey.toBase58(), PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp) });
    expect(legacy.payout.walletPublicKey).toBe(kp.publicKey.toBase58());
    const other = Keypair.generate();
    const p = problems({ LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp), PAYOUT_WALLET_PRIVATE_KEY: secretOf(other) });
    expect(p.join("\n")).toContain("legacy name PAYOUT_WALLET_PRIVATE_KEY with a different value");
    noLeak(p.join("\n"), kp);
    noLeak(p.join("\n"), other);
  });

  test("startup validation: a valid key matching the address loads", () => {
    const kp = Keypair.generate();
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp), PAYOUT_MODE: "live" })).toEqual([]);
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: JSON.stringify([...kp.secretKey]) })).toEqual([]); // solana-keygen JSON format
  });

  test("startup validation fails closed: missing key (live), malformed key, mismatching key, key without address — never echoing the key", () => {
    const kp = Keypair.generate();
    const other = Keypair.generate();
    expect(problems({ LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), PAYOUT_MODE: "live" }).join("\n")).toContain("LAST60_PAYOUT_WALLET_PRIVATE_KEY or LAST60_PAYOUT_WALLET_KEYPAIR_PATH: required when PAYOUT_MODE=live");
    const bad = secretOf(kp).slice(0, 40) + "0OIl"; // non-base58 characters, truncated
    const m = problems({ LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: bad }).join("\n");
    expect(m).toContain("malformed");
    expect(m.includes(bad)).toBe(false);
    expect(m.includes(bad.slice(0, 20))).toBe(false);
    const j = problems({ LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: `[${[...kp.secretKey].join(",")},` }).join("\n"); // broken JSON (parser errors can quote input)
    expect(j).toContain("malformed");
    noLeak(j, kp);
    const mm = problems({ LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(other) }).join("\n");
    expect(mm).toContain("derives a public key different from LAST60_PAYOUT_WALLET_ADDRESS");
    noLeak(mm, other);
    // A key without its address is still refused (by the signer's own check)…
    expect(problems({ LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp) }).join("\n")).toContain("LAST60_PAYOUT_WALLET_ADDRESS is not; refusing to load it");
    // …but no payout wallet at all is not an error: it is generated from the admin console (payouts stay queued until then).
    expect(problems({})).toEqual([]);
  });

  test("custody requires the dedicated address; the payout wallet joins the funding destinations once under forge_phase_aware_v2; it may not be Forge's wallet", () => {
    const kp = Keypair.generate();
    const forge = wallet();
    const dest = wallet();
    expect(problems({ LAST60_CUSTODY_ENABLED: "true" }, "api").join("\n")).toContain("LAST60_CUSTODY_ENABLED: requires LAST60_PAYOUT_WALLET_ADDRESS");
    const v2 = { REWARD_FUNDING_POLICY: "forge_phase_aware_v2", REWARD_FUNDING_POLICY_ACTIVATION_SLOT: "5", FORGE_PLATFORM_LP_BENEFICIARY: forge };
    const c = loadConfig("api", { ...base, ...v2, LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_FUNDING_DESTINATIONS: `${dest},${kp.publicKey.toBase58()}` });
    expect(c.revenue.fundingDestinations).toEqual([dest, kp.publicKey.toBase58()]); // deduplicated
    expect(loadConfig("api", { ...base, ...v2, LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58() }).revenue.fundingDestinations).toEqual([kp.publicKey.toBase58()]);
    expect(problems({ ...v2, LAST60_PAYOUT_WALLET_ADDRESS: forge }, "api").join("\n")).toContain("must be a dedicated wallet");
  });

  test("the payout key never signs fee claims: auto_claim needs FEE_CLAIM_AUTHORITY_*", () => {
    const kp = Keypair.generate();
    const p = problems({ LAUNCH_PROVIDER: "raydium_launchlab", FEE_COLLECTION_MODE: "auto_claim", LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp) });
    expect(p.join("\n")).toContain("the payout wallet key never signs fee claims");
  });

  test("redacted configuration and logs never contain the key", () => {
    const kp = Keypair.generate();
    const c = loadConfig("rewards", { ...base, LAST60_PAYOUT_WALLET_ADDRESS: kp.publicKey.toBase58(), LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp) });
    noLeak(JSON.stringify(redactConfig(c)), kp);
    let out = "";
    const sink = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } });
    const log = pino({ redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" } }, sink);
    log.info({ cfg: { secrets: c.secrets }, env: { LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp), PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp) }, secrets: c.secrets }, "boot");
    expect(out).toContain("[redacted]");
    noLeak(out, kp);
  });

  test("secrets can never be exposed through NEXT_PUBLIC_*", () => {
    const kp = Keypair.generate();
    expect(problems({ LAST60_PAYOUT_WALLET_PRIVATE_KEY: secretOf(kp), NEXT_PUBLIC_X: `x${secretOf(kp)}` }, "api").join("\n")).toContain("contains the value of a server secret");
  });
});

describe("frontend isolation", () => {
  test("no web source references a private key variable or the payout signer", () => {
    const root = join(import.meta.dir, "../../../apps/web");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        if (["node_modules", ".next", "public"].includes(f)) continue;
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(f)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      expect({ f, hit: /PRIVATE_KEY|KEYPAIR_PATH|PayoutSigner|secretKey|@last60\/engine/.test(t) }).toEqual({ f, hit: false });
    }
  });
});

describe("PayoutSigner", () => {
  test("loads a valid keypair matching the configured address; renders only the public address", () => {
    const kp = Keypair.generate();
    const { signer, status } = PayoutSigner.load({ privateKey: secretOf(kp) }, kp.publicKey.toBase58());
    expect(status).toMatchObject({ configured: true, derivedMatches: true, code: "ok", address: kp.publicKey.toBase58() });
    expect(signer!.address).toBe(kp.publicKey.toBase58());
    for (const text of [JSON.stringify(signer), String(signer), inspect(signer), inspect(signer, { showHidden: true, depth: 5 }), JSON.stringify(status), Object.keys(signer!).join(",")]) noLeak(text, kp);
  });

  test("missing, malformed, mismatching, ambiguous and unprotected keys never produce a signer", () => {
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();
    expect(PayoutSigner.load({}, addr)).toMatchObject({ signer: null, status: { code: "not_configured", configured: false } });
    expect(PayoutSigner.load({ privateKey: "not-a-key" }, addr)).toMatchObject({ signer: null, status: { code: "malformed_key" } });
    expect(PayoutSigner.load({ privateKey: bs58.encode(kp.secretKey.subarray(0, 32)) }, addr)).toMatchObject({ signer: null, status: { code: "malformed_key" } });
    const tampered = Uint8Array.from(kp.secretKey);
    tampered[40] = tampered[40]! ^ 0xff; // public half no longer matches the secret half
    expect(PayoutSigner.load({ privateKey: bs58.encode(tampered) }, addr)).toMatchObject({ signer: null, status: { code: "malformed_key" } });
    expect(PayoutSigner.load({ privateKey: secretOf(Keypair.generate()) }, addr)).toMatchObject({ signer: null, status: { code: "address_mismatch", derivedMatches: false } });
    expect(PayoutSigner.load({ privateKey: secretOf(kp) }, null)).toMatchObject({ signer: null, status: { code: "address_missing" } });
    const dir = mkdtempSync(join(tmpdir(), "last60-key-"));
    const file = join(dir, "payout.json");
    writeFileSync(file, JSON.stringify([...kp.secretKey]));
    chmodSync(file, 0o644);
    expect(PayoutSigner.load({ keypairPath: file }, addr)).toMatchObject({ signer: null, status: { code: "insecure_key_file" } });
    chmodSync(file, 0o600);
    expect(PayoutSigner.load({ keypairPath: file }, addr).status.code).toBe("ok");
    expect(PayoutSigner.load({ keypairPath: file, privateKey: secretOf(kp) }, addr)).toMatchObject({ signer: null, status: { code: "ambiguous_key_sources" } });
    expect(PayoutSigner.load({ keypairPath: join(dir, "missing.json") }, addr)).toMatchObject({ signer: null, status: { code: "key_file_unreadable" } });
    expect(() => PayoutSigner.loadOrThrow({ privateKey: secretOf(Keypair.generate()) }, addr)).toThrow(/derives a public key different/);
  });

  test("signs only a transaction matching its authorization exactly", () => {
    const kp = Keypair.generate();
    const signer = PayoutSigner.fromKeypair(kp, kp.publicKey.toBase58());
    const recipient = wallet();
    const auth: PayoutAuthorization = Object.freeze({ kind: "reward_payout", payoutId: "p1", roundNumber: 1, recipient, amount: 5_000_000n, mint: WSOL_MINT, tokenProgram: null, lockToken: "t" });
    const build = (o: Partial<{ recipient: string; amount: bigint }> = {}) => buildUnsignedPayoutTransaction({ payer: kp.publicKey, recipient: o.recipient ?? recipient, amount: o.amount ?? 5_000_000n, mint: WSOL_MINT, blockhash: Keypair.generate().publicKey.toBase58(), priorityFeeMicroLamports: 10_000, computeUnitLimit: 40_000, memo: "last60:r1:p1" });
    const ok = signer.signPayout(build(), auth);
    expect(ok.signature.length).toBeGreaterThan(60);
    expect(() => signer.signPayout(build({ recipient: wallet() }), auth)).toThrow(/recipient differs/);
    expect(() => signer.signPayout(build({ amount: 5_000_001n }), auth)).toThrow(/amount differs/);
    const extra = build();
    extra.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    expect(() => assertAuthorizedPayoutTx(extra, kp.publicKey, auth)).toThrow(/recipient differs/); // an extra transfer to an arbitrary recipient is refused
    const twice = build();
    twice.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new (kp.publicKey.constructor as any)(recipient), lamports: 5_000_000 }));
    expect(() => assertAuthorizedPayoutTx(twice, kp.publicKey, auth)).toThrow(/exactly one transfer, found 2/);
    const assign = build();
    assign.add(SystemProgram.assign({ accountPubkey: kp.publicKey, programId: MEMO_PROGRAM_ID }));
    expect(() => assertAuthorizedPayoutTx(assign, kp.publicKey, auth)).toThrow(/only a System transfer/);
    const foreign = build();
    foreign.add(new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) }));
    expect(() => assertAuthorizedPayoutTx(foreign, kp.publicKey, auth)).toThrow(/is not allowed in a payout/);
    const otherPayer = new Transaction({ feePayer: Keypair.generate().publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(...build().instructions);
    expect(() => assertAuthorizedPayoutTx(otherPayer, kp.publicKey, auth)).toThrow(/fee payer/);
    expect(() => signer.signPayout(build(), { ...auth, recipient: kp.publicKey.toBase58() })).toThrow(/payout wallet itself/);
  });

  test("SPL payouts: only the authorized idempotent ATA create + TransferChecked", () => {
    const kp = Keypair.generate();
    const signer = PayoutSigner.fromKeypair(kp);
    const mint = Keypair.generate().publicKey.toBase58();
    const program = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const recipient = wallet();
    const tx = () => buildUnsignedPayoutTransaction({ payer: kp.publicKey, recipient, amount: 777n, mint, blockhash: Keypair.generate().publicKey.toBase58(), priorityFeeMicroLamports: 0, computeUnitLimit: 40_000, token: { program, decimals: 6 } });
    const auth: PayoutAuthorization = { kind: "reward_payout", payoutId: "p", roundNumber: 1, recipient, amount: 777n, mint, tokenProgram: program, lockToken: "t" };
    expect(signer.signPayout(tx(), auth).signature).toBeTruthy();
    expect(() => signer.signPayout(tx(), { ...auth, amount: 778n })).toThrow(/amount differs/);
    expect(() => signer.signPayout(tx(), { ...auth, mint: Keypair.generate().publicKey.toBase58() })).toThrow();
  });
});

describe("payouts fail closed without a valid signer", () => {
  test("authorization requires the payout row claimed by this worker", async () => {
    const r = await rig();
    const p = await r.db.Payout.create({ roundNumber: 1, recipient: wallet(), position: 0, amount: dec(5_000_000n), mint: WSOL_MINT, mode: "live", state: "signing", lock: { owner: "x", token: "mine", expiresAt: new Date(Date.now() + 60_000) } });
    await expect(authorizePayout(r.db, p._id, "not-mine", null)).rejects.toThrow(/not claimed by this worker/);
    const a = await authorizePayout(r.db, p._id, "mine", null);
    expect(a).toMatchObject({ kind: "reward_payout", recipient: p.recipient, amount: 5_000_000n, mint: WSOL_MINT });
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("no signer → live payouts stay queued (never signed from any other wallet)", async () => {
    const r = await rig();
    const ex = new PayoutExecutor({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, signer: null, terminal: new TerminalWriter(r.db, 1), clock: r.clock });
    await r.db.Payout.create({ roundNumber: 1, recipient: wallet(), position: 0, amount: dec(5_000_000n), mint: WSOL_MINT, mode: "live", state: "pending" });
    await ex.processDue();
    const row: any = await r.db.Payout.findOne({}).lean();
    expect(row.state).toBe("pending");
    expect(row.lastError).toContain("no validated payout signer");
    expect(r.chain.transfers.length).toBe(0);
  });

  test("a signer for a different wallet than LAST60_PAYOUT_WALLET_ADDRESS is refused", async () => {
    const r = await rig();
    const ex = new PayoutExecutor({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, signer: PayoutSigner.fromKeypair(Keypair.generate()), terminal: new TerminalWriter(r.db, 1), clock: r.clock });
    await r.db.Payout.create({ roundNumber: 1, recipient: wallet(), position: 0, amount: dec(5_000_000n), mint: WSOL_MINT, mode: "live", state: "pending" });
    await ex.processDue();
    const row: any = await r.db.Payout.findOne({}).lean();
    expect(row.state).toBe("pending");
    expect(row.lastError).toContain("is not the configured LAST60_PAYOUT_WALLET_ADDRESS");
    expect(r.chain.transfers.length).toBe(0);
  });

  test("wallet verification: reports address, signer status, derived match and balance — and disabled payouts when the signer is invalid — never a key", async () => {
    const r = await rig();
    await r.worker.publishSignerStatus();
    const v = await payoutWalletVerification(r.db, { address: r.payer.publicKey.toBase58(), runtimeExpectedAddress: r.payer.publicKey.toBase58(), rpc: r.chain, payoutMode: "live" });
    expect(v).toMatchObject({ address: r.payer.publicKey.toBase58(), signerMatchesAddress: true, payoutsEnabled: true, signer: { configured: true, derivedMatches: true, code: "ok" } });
    expect(BigInt(v.balanceLamports!)).toBeGreaterThan(0n);
    noLeak(JSON.stringify(v), r.payer);
    // An invalid key published by a worker: payouts are reported disabled with the sanitized reason.
    const bad = PayoutSigner.load({ privateKey: secretOf(Keypair.generate()) }, r.payer.publicKey.toBase58()).status;
    await r.db.SystemState.updateOne({ _id: "payout_signer_status" }, { $set: { value: bad } });
    const v2 = await payoutWalletVerification(r.db, { address: r.payer.publicKey.toBase58(), rpc: r.chain, payoutMode: "live" });
    expect(v2).toMatchObject({ payoutsEnabled: false, signerMatchesAddress: false, signer: { configured: false, code: "address_mismatch" } });
    expect(v2.payoutsBlockedReason).toContain("derives a public key different");
    const v3 = await payoutWalletVerification(r.db, { address: null, rpc: r.chain, payoutMode: "live" });
    expect(v3).toMatchObject({ payoutsEnabled: false, payoutsBlockedReason: "LAST60_PAYOUT_WALLET_ADDRESS is not configured" });
  });
});
