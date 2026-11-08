/**
 * Dedicated Last-60 payout signer (docs/PAYOUT_WALLET.md).
 *
 * The ONLY component that holds the payout wallet's private key. Responsibilities are deliberately
 * narrow:
 *   - load the key once (rewards process only), validate it, and derive its public key;
 *   - refuse to exist when the key is missing, malformed, or derives an address different from the
 *     configured `LAST60_PAYOUT_WALLET_ADDRESS` (fail closed — never fall back to another wallet);
 *   - sign a reward-payout transaction ONLY when it matches an explicit, fenced `PayoutAuthorization`
 *     instruction for instruction: one transfer, from the payout wallet, to the authorized recipient,
 *     of exactly the authorized amount and mint (plus compute budget, an idempotent ATA create for the
 *     recipient and an optional memo). Anything else is refused.
 *
 * It never chooses recipients or amounts, never changes allocations, attribution, eligibility or
 * custody records, and never signs fee claims, sweeps or arbitrary transfers. Key material lives in a
 * JS private field; `toJSON` / `inspect` / `toString` render the public address only, and every error
 * message is a fixed, sanitized string (a parser error can quote its input — we never surface those).
 *
 * Supported key encodings (the formats @solana/web3.js `Keypair.fromSecretKey` accepts):
 *   - base58 of the 64-byte secret key (Phantom / Solflare "export private key");
 *   - a JSON array of 64 integers (the Solana CLI `solana-keygen` keypair file format);
 *   - a path to such a keypair file (`LAST60_PAYOUT_WALLET_KEYPAIR_PATH`, must be chmod 600).
 */
import { readFileSync, statSync } from "node:fs";
import { inspect } from "node:util";
import bs58 from "bs58";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WSOL_MINT } from "@last60/shared";
import { assertValidRecipient, MEMO_PROGRAM_ID } from "../chain/payoutTx";

export type SignerStatusCode =
  | "ok"
  | "not_configured" // no private key in this process (dry-run deployments, API, CLI)
  | "address_missing" // a key is present but LAST60_PAYOUT_WALLET_ADDRESS is not set
  | "malformed_key" // not a valid base58 / JSON 64-byte secret key
  | "address_mismatch" // the key derives a different public address
  | "ambiguous_key_sources" // both an inline key and a keypair file are configured
  | "insecure_key_file" // keypair file readable by group/others
  | "key_file_unreadable";

export interface PayoutSignerStatus {
  /** A valid key matching the configured address is loaded. */
  configured: boolean;
  /** The configured payout wallet address (public). */
  address: string | null;
  /** Whether the key's derived public key equals the configured address (null: no key to check). */
  derivedMatches: boolean | null;
  code: SignerStatusCode;
  /** Fixed, sanitized explanation (never contains key material). */
  message: string;
  checkedAt: string;
}

const MESSAGES: Record<SignerStatusCode, string> = {
  ok: "payout signer loaded; its derived public key matches LAST60_PAYOUT_WALLET_ADDRESS",
  not_configured: "no payout signing key is configured in this process; live payouts cannot be signed",
  address_missing: "a payout signing key is configured but LAST60_PAYOUT_WALLET_ADDRESS is not; refusing to load it",
  malformed_key: "LAST60_PAYOUT_WALLET_PRIVATE_KEY is malformed: expected a base58-encoded 64-byte secret key or a JSON array of 64 bytes",
  address_mismatch: "the payout signing key derives a public key different from LAST60_PAYOUT_WALLET_ADDRESS; refusing to load it",
  ambiguous_key_sources: "both an inline payout key and a keypair file are configured; set exactly one",
  insecure_key_file: "the payout keypair file is readable by group/others; run chmod 600",
  key_file_unreadable: "the payout keypair file cannot be read",
};

export class PayoutSignerError extends Error {
  constructor(readonly code: SignerStatusCode) {
    super(MESSAGES[code]);
    this.name = "PayoutSignerError";
  }
}

/** Parse a secret key WITHOUT ever echoing its content in an error. */
function parseSecretKeySanitized(value: string): Keypair {
  try {
    const v = value.trim();
    let bytes: Uint8Array;
    if (v.startsWith("[")) {
      const arr = JSON.parse(v);
      if (!Array.isArray(arr) || arr.length !== 64 || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("x");
      bytes = Uint8Array.from(arr);
    } else {
      bytes = bs58.decode(v);
      if (bytes.length !== 64) throw new Error("x");
    }
    return Keypair.fromSecretKey(bytes); // validates that the public half matches the secret half
  } catch {
    throw new PayoutSignerError("malformed_key");
  }
}

export interface PayoutKeySources {
  privateKey?: string;
  keypairPath?: string;
}

/** What a reward payout is allowed to be: derived from a claimed payout row, never from a request. */
export interface PayoutAuthorization {
  readonly kind: "reward_payout";
  readonly payoutId: string;
  readonly roundNumber: number;
  readonly recipient: string;
  readonly amount: bigint;
  readonly mint: string;
  /** Token program of an SPL payout (null for SOL). */
  readonly tokenProgram: string | null;
  /** Fencing token of the claimed (state `signing`) payout row. */
  readonly lockToken: string;
}

const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const SYSTEM = SystemProgram.programId.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
const MEMO = MEMO_PROGRAM_ID.toBase58();

/**
 * Pure: the transaction does exactly what the authorization allows, nothing else. Throws with a
 * fixed reason otherwise. Exported for tests and for defence-in-depth checks by callers.
 */
export function assertAuthorizedPayoutTx(tx: Transaction, payer: PublicKey, auth: PayoutAuthorization): void {
  const fail = (why: string): never => {
    throw new Error(`payout signer refused: ${why}`);
  };
  if (auth.kind !== "reward_payout") fail("unknown authorization kind");
  if (auth.amount <= 0n) fail("non-positive amount");
  if (!tx.feePayer || !tx.feePayer.equals(payer)) fail("fee payer is not the payout wallet");
  const recipient = assertValidRecipient(auth.recipient, payer.toBase58());
  let transfers = 0;
  const ix = tx.instructions as TransactionInstruction[];
  for (const i of ix) {
    const program = i.programId.toBase58();
    if (program === COMPUTE_BUDGET || program === MEMO) continue;
    if (program === SYSTEM) {
      if (auth.mint !== WSOL_MINT) fail("system instruction in an SPL payout");
      // System Program `Transfer`: u32 tag 2, u64 lamports; keys [from (signer), to].
      if (i.data.length !== 12 || i.data.readUInt32LE(0) !== 2 || i.keys.length !== 2) fail("only a System transfer is allowed");
      if (!i.keys[0]!.pubkey.equals(payer)) fail("transfer source is not the payout wallet");
      if (!i.keys[1]!.pubkey.equals(recipient)) fail("transfer recipient differs from the authorization");
      if (i.data.readBigUInt64LE(4) !== auth.amount) fail("transfer amount differs from the authorization");
      transfers++;
      continue;
    }
    if (program === ATA) {
      if (auth.mint === WSOL_MINT || !auth.tokenProgram) fail("ATA instruction in a SOL payout");
      // createAssociatedTokenAccountIdempotent(payer, ata(recipient), recipient, mint, program): data [1]
      const keys = i.keys.map((k) => k.pubkey.toBase58());
      const expectedAta = getAssociatedTokenAddressSync(new PublicKey(auth.mint), recipient, false, new PublicKey(auth.tokenProgram!)).toBase58();
      if (i.data.length !== 1 || i.data[0] !== 1 || keys[0] !== payer.toBase58() || keys[1] !== expectedAta || keys[2] !== recipient.toBase58() || keys[3] !== auth.mint) fail("unexpected associated token account instruction");
      continue;
    }
    if (TOKEN_PROGRAMS.has(program)) {
      if (auth.mint === WSOL_MINT || !auth.tokenProgram || program !== auth.tokenProgram) fail("token instruction does not match the authorized mint program");
      // TransferChecked: tag 12, u64 amount, u8 decimals; keys [source, mint, destination, authority]
      if (i.data.length !== 10 || i.data[0] !== 12) fail("only TransferChecked is allowed");
      const keys = i.keys.map((k) => k.pubkey.toBase58());
      const mint = new PublicKey(auth.mint);
      const program_ = new PublicKey(auth.tokenProgram!);
      const fromAta = getAssociatedTokenAddressSync(mint, payer, false, program_).toBase58();
      const toAta = getAssociatedTokenAddressSync(mint, recipient, false, program_).toBase58();
      if (keys[0] !== fromAta || keys[1] !== auth.mint || keys[2] !== toAta || keys[3] !== payer.toBase58()) fail("token transfer accounts differ from the authorization");
      if (i.data.readBigUInt64LE(1) !== auth.amount) fail("token transfer amount differs from the authorization");
      transfers++;
      continue;
    }
    fail(`program ${program} is not allowed in a payout`);
  }
  if (transfers !== 1) fail(`expected exactly one transfer, found ${transfers}`);
}

export class PayoutSigner {
  readonly #kp: Keypair;
  readonly address: string;

  private constructor(kp: Keypair) {
    this.#kp = kp;
    this.address = kp.publicKey.toBase58();
    Object.freeze(this);
  }

  /**
   * Load and validate the key (fail closed). Returns the signer (or null when no key is configured)
   * and a sanitized status that is safe to log, persist and show to operators.
   */
  static load(src: PayoutKeySources, configuredAddress: string | null, now = new Date()): { signer: PayoutSigner | null; status: PayoutSignerStatus } {
    const status = (code: SignerStatusCode, derivedMatches: boolean | null): PayoutSignerStatus => ({ configured: code === "ok", address: configuredAddress, derivedMatches, code, message: MESSAGES[code], checkedAt: now.toISOString() });
    const inline = src.privateKey?.trim() ? src.privateKey : undefined;
    const path = src.keypairPath?.trim() ? src.keypairPath : undefined;
    if (!inline && !path) return { signer: null, status: status("not_configured", null) };
    if (inline && path) return { signer: null, status: status("ambiguous_key_sources", null) };
    if (!configuredAddress) return { signer: null, status: status("address_missing", null) };
    let kp: Keypair;
    try {
      if (path) {
        let content: string;
        try {
          const st = statSync(path);
          if (process.platform !== "win32" && (st.mode & 0o077) !== 0) return { signer: null, status: status("insecure_key_file", null) };
          content = readFileSync(path, "utf8");
        } catch {
          return { signer: null, status: status("key_file_unreadable", null) };
        }
        kp = parseSecretKeySanitized(content);
      } else {
        kp = parseSecretKeySanitized(inline!);
      }
    } catch (e) {
      return { signer: null, status: status(e instanceof PayoutSignerError ? e.code : "malformed_key", null) };
    }
    if (kp.publicKey.toBase58() !== configuredAddress) return { signer: null, status: status("address_mismatch", false) };
    return { signer: new PayoutSigner(kp), status: status("ok", true) };
  }

  /** Like `load`, but throws a sanitized `PayoutSignerError` unless a valid key was loaded or none is configured. */
  static loadOrThrow(src: PayoutKeySources, configuredAddress: string | null): { signer: PayoutSigner | null; status: PayoutSignerStatus } {
    const r = PayoutSigner.load(src, configuredAddress);
    if (r.status.code !== "ok" && r.status.code !== "not_configured") throw new PayoutSignerError(r.status.code);
    return r;
  }

  /** Wrap an in-memory keypair (tests and embedded runtimes); validates against `expected` when given. */
  static fromKeypair(kp: Keypair, expected?: string | null): PayoutSigner {
    if (expected && kp.publicKey.toBase58() !== expected) throw new PayoutSignerError("address_mismatch");
    return new PayoutSigner(kp);
  }

  get publicKey(): PublicKey {
    return this.#kp.publicKey;
  }

  /** Validate the transaction against the authorization, then sign it. */
  signPayout(tx: Transaction, auth: PayoutAuthorization): { signature: string; serialized: string } {
    assertAuthorizedPayoutTx(tx, this.#kp.publicKey, auth);
    tx.sign(this.#kp);
    return { signature: bs58.encode(tx.signature!), serialized: tx.serialize().toString("base64") };
  }

  toJSON() {
    return { address: this.address };
  }
  toString() {
    return `PayoutSigner(${this.address})`;
  }
  [inspect.custom]() {
    return this.toString();
  }
}
