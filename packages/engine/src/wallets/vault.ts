/**
 * Wallet vault (docs/WALLETS.md): payout and creator wallets generated from the admin console.
 *
 *   - The API only records a REQUEST (`wallet_vault` row, status `requested`). It never sees key material.
 *   - The rewards worker — the only process with the vault key — generates the key pair, encrypts the
 *     64-byte secret key with AES-256-GCM (AAD binds role and address) and compare-and-sets the row to
 *     `active`. The vault key is never in the database: by default it is a file created on first use
 *     (chmod 600, directory 700, outside the repository); LAST60_WALLET_VAULT_KEY overrides it. A database
 *     dump alone therefore reveals no key; the key file alone reveals nothing either.
 *   - Every process reads the active wallets' ADDRESSES at boot (`readVaultWallets` → `loadConfig`), and
 *     restarts itself when they change (`watchVaultWallets`), so a newly generated wallet is picked up
 *     through the normal, fully validated startup path (PM2 restarts the process).
 *   - The rewards worker decrypts a wallet's key at startup (`loadVaultKeypair`) and hands it to the same
 *     loaders as an environment key (payout signer, creator wallet automation).
 *   - Export (backup, or importing the creator wallet into a browser wallet to launch from it) is end-to-end
 *     encrypted to the requesting browser and must be signed by an admin wallet listed in the rewards
 *     worker's own ADMIN_WALLETS (`fulfilExportRequests`; @last60/shared walletExport).
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { EXPORT_MAX_TTL_MS, importPublicKey, keyFingerprint, openImport, parseExportIntentMessage, parseImportIntentMessage, sealExport, type SealedImport } from "@last60/shared";
import type { AppConfig, VaultAddresses } from "../config/env";
import type { Models } from "../db/models";
import { WALLET_ROLES } from "../db/models";
import { rootLogger, type Logger } from "../util/logger";

export type WalletRole = (typeof WALLET_ROLES)[number];
export const VAULT_ALG = "aes-256-gcm/v1";

export class VaultError extends Error {
  constructor(
    readonly code: "vault_key_missing" | "vault_key_insecure" | "vault_key_invalid" | "vault_key_mismatch" | "vault_entry_corrupt" | "vault_address_mismatch" | "wallet_configured_in_environment" | "wallet_exists" | "unknown_role" | "wallet_not_found" | "role_not_retirable" | "address_confirmation_mismatch" | "transfers_in_flight",
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

// ── vault key ────────────────────────────────────────────────────────────────────────────────

export const vaultKeyId = (key: Buffer) => createHmac("sha256", key).update("last60/wallet-vault/key-id/v1").digest("hex").slice(0, 16);

/**
 * The 32-byte vault key: LAST60_WALLET_VAULT_KEY (base64), else the key file. With `create`, a missing file
 * is created (32 random bytes, base64, mode 600 in a mode-700 directory, never overwritten).
 */
export function loadVaultKey(cfg: Pick<AppConfig, "wallets" | "secrets">, o: { create?: boolean } = {}): Buffer | null {
  if (cfg.secrets.walletVaultKey) {
    const k = Buffer.from(cfg.secrets.walletVaultKey, "base64");
    if (k.length !== 32) throw new VaultError("vault_key_invalid", "LAST60_WALLET_VAULT_KEY must be 32 bytes, base64-encoded");
    return k;
  }
  const path = cfg.wallets.vaultKeyPath;
  if (!existsSync(path)) {
    if (!o.create) return null;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err; // created concurrently: use it
    }
    chmodSync(path, 0o600);
  }
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) throw new VaultError("vault_key_insecure", `wallet vault key file ${path} is readable by group/others; run chmod 600`);
  const k = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (k.length !== 32) throw new VaultError("vault_key_invalid", `wallet vault key file ${path} does not hold a 32-byte base64 key`);
  return k;
}

const aad = (role: string, address: string) => Buffer.from(`last60/wallet-vault/v1|${role}|${address}`);

export function encryptSecretKey(key: Buffer, role: WalletRole, kp: Keypair): { alg: string; keyId: string; iv: string; ciphertext: string } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(role, kp.publicKey.toBase58()));
  const ct = Buffer.concat([c.update(Buffer.from(kp.secretKey)), c.final(), c.getAuthTag()]);
  return { alg: VAULT_ALG, keyId: vaultKeyId(key), iv: iv.toString("base64"), ciphertext: ct.toString("base64") };
}

export function decryptSecretKey(key: Buffer, row: { _id: string; address: string; keyId: string; iv: string; ciphertext: string }): Keypair {
  if (row.keyId !== vaultKeyId(key)) throw new VaultError("vault_key_mismatch", `the ${row._id} wallet was encrypted with another vault key (key id ${row.keyId}); restore the original vault key file`);
  let secret: Buffer;
  try {
    const all = Buffer.from(row.ciphertext, "base64");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
    d.setAAD(aad(row._id, row.address));
    d.setAuthTag(all.subarray(all.length - 16));
    secret = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
  } catch {
    throw new VaultError("vault_entry_corrupt", `the ${row._id} wallet entry cannot be decrypted (tampered or corrupt)`);
  }
  // fromSecretKey keeps a reference to its argument: give it a copy, then wipe the decrypted buffer.
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  secret.fill(0);
  if (kp.publicKey.toBase58() !== row.address) throw new VaultError("vault_address_mismatch", `the ${row._id} wallet key does not derive its recorded address`);
  return kp;
}

// ── requests (API) and generation (rewards worker) ───────────────────────────────────────────

/** API: ask the rewards worker to generate a wallet for `role`. Idempotent while pending; refuses to replace one. */
export async function requestWalletGeneration(db: Models, cfg: Pick<AppConfig, "wallets">, input: { role: string; actor: string; reason?: string | null; now?: number }) {
  if (!(WALLET_ROLES as readonly string[]).includes(input.role)) throw new VaultError("unknown_role", `unknown wallet role ${input.role}`);
  const role = input.role as WalletRole;
  if (cfg.wallets[role].source === "env") throw new VaultError("wallet_configured_in_environment", `the ${role} wallet is configured in the environment (${cfg.wallets[role].address ?? "key only"}); remove it there to generate one here`);
  const existing: any = await db.WalletVault.findById(role).lean();
  if (existing?.status === "active") throw new VaultError("wallet_exists", `a ${role} wallet already exists (${existing.address}); it is never replaced from the admin console`);
  if (existing?.status === "requested" && existing.origin === "imported") throw new VaultError("wallet_exists", `an import of the ${role} wallet is pending`);
  if (existing?.status === "requested") return { role, status: existing.status as string, address: existing.address as string | null, created: false };
  if (existing?.status === "refused") await db.WalletVault.deleteOne({ _id: role, status: "refused" });
  try {
    await db.WalletVault.create({ _id: role, status: "requested", origin: "generated", requestedBy: input.actor, requestedAt: new Date(input.now ?? Date.now()), reason: input.reason ?? null });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }
  return { role, status: "requested", address: null, created: true };
}

/** Rewards worker (leader): generate and encrypt every requested wallet. Returns the roles generated. */
export async function fulfilWalletRequests(db: Models, cfg: Pick<AppConfig, "wallets" | "secrets" | "instanceId" | "api">, log: Logger = rootLogger(), now = Date.now()): Promise<WalletRole[]> {
  const pending: any[] = await db.WalletVault.find({ status: "requested" }).lean();
  if (!pending.length) return [];
  const key = loadVaultKey(cfg, { create: true })!;
  // All entries must share one vault key: never mint a wallet under a key that cannot open the others.
  const other: any = await db.WalletVault.findOne({ status: "active" }, { keyId: 1 }).lean();
  if (other && other.keyId !== vaultKeyId(key)) throw new VaultError("vault_key_mismatch", "this rewards worker's vault key differs from the one existing wallets were encrypted with; refusing to generate");
  const done: WalletRole[] = [];
  for (const row of pending) {
    if (row.origin === "imported") {
      if (await fulfilImport(db, cfg, key, row, log, now)) done.push(row._id);
      continue;
    }
    const kp = Keypair.generate();
    const enc = encryptSecretKey(key, row._id, kp);
    const r = await db.WalletVault.updateOne({ _id: row._id, status: "requested" }, { $set: { status: "active", address: kp.publicKey.toBase58(), ...enc, generatedAt: new Date(), generatedBy: cfg.instanceId } });
    if (r.modifiedCount) {
      done.push(row._id);
      log.warn({ role: row._id, address: kp.publicKey.toBase58() }, "wallet generated and stored encrypted in the vault — export a backup from the admin console");
    }
  }
  return done;
}

/** Addresses of the active vault wallets (every process, at boot). */
export async function readVaultWallets(db: Models): Promise<Required<VaultAddresses>> {
  const rows: any[] = await db.WalletVault.find({ status: "active" }, { address: 1 }).lean();
  const by = new Map(rows.map((r) => [r._id, r.address]));
  return { payout: by.get("payout") ?? null, creator: by.get("creator") ?? null };
}

/** Rewards worker / CLI on the rewards host: decrypt the key of an active vault wallet. */
export async function loadVaultKeypair(db: Models, cfg: Pick<AppConfig, "wallets" | "secrets">, role: WalletRole): Promise<Keypair | null> {
  const row: any = await db.WalletVault.findOne({ _id: role, status: "active" }).lean();
  if (!row) return null;
  const key = loadVaultKey(cfg);
  if (!key) throw new VaultError("vault_key_missing", `the ${role} wallet is in the vault but the vault key is missing (${cfg.wallets.vaultKeyPath} or LAST60_WALLET_VAULT_KEY); restore it`);
  return decryptSecretKey(key, row);
}

/**
 * Restart trigger: resolves `onChange` once the active wallets differ from those this process booted
 * with (a wallet was generated). Polls the database (cheap, indexed by _id).
 */
export function watchVaultWallets(db: Models, booted: Required<VaultAddresses>, onChange: (now: Required<VaultAddresses>) => void, intervalMs = 5_000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const now = await readVaultWallets(db);
      if (now.payout !== booted.payout || now.creator !== booted.creator) {
        stopped = true;
        clearInterval(id);
        onChange(now);
        return;
      }
    } catch {
      /* next tick */
    }
  };
  const id = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

// ── import (an existing key the admin already holds) ─────────────────────────────────────────

export const IMPORT_KEY_STATE_ID = "wallet_import_key";
const IMPORT_KEY_INFO = "last60/wallet-import/x25519/v1";

/** The rewards worker's X25519 import secret, derived from the vault key (stable: imports survive restarts). */
export function importSecretOf(vaultKey: Buffer): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", vaultKey, Buffer.alloc(0), IMPORT_KEY_INFO, 32));
}

/** API: the published import key (and ask the rewards worker to publish it if it has not yet). */
export async function requestImportKey(db: Models, now = Date.now()): Promise<{ status: "ready"; publicKey: string; fingerprint: string; publishedAt: string | null } | { status: "pending" }> {
  const doc: any = await db.SystemState.findById(IMPORT_KEY_STATE_ID).lean();
  const v = doc?.value;
  if (v?.publicKey) return { status: "ready", publicKey: v.publicKey, fingerprint: keyFingerprint(v.publicKey), publishedAt: v.publishedAt ?? null };
  await db.SystemState.updateOne({ _id: IMPORT_KEY_STATE_ID }, { $set: { "value.requested": true, "value.requestedAt": new Date(now).toISOString(), updatedAt: new Date(now) } }, { upsert: true });
  return { status: "pending" };
}

/**
 * Rewards worker: publish the import public key when asked (creating the vault key if needed), and keep it
 * current if the vault key changed. Without a request and without a vault key, nothing is created.
 */
export async function publishImportKey(db: Models, cfg: Pick<AppConfig, "wallets" | "secrets">): Promise<string | null> {
  const doc: any = await db.SystemState.findById(IMPORT_KEY_STATE_ID).lean();
  const requested = !!doc?.value?.requested;
  const key = loadVaultKey(cfg, { create: requested });
  if (!key) return null;
  const secret = importSecretOf(key);
  const publicKey = importPublicKey(secret);
  secret.fill(0);
  if (doc?.value?.publicKey === publicKey && !requested) return publicKey;
  await db.SystemState.updateOne({ _id: IMPORT_KEY_STATE_ID }, { $set: { value: { publicKey, keyId: vaultKeyId(key), publishedAt: new Date().toISOString() }, updatedAt: new Date() } }, { upsert: true });
  return publicKey;
}

export interface ImportRequestInput {
  requestId: string;
  message: string;
  signature: string;
  sealed: SealedImport;
  adminWallet: string;
  site: string | null;
  now?: number;
}

/** Shared checks of a signed import intent (API before storing it; worker again before importing it). */
export function checkImportIntent(input: { message: string; signature: string; adminWallet: string; requestId: string; role: string; workerKey: string | null; site: string | null; now: number }): string | null {
  const i = parseImportIntentMessage(input.message);
  if (!i) return "malformed_import_intent";
  if (i.requestId !== input.requestId) return "request_id_mismatch";
  if (i.role !== input.role) return "wallet_role_mismatch";
  if (input.site && i.site !== input.site) return "site_mismatch";
  if (!input.workerKey) return "import_key_not_published";
  if (i.workerKey !== input.workerKey) return "encrypted_to_an_unknown_key";
  const exp = Date.parse(i.expiresAt);
  if (exp <= input.now) return "import_intent_expired";
  if (exp - input.now > EXPORT_MAX_TTL_MS + 5_000) return "import_intent_expiry_too_far";
  if (!verifyAdminSignature(input.message, input.signature, input.adminWallet)) return "bad_admin_signature";
  return null;
}

const SEALED_FIELD = /^[A-Za-z0-9+/=]{1,400}$/;

/** API: store a signed, sealed import for the rewards worker. Never sees or stores the key in the clear. */
export async function requestWalletImport(db: Models, cfg: Pick<AppConfig, "wallets">, role: string, input: ImportRequestInput) {
  if (!(WALLET_ROLES as readonly string[]).includes(role)) throw new VaultError("unknown_role", `unknown wallet role ${role}`);
  const r = role as WalletRole;
  if (cfg.wallets[r].source === "env") throw new VaultError("wallet_configured_in_environment", `the ${r} wallet is configured in the environment (${cfg.wallets[r].address ?? "key only"}); remove it there to import one here`);
  const existing: any = await db.WalletVault.findById(r).lean();
  if (existing?.status === "active") throw new VaultError("wallet_exists", `a ${r} wallet already exists (${existing.address}); it is never replaced from the admin console`);
  if (existing?.status === "requested") throw new VaultError("wallet_exists", `a ${r} wallet request is already pending`);
  const s = input.sealed;
  if (!s || !/^[0-9a-f]{64}$/.test(s.senderKey) || !SEALED_FIELD.test(s.iv) || !SEALED_FIELD.test(s.ciphertext)) return { accepted: false as const, reason: "malformed_sealed_key" };
  const published: any = await db.SystemState.findById(IMPORT_KEY_STATE_ID).lean();
  const now = input.now ?? Date.now();
  const bad = checkImportIntent({ ...input, role: r, workerKey: published?.value?.publicKey ?? null, now });
  if (bad) return { accepted: false as const, reason: bad };
  const i = parseImportIntentMessage(input.message)!;
  const other = await db.WalletVault.findOne({ _id: { $ne: r }, status: "active" }, { address: 1 }).lean();
  if ((other as any)?.address === i.address || cfg.wallets[r === "payout" ? "creator" : "payout"].address === i.address) return { accepted: false as const, reason: "address_already_used_by_the_other_wallet" };
  if (existing?.status === "refused") await db.WalletVault.deleteOne({ _id: r, status: "refused" });
  try {
    await db.WalletVault.create({ _id: r, status: "requested", origin: "imported", requestedBy: input.adminWallet, requestedAt: new Date(now), import: { adminWallet: input.adminWallet, message: input.message, signature: input.signature, requestId: input.requestId, sealed: { senderKey: s.senderKey, iv: s.iv, ciphertext: s.ciphertext } } });
  } catch (err: any) {
    if (err?.code === 11000) throw new VaultError("wallet_exists", `a ${r} wallet request is already pending`);
    throw err;
  }
  return { accepted: true as const, role: r, address: i.address };
}

/**
 * Rewards worker: decide one pending import. Re-checks the intent (including that the signer is in THIS
 * process's ADMIN_WALLETS and that the browser encrypted to THIS worker's key), decrypts, checks the key
 * really controls the signed address, then stores it encrypted at rest like a generated wallet. A refusal
 * drops the sealed key. Returns true when the wallet became active.
 */
async function fulfilImport(db: Models, cfg: Pick<AppConfig, "api" | "instanceId">, vaultKey: Buffer, row: any, log: Logger, now: number): Promise<boolean> {
  const imp = row.import ?? {};
  const refuse = async (reason: string) => {
    await db.WalletVault.updateOne({ _id: row._id, status: "requested", origin: "imported" }, { $set: { status: "refused", refusedReason: reason, refusedAt: new Date(now), import: null } });
    log.warn({ role: row._id, admin: imp.adminWallet, reason }, "wallet import refused");
    return false;
  };
  if (!cfg.api.adminWallets.length) return refuse("admin_wallets_not_configured_in_rewards_worker: set ADMIN_WALLETS in the rewards worker's environment to allow key import");
  if (!cfg.api.adminWallets.includes(imp.adminWallet)) return refuse("signer_not_in_rewards_worker_admin_wallets");
  const secret = importSecretOf(vaultKey);
  const bad = checkImportIntent({ message: imp.message, signature: imp.signature, adminWallet: imp.adminWallet, requestId: imp.requestId, role: row._id, workerKey: importPublicKey(secret), site: null, now });
  if (bad) {
    secret.fill(0);
    return refuse(bad);
  }
  const intent = parseImportIntentMessage(imp.message)!;
  let plain: Uint8Array;
  try {
    plain = await openImport(secret, imp.sealed, imp.requestId);
  } catch {
    return refuse("cannot_decrypt_sealed_key");
  } finally {
    secret.fill(0);
  }
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(Uint8Array.from(plain)); // validates the public half against the seed
  } catch {
    plain.fill(0);
    return refuse("not_a_valid_solana_secret_key");
  }
  plain.fill(0);
  if (kp.publicKey.toBase58() !== intent.address) return refuse("key_does_not_control_the_signed_address");
  const enc = encryptSecretKey(vaultKey, row._id, kp);
  const r = await db.WalletVault.updateOne({ _id: row._id, status: "requested", origin: "imported" }, { $set: { status: "active", address: kp.publicKey.toBase58(), ...enc, generatedAt: new Date(now), generatedBy: cfg.instanceId, import: null } });
  if (!r.modifiedCount) return false;
  log.warn({ role: row._id, address: kp.publicKey.toBase58(), admin: imp.adminWallet }, "wallet imported and stored encrypted in the vault");
  return true;
}

// ── retire (clear a wallet so a fresh one can be generated or imported) ──────────────────────

/** Only the creator wallet can be cleared from the admin console (one launch's creator, replaced per launch). */
export const RETIRABLE_ROLES: readonly WalletRole[] = ["creator"];

/**
 * API: clear the active `role` wallet so a fresh one can be generated or imported. The vault entry is moved
 * unchanged to `wallet_vault_retired` (still encrypted; the key stays recoverable on the rewards host), then
 * every process notices the change and restarts without it (watchVaultWallets). Refuses an environment
 * wallet, a wrong typed address, and — for the creator — while a creator-wallet transfer is in flight (its
 * effect would otherwise never be recorded).
 */
export async function retireWallet(db: Models, cfg: Pick<AppConfig, "wallets">, input: { role: string; actor: string; confirmAddress: string; reason?: string | null; now?: number }) {
  if (!(WALLET_ROLES as readonly string[]).includes(input.role)) throw new VaultError("unknown_role", `unknown wallet role ${input.role}`);
  const role = input.role as WalletRole;
  if (!RETIRABLE_ROLES.includes(role)) throw new VaultError("role_not_retirable", `the ${role} wallet cannot be cleared from the admin console`);
  if (cfg.wallets[role].source === "env") throw new VaultError("wallet_configured_in_environment", `the ${role} wallet is configured in the environment (${cfg.wallets[role].address ?? "key only"}); remove it there instead`);
  const row: any = await db.WalletVault.findById(role).lean();
  if (!row || row.status !== "active") throw new VaultError("wallet_not_found", `there is no active ${role} wallet to clear`);
  if (input.confirmAddress.trim() !== row.address) throw new VaultError("address_confirmation_mismatch", `type the ${role} wallet's full address (${row.address}) to confirm`);
  if (role === "creator") {
    const open = await db.CreatorWalletTransfer.countDocuments({ from: row.address, $or: [{ status: "submitted" }, { status: "confirmed", effectRecorded: false }] });
    if (open) throw new VaultError("transfers_in_flight", `${open} creator wallet transfer(s) are still in flight; try again in a minute once they are confirmed`);
  }
  const at = new Date(input.now ?? Date.now());
  const id = `${role}:${row.address}:${at.getTime()}`;
  await db.RetiredWallet.create({ _id: id, role, address: row.address, entry: row, retiredAt: at, retiredBy: input.actor, reason: input.reason ?? null });
  const r = await db.WalletVault.deleteOne({ _id: role, status: "active", address: row.address });
  if (!r.deletedCount) {
    await db.RetiredWallet.deleteOne({ _id: id });
    throw new VaultError("wallet_not_found", `the ${role} wallet changed while clearing it; reload and try again`);
  }
  return { role, retired: row.address as string, archiveId: id };
}

/** Rewards host: decrypt a retired wallet's key (recovery of funds left in an old creator wallet). */
export async function loadRetiredKeypair(db: Models, cfg: Pick<AppConfig, "wallets" | "secrets">, archiveId: string): Promise<Keypair | null> {
  const a: any = await db.RetiredWallet.findById(archiveId).lean();
  if (!a) return null;
  const key = loadVaultKey(cfg);
  if (!key) throw new VaultError("vault_key_missing", `the vault key is missing (${cfg.wallets.vaultKeyPath} or LAST60_WALLET_VAULT_KEY); restore it`);
  return decryptSecretKey(key, a.entry);
}

// ── status (admin) ───────────────────────────────────────────────────────────────────────────

export async function walletsStatus(db: Models, cfg: Pick<AppConfig, "wallets">, balanceOf?: (address: string) => Promise<bigint | null>) {
  const rows: any[] = await db.WalletVault.find({}).lean();
  const retired: any[] = await db.RetiredWallet.find({}, { role: 1, address: 1, retiredAt: 1, retiredBy: 1 }).sort({ retiredAt: -1 }).limit(20).lean();
  const out: Record<string, unknown> = {};
  for (const role of WALLET_ROLES) {
    const row = rows.find((r) => r._id === role);
    const configured = cfg.wallets[role];
    // What this process booted with vs. what is in the vault now (a just-generated wallet, before restart).
    const address = configured.address ?? (row?.status === "active" ? row.address : null);
    out[role] = {
      address,
      source: configured.source ?? (row?.status === "active" ? "vault" : null),
      vault: row ? { status: row.status, origin: row.origin ?? "generated", requestedAt: row.requestedAt, requestedBy: row.requestedBy, generatedAt: row.generatedAt, lastExportedAt: row.lastExportedAt, exports: row.exports ?? 0, refusedReason: row.refusedReason ?? null, refusedAt: row.refusedAt ?? null } : null,
      pendingRestart: row?.status === "active" && configured.source !== "env" && configured.address !== row.address,
      retirable: RETIRABLE_ROLES.includes(role) && row?.status === "active" && configured.source !== "env",
      retired: retired.filter((x) => x.role === role).map((x) => ({ id: x._id, address: x.address, retiredAt: x.retiredAt, retiredBy: x.retiredBy })),
      balanceLamports: address && balanceOf ? ((await balanceOf(address).catch(() => null))?.toString() ?? null) : null,
    };
  }
  return out;
}

// ── export (end-to-end encrypted, admin-wallet signed) ───────────────────────────────────────

export interface ExportRequestInput {
  requestId: string;
  message: string;
  signature: string;
  adminWallet: string;
  site: string | null;
  now?: number;
}

export function verifyAdminSignature(message: string, signatureB58: string, wallet: string): boolean {
  try {
    return ed25519.verify(bs58.decode(signatureB58), new TextEncoder().encode(message), bs58.decode(wallet));
  } catch {
    return false;
  }
}

/** Shared checks of a signed export intent (API before storing it; worker again before fulfilling it). */
export function checkExportIntent(input: { message: string; signature: string; adminWallet: string; requestId: string; role: string; address: string | null; site: string | null; now: number }): string | null {
  const i = parseExportIntentMessage(input.message);
  if (!i) return "malformed_export_intent";
  if (i.requestId !== input.requestId) return "request_id_mismatch";
  if (i.role !== input.role) return "wallet_role_mismatch";
  if (!input.address || i.address !== input.address) return "wallet_address_mismatch";
  if (input.site && i.site !== input.site) return "site_mismatch";
  const exp = Date.parse(i.expiresAt);
  if (exp <= input.now) return "export_intent_expired";
  if (exp - input.now > EXPORT_MAX_TTL_MS + 5_000) return "export_intent_expiry_too_far";
  if (!verifyAdminSignature(input.message, input.signature, input.adminWallet)) return "bad_admin_signature";
  return null;
}

/** API: store a signed export request for the rewards worker. Never stores or returns key material. */
export async function createExportRequest(db: Models, cfg: Pick<AppConfig, "wallets">, role: string, input: ExportRequestInput) {
  if (!(WALLET_ROLES as readonly string[]).includes(role)) throw new VaultError("unknown_role", `unknown wallet role ${role}`);
  const row: any = await db.WalletVault.findOne({ _id: role, status: "active" }).lean();
  if (!row) throw new VaultError("wallet_exists", `no generated ${role} wallet to export (only wallets generated in the admin console can be exported here)`);
  const now = input.now ?? Date.now();
  const bad = checkExportIntent({ ...input, role, address: row.address, now });
  if (bad) return { accepted: false as const, reason: bad };
  const i = parseExportIntentMessage(input.message)!;
  try {
    await db.WalletExport.create({ _id: input.requestId, role, address: row.address, adminWallet: input.adminWallet, message: input.message, signature: input.signature, browserKey: i.browserKey, status: "requested", expiresAt: new Date(Date.parse(i.expiresAt)), createdAt: new Date(now) });
  } catch (err: any) {
    if (err?.code === 11000) return { accepted: false as const, reason: "request_id_reused" };
    throw err;
  }
  return { accepted: true as const, requestId: input.requestId, expiresAt: i.expiresAt };
}

/**
 * Rewards worker (leader): fulfil pending export requests. Independently re-checks everything the API
 * checked, plus that the signer is in THIS process's ADMIN_WALLETS — so neither the API nor a database
 * write can obtain a key for a browser key the admin did not sign.
 */
export async function fulfilExportRequests(db: Models, cfg: Pick<AppConfig, "wallets" | "secrets" | "api">, o: { now?: number; log?: Logger } = {}): Promise<number> {
  const now = o.now ?? Date.now();
  const log = o.log ?? rootLogger();
  const pending: any[] = await db.WalletExport.find({ status: "requested" }).sort({ createdAt: 1 }).limit(10).lean();
  let n = 0;
  for (const req of pending) {
    const refuse = async (reason: string) => {
      await db.WalletExport.updateOne({ _id: req._id, status: "requested" }, { $set: { status: "refused", refusedReason: reason } });
      log.warn({ requestId: req._id, role: req.role, admin: req.adminWallet, reason }, "wallet export refused");
    };
    if (!cfg.api.adminWallets.length) {
      await refuse("admin_wallets_not_configured_in_rewards_worker: set ADMIN_WALLETS in the rewards worker's environment to allow key export");
      continue;
    }
    if (!cfg.api.adminWallets.includes(req.adminWallet)) {
      await refuse("signer_not_in_rewards_worker_admin_wallets");
      continue;
    }
    const row: any = await db.WalletVault.findOne({ _id: req.role, status: "active" }).lean();
    const bad = checkExportIntent({ message: req.message, signature: req.signature, adminWallet: req.adminWallet, requestId: req._id, role: req.role, address: row?.address ?? null, site: null, now });
    if (bad) {
      await refuse(bad);
      continue;
    }
    if (parseExportIntentMessage(req.message)!.browserKey !== req.browserKey) {
      await refuse("browser_key_mismatch");
      continue;
    }
    let kp: Keypair;
    try {
      const key = loadVaultKey(cfg);
      if (!key) throw new VaultError("vault_key_missing", "vault key missing");
      kp = decryptSecretKey(key, row);
    } catch (err) {
      await refuse(err instanceof VaultError ? err.code : "vault_error");
      continue;
    }
    const sealed = await sealExport(kp.secretKey, req.browserKey, req._id);
    const r = await db.WalletExport.updateOne({ _id: req._id, status: "requested" }, { $set: { status: "ready", ...sealed, readyAt: new Date(now) } });
    if (r.modifiedCount) {
      await db.WalletVault.updateOne({ _id: req.role }, { $set: { lastExportedAt: new Date(now) }, $inc: { exports: 1 } });
      log.warn({ requestId: req._id, role: req.role, admin: req.adminWallet }, "wallet key exported (end-to-end encrypted to the admin's browser)");
      n++;
    }
  }
  return n;
}

/** API: hand a ready export to the admin who requested it, exactly once (the ciphertext is then deleted). */
export async function takeExport(db: Models, requestId: string, adminWallet: string, now = Date.now()) {
  const row: any = await db.WalletExport.findById(requestId).lean();
  if (!row || row.adminWallet !== adminWallet) return { status: "not_found" as const };
  if (row.status === "refused") return { status: "refused" as const, reason: row.refusedReason };
  if (row.status === "consumed") return { status: "consumed" as const };
  if (row.status !== "ready") return { status: new Date(row.expiresAt).getTime() < now ? ("expired" as const) : ("pending" as const) };
  const taken: any = await db.WalletExport.findOneAndUpdate({ _id: requestId, status: "ready" }, { $set: { status: "consumed", consumedAt: new Date(now), ciphertext: null, iv: null } }, { returnDocument: "before" }).lean();
  if (!taken) return { status: "consumed" as const };
  return { status: "ready" as const, sealed: { workerKey: taken.workerKey, iv: taken.iv, ciphertext: taken.ciphertext }, role: taken.role, address: taken.address };
}
