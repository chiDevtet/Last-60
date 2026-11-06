/**
 * Post-graduation groundwork: find WHERE a bonding-curve pool migrated, prove it on-chain, and
 * describe WHO is entitled to fees afterwards. Read-only; nothing here signs or sends.
 *
 * Detection is evidence-based, never a guess:
 *   1. Status comes from the bonding pool's own state (DBC `is_migrated`/`migration_progress`,
 *      LaunchLab `status`).
 *   2. The destination is read from the successful migration instruction itself, whose account
 *      list names the destination pool (and, for DAMM v2, the LP positions it created):
 *        DBC       migration_damm_v2   #4 pool, #5-#7 / #8-#10 positions, remaining[0] DAMM config
 *        DBC       migrate_meteora_damm (DAMM v1, deprecated for new configs)
 *        LaunchLab migrate_to_cpswap   #5 CPMM pool, #10 CPMM config, #17 bonding pool
 *        LaunchLab migrate_to_amm      #13 AMM v4 pool, #23 bonding pool
 *   3. The destination account is then verified: owning program, both mints, the PDA derivation
 *      from (config, mints), and (DAMM v2) the pool creator = DBC pool authority; position NFTs
 *      are resolved to their current holders.
 *
 * Verified against mainnet (fixtures in test/fixtures/mainnet/migration-*.json):
 *   DBC pool AX7tzZ96… → DAMM v2 pool 26n3vvi7… (tx 2xu4wQep…, slot 465800030)
 *   LaunchLab pool 8AH7Rbje… → CPMM pool 2ZJpQEny… (tx 371QXpQ6…, slot 465826675)
 *
 * Fee entitlement after graduation is NOT the bonding-curve formula:
 *   - DAMM v2: LP fees accrue per position, proportionally to the position's liquidity (unlocked +
 *     vested + permanently locked) via `fee_{a,b}_per_liquidity` accumulators; the holder of the
 *     position NFT claims them (`claim_position_fee`). Which positions the creator / partner hold is
 *     decided by the DBC config's LP percentages at migration — e.g. a config with
 *     creator_trading_fee_percentage = 0 (creator earns NOTHING while bonding) can give the creator
 *     ~100% of LP fees after graduation.
 *   - Raydium CPMM: per-swap `creator_fee` accrues to `pool_creator` in `creator_fees_token_{0,1}`,
 *     but a protocol share (`share_rate`, from the AmmConfig or a per-creator override account) is
 *     deducted when it is COLLECTED, and collection is permissionless — so the swap event's
 *     `creator_fee` is not what the creator receives. Locked-LP "fee key" fees go to the LaunchLab
 *     platform/creator per `platform_scale`/`creator_scale`.
 *   - Raydium AMM v4 has no creator fee.
 */
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { instructionDiscriminator } from "../chain/anchorEvents";
import type { ChainRpc } from "../chain/rpc";
import type { NormalizedTx } from "../chain/tx";
import { normalizeTransaction } from "../chain/tx";

export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const DAMM_V1_PROGRAM_ID = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";
export const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const RAYDIUM_AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
/** Raydium liquidity-lock program ("Burn & Earn"): holds locked CPMM LP and pays LP fees to the fee-key NFT holder. */
export const RAYDIUM_CP_LOCK_PROGRAM_ID = "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE";
/** DBC `pool_authority` PDA — the creator recorded on DAMM v2 pools created by DBC migration. */
export const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";

export type MigrationKind = "dbc_damm_v2" | "dbc_damm_v1" | "launchlab_cpmm" | "launchlab_amm_v4";

export interface MigrationRecord {
  kind: MigrationKind;
  bondingPool: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  destinationProgram: string;
  destinationPool: string;
  /** Config the destination pool was created with (DAMM v2 / CPMM), needed for PDA verification. */
  destinationConfig: string | null;
  baseMint: string;
  quoteMint: string;
  /** DAMM v2 LP positions created by the migration (the second may be absent on-chain). */
  positions: { position: string; nftMint: string; nftAccount: string }[];
  /** LaunchLab → CPMM: LP locks (fee-key NFTs) created by the migration. */
  locks?: MigrationLpLock[];
}

const IX = {
  dbcDammV2: instructionDiscriminator("migration_damm_v2").toString("hex"),
  dbcDammV1: instructionDiscriminator("migrate_meteora_damm").toString("hex"),
  llCpmm: instructionDiscriminator("migrate_to_cpswap").toString("hex"),
  llAmm: instructionDiscriminator("migrate_to_amm").toString("hex"),
};

/** Pure: extract the migration of `bondingPool` from a transaction, or null. */
export function parseMigration(tx: NormalizedTx, provider: "meteora_dbc" | "raydium_launchlab", bondingPool: string): MigrationRecord | null {
  if (tx.err) return null;
  for (const ix of tx.instructions) {
    const disc = ix.data.subarray(0, 8).toString("hex");
    const a = ix.accounts;
    const base = { bondingPool, signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime };
    if (provider === "meteora_dbc" && ix.programId === DBC_PROGRAM && a[0] === bondingPool) {
      if (disc === IX.dbcDammV2) {
        const positions = [
          { nftMint: a[5]!, nftAccount: a[6]!, position: a[7]! },
          { nftMint: a[8]!, nftAccount: a[9]!, position: a[10]! },
        ].filter((p) => p.position && p.position !== DBC_PROGRAM && p.position !== DAMM_V2_PROGRAM_ID); // Anchor passes the program id for an absent Option
        return { ...base, kind: "dbc_damm_v2", destinationProgram: a[12]!, destinationPool: a[4]!, destinationConfig: a[25] ?? null, baseMint: a[13]!, quoteMint: a[14]!, positions };
      }
      if (disc === IX.dbcDammV1) {
        // migrate_meteora_damm: #4 pool, #5 damm_config, #6 lp_mint, #7/#8 token a/b mint, #26 amm_program (IDL)
        return { ...base, kind: "dbc_damm_v1", destinationProgram: a[26]!, destinationPool: a[4]!, destinationConfig: a[5] ?? null, baseMint: a[7]!, quoteMint: a[8]!, positions: [] };
      }
    }
    if (provider === "raydium_launchlab" && ix.programId === LAUNCHLAB_PROGRAM) {
      if (disc === IX.llCpmm && a[17] === bondingPool) {
        return { ...base, kind: "launchlab_cpmm", destinationProgram: a[4]!, destinationPool: a[5]!, destinationConfig: a[10] ?? null, baseMint: a[1]!, quoteMint: a[2]!, positions: [], locks: parseMigrationLocks(tx).filter((l) => l.pool === a[5]) };
      }
      if (disc === IX.llAmm && a[23] === bondingPool) {
        return { ...base, kind: "launchlab_amm_v4", destinationProgram: a[12]!, destinationPool: a[13]!, destinationConfig: null, baseMint: a[1]!, quoteMint: a[2]!, positions: [] };
      }
    }
  }
  return null;
}

/**
 * Scan the bonding pool's history (newest first, bounded) for its migration transaction. Only the
 * migration and later claims touch a graduated bonding pool, so it is normally on the first page.
 */
export async function findMigration(rpc: ChainRpc, provider: "meteora_dbc" | "raydium_launchlab", bondingPool: string, opts: { maxPages?: number } = {}): Promise<MigrationRecord | null> {
  let before: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 3); page++) {
    const sigs = await rpc.getSignaturesForAddress(bondingPool, { before, limit: 100 });
    for (const s of sigs) {
      if (s.err) continue;
      const raw = await rpc.getTransactionRaw(s.signature);
      if (!raw) continue;
      const m = parseMigration(normalizeTransaction(raw), provider, bondingPool);
      if (m) return m;
    }
    if (sigs.length < 100) break;
    before = sigs[sigs.length - 1]!.signature;
  }
  return null;
}

// ── account decoding (offsets verified against mainnet accounts) ─────────────────────────────

const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);
const u256 = (d: Buffer, o: number) => u128(d, o) | (u128(d, o + 16) << 128n);

/** DAMM v2 `Pool` (zero-copy, 1112 bytes). */
export function decodeDammV2Pool(d: Buffer) {
  return {
    tokenAMint: key(d, 168),
    tokenBMint: key(d, 200),
    tokenAVault: key(d, 232),
    tokenBVault: key(d, 264),
    liquidity: u128(d, 360),
    collectFeeMode: d[484]!,
    feeAPerLiquidity: u256(d, 488),
    feeBPerLiquidity: u256(d, 520),
    permanentLockLiquidity: u128(d, 552),
    totalLpAFee: u128(d, 568),
    totalLpBFee: u128(d, 584),
    creator: key(d, 648),
  };
}

/** DAMM v2 `Position` (zero-copy, 408 bytes). */
export function decodeDammV2Position(d: Buffer) {
  return {
    pool: key(d, 8),
    nftMint: key(d, 40),
    feeACheckpoint: u256(d, 72),
    feeBCheckpoint: u256(d, 104),
    feeAPending: u64(d, 136),
    feeBPending: u64(d, 144),
    unlockedLiquidity: u128(d, 152),
    vestedLiquidity: u128(d, 168),
    permanentLockedLiquidity: u128(d, 184),
    totalClaimedAFee: u64(d, 200),
    totalClaimedBFee: u64(d, 208),
  };
}

const U256_MOD = 1n << 256n;
const U64_MAX = (1n << 64n) - 1n;
/**
 * Claimable LP fees of a DAMM v2 position right now — the program's own formula
 * (`Position::update_fee` + `calculate_position_fee_or_reward`, LIQUIDITY_SCALE = 128):
 *   pending + min(u64::MAX, liquidity_total × wrapping(fee_per_liquidity − checkpoint) >> 128)
 * A cumulative counter: Σ over consecutive periods of (claimable_t + claimed_t) differences tiles
 * exactly, which is the basis for exact post-graduation period accounting.
 */
export function dammV2ClaimableFees(pool: ReturnType<typeof decodeDammV2Pool>, pos: ReturnType<typeof decodeDammV2Position>): { a: bigint; b: bigint } {
  const liq = pos.unlockedLiquidity + pos.vestedLiquidity + pos.permanentLockedLiquidity;
  const accrue = (perLiq: bigint, cp: bigint) => {
    const r = (liq * ((perLiq - cp + U256_MOD) % U256_MOD)) >> 128n;
    return r > U64_MAX ? U64_MAX : r;
  };
  const sat = (x: bigint) => (x > U64_MAX ? U64_MAX : x); // saturating_add in the program
  return { a: sat(pos.feeAPending + accrue(pool.feeAPerLiquidity, pos.feeACheckpoint)), b: sat(pos.feeBPending + accrue(pool.feeBPerLiquidity, pos.feeBCheckpoint)) };
}

/** Raydium CPMM `PoolState`. */
export function decodeCpmmPool(d: Buffer) {
  return {
    ammConfig: key(d, 8),
    poolCreator: key(d, 40),
    token0Vault: key(d, 72),
    token1Vault: key(d, 104),
    lpMint: key(d, 136),
    token0Mint: key(d, 168),
    token1Mint: key(d, 200),
  };
}

/** SPL token account (Token / Token-2022 base layout). */
export function decodeTokenAccount(d: Buffer) {
  return { mint: key(d, 0), owner: key(d, 32), amount: u64(d, 64) };
}

const accountDisc = (name: string) => Buffer.from(sha256(new TextEncoder().encode(`account:${name}`))).subarray(0, 8);
export const DAMM_V2_POOL_DISC = accountDisc("Pool");
export const DAMM_V2_POSITION_DISC = accountDisc("Position");
export const DAMM_V2_CONFIG_DISC = accountDisc("Config");
export const CPMM_POOL_DISC = accountDisc("PoolState");
export const CPMM_CONFIG_DISC = accountDisc("AmmConfig");
export const DAMM_V2_POOL_SIZE = 1112;
export const DAMM_V2_POSITION_SIZE = 408;
export const CPMM_POOL_SIZE = 637;
export const CPMM_CONFIG_SIZE = 236;

/** Raydium CPMM `AmmConfig` (236 bytes): fee rates in millionths. `creator_fee_share_rate` sits in the former padding. */
export function decodeCpmmConfig(d: Buffer) {
  return { tradeFeeRate: u64(d, 12), protocolFeeRate: u64(d, 20), fundFeeRate: u64(d, 28), creatorFeeRate: u64(d, 108), creatorFeeShareRate: u64(d, 116) };
}

/** Raydium CPMM `PoolState` fee fields (offsets from the packed zero-copy layout, 637 bytes). */
export function decodeCpmmPoolFees(d: Buffer) {
  return { lpSupply: u64(d, 333), creatorFeeOn: d[389]!, enableCreatorFee: d[390]! === 1, creatorFeesToken0: u64(d, 397), creatorFeesToken1: u64(d, 405) };
}

/**
 * CPMM `PoolState.creator_fee_on` (u8 at byte 389). Verified against raydium-cp-swap
 * `states/pool.rs` (`CreatorFeeOn::from_u8` / `to_u8`, `is_creator_fee_on_input`) and the bundled IDL
 * enum `CreatorFeeOn { BothToken, OnlyToken0, OnlyToken1 }`:
 *   0 both_tokens   — the creator fee is taken from the swap's INPUT token, so it accrues in either mint;
 *   1 only_token_0  — always in token_0 (on input for 0→1 swaps, on output for 1→0 swaps);
 *   2 only_token_1  — always in token_1.
 * Any other value is rejected by the program (`InvalidFeeModel`) and is treated here as unverifiable.
 */
export type CpmmCreatorFeeOn = "both_tokens" | "only_token_0" | "only_token_1";
const CREATOR_FEE_ON: Record<number, CpmmCreatorFeeOn> = { 0: "both_tokens", 1: "only_token_0", 2: "only_token_1" };
export function decodeCreatorFeeOn(raw: number | null | undefined): CpmmCreatorFeeOn | null {
  return raw === null || raw === undefined ? null : (CREATOR_FEE_ON[raw] ?? null);
}
/** Mint(s) in which the CPMM creator fee accrues under a `creator_fee_on` mode. */
export function creatorFeeMints(mode: CpmmCreatorFeeOn, token0Mint: string, token1Mint: string): string[] {
  return mode === "only_token_0" ? [token0Mint] : mode === "only_token_1" ? [token1Mint] : [token0Mint, token1Mint];
}

/**
 * Per-creator CPMM creator-fee share override (raydium-cp-swap `states/creator_fee_share.rs`):
 *   PDA   = ["creator_fee_share", pool_creator, amm_config] under the CPMM program;
 *   layout = 8 discriminator ("account:CreatorFeeShare") · bump u8 · creator Pubkey · amm_config Pubkey ·
 *            share_rate u64 (millionths of the accrued creator fee kept by the protocol) · padding [u64; 8] = 145 bytes.
 * Precedence (`resolve_creator_fee_share_rate`, called by BOTH collect_creator_fee instructions, which
 * always pass the PDA): when the account is empty OR not owned by the CPMM program the AmmConfig
 * `creator_fee_share_rate` applies; otherwise the override's `share_rate` (discriminator checked).
 * The creator receives `accrued − ⌊accrued × share_rate / 1e6⌋` (`split_creator_fee_shared_amount`).
 * Mainnet evidence: test/fixtures/mainnet/cpmm-creator-fee-share.json.
 */
export const CREATOR_FEE_SHARE_SEED = "creator_fee_share";
export const CREATOR_FEE_SHARE_DISC = accountDiscOf("CreatorFeeShare");
export const CREATOR_FEE_SHARE_SIZE = 145;
function accountDiscOf(name: string) {
  return Buffer.from(sha256(new TextEncoder().encode(`account:${name}`))).subarray(0, 8);
}
export function deriveCreatorFeeSharePda(poolCreator: string, ammConfig: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from(CREATOR_FEE_SHARE_SEED), new PublicKey(poolCreator).toBuffer(), new PublicKey(ammConfig).toBuffer()], new PublicKey(RAYDIUM_CPMM_PROGRAM_ID))[0].toBase58();
}
export function decodeCreatorFeeShare(d: Buffer): { bump: number; creator: string; ammConfig: string; shareRate: bigint } | null {
  if (d.length !== CREATOR_FEE_SHARE_SIZE || !d.subarray(0, 8).equals(CREATOR_FEE_SHARE_DISC)) return null;
  return { bump: d[8]!, creator: key(d, 9), ammConfig: key(d, 41), shareRate: u64(d, 73) };
}

export interface CreatorFeeShareResolution {
  /** AmmConfig.creator_fee_share_rate (the default). */
  ammConfigDefaultRate: string | null;
  overridePda: string;
  /** "absent": no account / not CPMM-owned → default applies. "present": decoded override. "invalid": CPMM-owned but undecodable. */
  override: "absent" | "present" | "invalid";
  overrideRate: string | null;
  /** The rate the deployed program would apply at collection, or null when it cannot be established. */
  effectiveRate: string | null;
  source: "amm_config_default" | "creator_fee_share_override" | "unresolved";
  /** Slot at which the PDA was read. */
  verifiedAtSlot: number | null;
  problems: string[];
}

/** Pure: the effective creator-fee share rate from the AmmConfig default and the PDA account as read. */
export function resolveCreatorFeeShareRate(o: { poolCreator: string; ammConfig: string; ammConfigDefaultRate: bigint | null; pdaAccount: { owner: string; data: Buffer } | null; slot: number | null }): CreatorFeeShareResolution {
  const overridePda = deriveCreatorFeeSharePda(o.poolCreator, o.ammConfig);
  const base = { ammConfigDefaultRate: o.ammConfigDefaultRate?.toString() ?? null, overridePda, verifiedAtSlot: o.slot, problems: [] as string[] };
  const acc = o.pdaAccount;
  if (!acc || acc.data.length === 0 || acc.owner !== RAYDIUM_CPMM_PROGRAM_ID) {
    if (o.ammConfigDefaultRate === null) return { ...base, override: "absent", overrideRate: null, effectiveRate: null, source: "unresolved", problems: ["AmmConfig creator_fee_share_rate could not be read"] };
    if (o.ammConfigDefaultRate > RATE_DENOM) return { ...base, override: "absent", overrideRate: null, effectiveRate: null, source: "unresolved", problems: [`AmmConfig creator_fee_share_rate ${o.ammConfigDefaultRate} exceeds 1 000 000`] };
    return { ...base, override: "absent", overrideRate: null, effectiveRate: o.ammConfigDefaultRate.toString(), source: "amm_config_default" };
  }
  const d = decodeCreatorFeeShare(acc.data);
  if (!d) return { ...base, override: "invalid", overrideRate: null, effectiveRate: null, source: "unresolved", problems: [`CreatorFeeShare ${overridePda} is owned by the CPMM program but does not decode (size ${acc.data.length})`] };
  if (d.creator !== o.poolCreator || d.ammConfig !== o.ammConfig) return { ...base, override: "invalid", overrideRate: null, effectiveRate: null, source: "unresolved", problems: [`CreatorFeeShare ${overridePda} names creator ${d.creator} / config ${d.ammConfig}, not ${o.poolCreator} / ${o.ammConfig}`] };
  if (d.shareRate > RATE_DENOM) return { ...base, override: "invalid", overrideRate: d.shareRate.toString(), effectiveRate: null, source: "unresolved", problems: [`CreatorFeeShare share_rate ${d.shareRate} exceeds 1 000 000 (collection would fail)`] };
  return { ...base, override: "present", overrideRate: d.shareRate.toString(), effectiveRate: d.shareRate.toString(), source: "creator_fee_share_override" };
}
const RATE_DENOM = 1_000_000n;

/** Read the PDA (and nothing else) and resolve the effective share rate. Read-only. */
export async function readCreatorFeeShare(rpc: Pick<ChainRpc, "getAccountInfo">, poolCreator: string, ammConfig: string, ammConfigDefaultRate: bigint | null): Promise<CreatorFeeShareResolution> {
  const pda = deriveCreatorFeeSharePda(poolCreator, ammConfig);
  const r = await rpc.getAccountInfo(pda);
  return resolveCreatorFeeShareRate({ poolCreator, ammConfig, ammConfigDefaultRate, pdaAccount: r.value ? { owner: r.value.owner, data: r.value.data } : null, slot: r.slot ?? null });
}

/** Creator's net amount for an accrued CPMM creator fee at a share rate (program rounding: protocol share floors). */
export function cpmmCreatorNetAmount(accrued: bigint, shareRate: bigint): { creator: bigint; protocol: bigint } {
  if (shareRate < 0n || shareRate > RATE_DENOM) throw new Error("share rate out of range");
  const protocol = (accrued * shareRate) / RATE_DENOM;
  return { creator: accrued - protocol, protocol };
}

/** LP locks created by a LaunchLab → CPMM migration (Raydium LP-lock `lock_cp_liquidity` CPIs). */
export interface MigrationLpLock {
  lockPda: string;
  nftMint: string;
  nftAccount: string;
  /** Wallet the fee-key NFT was minted to at migration (platform lock wallet or token creator). */
  nftOwnerAtMigration: string;
  lpAmount: bigint;
  pool: string;
  lpMint: string;
}

const LOCK_CP_LIQUIDITY_DISC = Buffer.from([216, 157, 29, 78, 38, 51, 31, 26]);
export const COLLECT_CP_FEES_DISC = Buffer.from([8, 30, 51, 199, 209, 184, 247, 133]);

/** Pure: the LP locks created inside a migration transaction (account order per the Raydium SDK). */
export function parseMigrationLocks(tx: NormalizedTx): MigrationLpLock[] {
  const out: MigrationLpLock[] = [];
  for (const ix of tx.instructions) {
    if (ix.programId !== RAYDIUM_CP_LOCK_PROGRAM_ID || !ix.data.subarray(0, 8).equals(LOCK_CP_LIQUIDITY_DISC) || ix.data.length < 16) continue;
    const a = ix.accounts;
    out.push({ nftOwnerAtMigration: a[3]!, nftMint: a[4]!, nftAccount: a[5]!, pool: a[6]!, lockPda: a[7]!, lpMint: a[8]!, lpAmount: ix.data.readBigUInt64LE(8) });
  }
  return out;
}

/** Current holder of a position / fee-key NFT: its recorded token account if it still holds it, else the mint's largest account. */
export async function resolveNftHolder(rpc: ChainRpc, nftMint: string, nftAccount: string, preloaded?: { owner: string; data: Buffer } | null, opts: { minContextSlot?: number } = {}): Promise<string | null> {
  const direct = preloaded ?? (await rpc.getAccountInfo(nftAccount, "confirmed", opts)).value;
  if (direct && direct.data.length >= 72) {
    const t = decodeTokenAccount(direct.data);
    if (t.mint === nftMint && t.amount === 1n) return t.owner;
  }
  const largest = await rpc.getTokenLargestAccounts(nftMint).catch(() => null);
  const top = largest?.value.find((x) => x.amount === 1n);
  if (!top) return null;
  const acc = (await rpc.getAccountInfo(top.address, "confirmed", opts)).value;
  if (!acc || acc.data.length < 72) return null;
  const t = decodeTokenAccount(acc.data);
  return t.mint === nftMint && t.amount === 1n ? t.owner : null;
}

export interface PositionState {
  position: string;
  nftMint: string;
  nftAccount: string;
  holder: string | null;
  liquidity: bigint;
  claimableA: bigint;
  claimableB: bigint;
  claimedA: bigint;
  claimedB: bigint;
}

export interface VerifiedMigration extends MigrationRecord {
  /** False for destinations LAST60 cannot verify and account (DAMM v1, Raydium AMM v4). */
  supported: boolean;
  checks: Record<string, boolean>;
  /** Check names that MUST be present and true for this kind. */
  requiredChecks: string[];
  failed: string[];
  /** DAMM v2: each migration position with its current NFT holder and claimable fees. */
  positionStates: PositionState[];
  /** CPMM: the wallet receiving the CPMM creator fee. */
  cpmmPoolCreator: string | null;
  cpmmLpMint: string | null;
  cpmmVaults: { token0: string; token1: string } | null;
  cpmmEnableCreatorFee: boolean | null;
  /** CPMM `creator_fee_on` raw byte and its verified mode (null = not a known mode → fail closed). */
  cpmmCreatorFeeOnRaw: number | null;
  cpmmCreatorFeeOn: CpmmCreatorFeeOn | null;
  cpmmConfig: { creatorFeeRate: string; creatorFeeShareRate: string; tradeFeeRate: string } | null;
  /** CPMM creator-fee share: AmmConfig default, per-creator CreatorFeeShare override, effective rate. */
  cpmmFeeShare: CreatorFeeShareResolution | null;
  /** CPMM: LP locks created by the migration (fee-key NFTs). */
  locks: (MigrationLpLock & { holder: string | null })[];
  tokenAMint: string | null;
  tokenBMint: string | null;
  /** Human-readable reasons when not verified. */
  notes: string[];
}

export interface VerifyContext {
  base: string;
  quote: string;
  /** Bonding pool creator (DBC `pool.creator` / LaunchLab `pool.creator`). */
  bondingCreator?: string;
  /** DBC config `fee_claimer` (partner). */
  feeClaimer?: string;
  /** LaunchLab platform config facts. */
  platform?: { cpConfig?: string; platformCpCreator?: string | null; platformLockNftWallet?: string };
}

const REQUIRED: Record<MigrationKind, string[]> = {
  dbc_damm_v2: ["destinationExists", "destinationProgramIsDammV2", "ownedByExpectedProgram", "layoutMatches", "mintsMatch", "createdByDbcPoolAuthority", "pdaDerivesFromConfigAndMints", "configOwnedByDammV2", "positionsValid", "positionsResolved", "positionOwnersAreCreatorOrPartner"],
  launchlab_cpmm: ["destinationExists", "destinationProgramIsCpmm", "ownedByExpectedProgram", "layoutMatches", "mintsMatch", "configMatches", "configOwnedByCpmm", "pdaDerivesFromConfigAndMints", "poolCreatorIsCreatorOrPlatform", "locksValid"],
  dbc_damm_v1: ["supportedDestination"],
  launchlab_amm_v4: ["supportedDestination"],
};

/**
 * Prove a migration record against chain state. A migration is VERIFIED only if every required
 * check for its kind is present and true — never because the destination merely exists with the
 * right owner. Unsupported destinations (DAMM v1, AMM v4) are explicitly unverified and never enter
 * fee accounting.
 */
export async function verifyMigration(rpc: ChainRpc, m: MigrationRecord, ctx: VerifyContext): Promise<VerifiedMigration> {
  const checks: Record<string, boolean> = {};
  const out: VerifiedMigration = { ...m, supported: m.kind === "dbc_damm_v2" || m.kind === "launchlab_cpmm", checks, requiredChecks: REQUIRED[m.kind], failed: [], positionStates: [], cpmmPoolCreator: null, cpmmLpMint: null, cpmmVaults: null, cpmmEnableCreatorFee: null, cpmmCreatorFeeOnRaw: null, cpmmCreatorFeeOn: null, cpmmConfig: null, cpmmFeeShare: null, locks: [], tokenAMint: null, tokenBMint: null, notes: [] };
  const finish = () => {
    out.failed = out.requiredChecks.filter((c) => checks[c] !== true);
    return out;
  };
  if (!out.supported) {
    checks.supportedDestination = false;
    out.notes.push(`${m.kind} destinations are not supported: their account layouts and fee model are not verified in this codebase, so post-migration activity is NOT accounted (fail safe)`);
    return finish();
  }
  const { value: acc } = await rpc.getAccountInfo(m.destinationPool);
  checks.destinationExists = !!acc;
  if (!acc) return finish();
  const sameMints = (x: string, y: string) => x !== y && [x, y].includes(ctx.base) && [x, y].includes(ctx.quote);
  const pk = (s: string) => new PublicKey(s);

  if (m.kind === "dbc_damm_v2") {
    checks.destinationProgramIsDammV2 = m.destinationProgram === DAMM_V2_PROGRAM_ID;
    checks.ownedByExpectedProgram = acc.owner === DAMM_V2_PROGRAM_ID;
    checks.layoutMatches = acc.data.length === DAMM_V2_POOL_SIZE && acc.data.subarray(0, 8).equals(DAMM_V2_POOL_DISC);
    if (!checks.layoutMatches) return finish();
    const p = decodeDammV2Pool(acc.data);
    out.tokenAMint = p.tokenAMint;
    out.tokenBMint = p.tokenBMint;
    checks.mintsMatch = sameMints(p.tokenAMint, p.tokenBMint) && sameMints(m.baseMint, m.quoteMint);
    checks.createdByDbcPoolAuthority = p.creator === DBC_POOL_AUTHORITY;
    if (m.destinationConfig) {
      const [hi, lo] = Buffer.compare(pk(ctx.base).toBuffer(), pk(ctx.quote).toBuffer()) > 0 ? [ctx.base, ctx.quote] : [ctx.quote, ctx.base];
      const pda = PublicKey.findProgramAddressSync([Buffer.from("pool"), pk(m.destinationConfig).toBuffer(), pk(hi).toBuffer(), pk(lo).toBuffer()], pk(DAMM_V2_PROGRAM_ID))[0].toBase58();
      checks.pdaDerivesFromConfigAndMints = pda === m.destinationPool;
      const cfg = (await rpc.getAccountInfo(m.destinationConfig)).value;
      checks.configOwnedByDammV2 = !!cfg && cfg.owner === DAMM_V2_PROGRAM_ID && cfg.data.subarray(0, 8).equals(DAMM_V2_CONFIG_DISC);
    } else {
      checks.pdaDerivesFromConfigAndMints = false;
      checks.configOwnedByDammV2 = false;
    }
    const accounts = await rpc.getMultipleAccounts(m.positions.flatMap((x) => [x.position, x.nftAccount]));
    let valid = m.positions.length > 0;
    for (let i = 0; i < m.positions.length; i++) {
      const x = m.positions[i]!;
      const posAcc = accounts.value[i * 2];
      const nftAcc = accounts.value[i * 2 + 1];
      if (!posAcc && i > 0) continue; // the optional second position was not created
      if (!posAcc || posAcc.owner !== DAMM_V2_PROGRAM_ID || posAcc.data.length !== DAMM_V2_POSITION_SIZE || !posAcc.data.subarray(0, 8).equals(DAMM_V2_POSITION_DISC)) {
        valid = false;
        continue;
      }
      const pos = decodeDammV2Position(posAcc.data);
      if (pos.pool !== m.destinationPool || pos.nftMint !== x.nftMint) {
        valid = false;
        continue;
      }
      const fees = dammV2ClaimableFees(p, pos);
      out.positionStates.push({
        position: x.position,
        nftMint: x.nftMint,
        nftAccount: x.nftAccount,
        holder: await resolveNftHolder(rpc, x.nftMint, x.nftAccount, nftAcc),
        liquidity: pos.unlockedLiquidity + pos.vestedLiquidity + pos.permanentLockedLiquidity,
        claimableA: fees.a,
        claimableB: fees.b,
        claimedA: pos.totalClaimedAFee,
        claimedB: pos.totalClaimedBFee,
      });
    }
    checks.positionsValid = valid;
    checks.positionsResolved = out.positionStates.length > 0 && out.positionStates.every((s) => s.holder !== null);
    // The migration hands each position to the DBC pool creator or the config's fee claimer
    // (migrate_damm_v2_initialize_pool). A holder outside that set means the NFT moved since —
    // allowed, but such a position is then simply not the creator's.
    const parties = [ctx.bondingCreator, ctx.feeClaimer].filter(Boolean) as string[];
    checks.positionOwnersAreCreatorOrPartner = parties.length > 0 && out.positionStates.some((s) => s.holder !== null && parties.includes(s.holder));
  } else if (m.kind === "launchlab_cpmm") {
    checks.destinationProgramIsCpmm = m.destinationProgram === RAYDIUM_CPMM_PROGRAM_ID;
    checks.ownedByExpectedProgram = acc.owner === RAYDIUM_CPMM_PROGRAM_ID;
    checks.layoutMatches = acc.data.length === CPMM_POOL_SIZE && acc.data.subarray(0, 8).equals(CPMM_POOL_DISC);
    if (!checks.layoutMatches) return finish();
    const p = decodeCpmmPool(acc.data);
    out.tokenAMint = p.token0Mint;
    out.tokenBMint = p.token1Mint;
    out.cpmmPoolCreator = p.poolCreator;
    out.cpmmLpMint = p.lpMint;
    out.cpmmVaults = { token0: p.token0Vault, token1: p.token1Vault };
    const poolFees = decodeCpmmPoolFees(acc.data);
    out.cpmmEnableCreatorFee = poolFees.enableCreatorFee;
    out.cpmmCreatorFeeOnRaw = poolFees.creatorFeeOn;
    out.cpmmCreatorFeeOn = decodeCreatorFeeOn(poolFees.creatorFeeOn);
    if (!out.cpmmCreatorFeeOn) out.notes.push(`CPMM creator_fee_on byte ${poolFees.creatorFeeOn} is not a known mode (0 both / 1 token_0 / 2 token_1): the CPMM creator-fee basis is unresolved`);
    checks.mintsMatch = sameMints(p.token0Mint, p.token1Mint) && sameMints(m.baseMint, m.quoteMint);
    checks.configMatches = !!m.destinationConfig && p.ammConfig === m.destinationConfig && (!ctx.platform?.cpConfig || ctx.platform.cpConfig === p.ammConfig);
    const cfg = (await rpc.getAccountInfo(p.ammConfig)).value;
    checks.configOwnedByCpmm = !!cfg && cfg.owner === RAYDIUM_CPMM_PROGRAM_ID && cfg.data.length === CPMM_CONFIG_SIZE && cfg.data.subarray(0, 8).equals(CPMM_CONFIG_DISC);
    if (checks.configOwnedByCpmm) {
      const c = decodeCpmmConfig(cfg!.data);
      out.cpmmConfig = { creatorFeeRate: c.creatorFeeRate.toString(), creatorFeeShareRate: c.creatorFeeShareRate.toString(), tradeFeeRate: c.tradeFeeRate.toString() };
    }
    // The per-creator CreatorFeeShare override takes precedence over the AmmConfig default; it is read
    // at verification (slot recorded). It can be created / closed by the CPMM admin later, so the
    // observed net collection transfer remains the accounting authority; this is the validation basis.
    out.cpmmFeeShare = await readCreatorFeeShare(rpc, p.poolCreator, p.ammConfig, checks.configOwnedByCpmm ? decodeCpmmConfig(cfg!.data).creatorFeeShareRate : null).catch((e) => ({ ammConfigDefaultRate: null, overridePda: deriveCreatorFeeSharePda(p.poolCreator, p.ammConfig), override: "absent" as const, overrideRate: null, effectiveRate: null, source: "unresolved" as const, verifiedAtSlot: null, problems: [`CreatorFeeShare read failed: ${String((e as Error)?.message ?? e)}`] }));
    const [t0, t1] = Buffer.compare(pk(ctx.base).toBuffer(), pk(ctx.quote).toBuffer()) < 0 ? [ctx.base, ctx.quote] : [ctx.quote, ctx.base];
    const pda = PublicKey.findProgramAddressSync([Buffer.from("pool"), pk(p.ammConfig).toBuffer(), pk(t0).toBuffer(), pk(t1).toBuffer()], pk(RAYDIUM_CPMM_PROGRAM_ID))[0].toBase58();
    checks.pdaDerivesFromConfigAndMints = pda === m.destinationPool && p.token0Mint === t0 && p.token1Mint === t1;
    const allowedCreators = [ctx.bondingCreator, ctx.platform?.platformCpCreator].filter(Boolean) as string[];
    checks.poolCreatorIsCreatorOrPlatform = allowedCreators.includes(p.poolCreator);
    // LP locks minted at migration: each must lock THIS pool's LP mint, in a lock-program account.
    const locks = m.locks ?? [];
    let locksOk = locks.every((l) => l.pool === m.destinationPool && l.lpMint === p.lpMint);
    if (locks.length) {
      const la = await rpc.getMultipleAccounts(locks.flatMap((l) => [l.lockPda, l.nftAccount]));
      for (let i = 0; i < locks.length; i++) {
        const l = locks[i]!;
        const lockAcc = la.value[i * 2];
        if (!lockAcc || lockAcc.owner !== RAYDIUM_CP_LOCK_PROGRAM_ID) locksOk = false;
        out.locks.push({ ...l, holder: await resolveNftHolder(rpc, l.nftMint, l.nftAccount, la.value[i * 2 + 1]) });
      }
    }
    checks.locksValid = locksOk;
  }
  return finish();
}

export function migrationVerified(v: VerifiedMigration): boolean {
  return v.supported && v.requiredChecks.length > 0 && v.requiredChecks.every((c) => v.checks[c] === true);
}
