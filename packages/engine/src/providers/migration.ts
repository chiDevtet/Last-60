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
        return { ...base, kind: "launchlab_cpmm", destinationProgram: a[4]!, destinationPool: a[5]!, destinationConfig: a[10] ?? null, baseMint: a[1]!, quoteMint: a[2]!, positions: [] };
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
function decodeTokenAccount(d: Buffer) {
  return { mint: key(d, 0), owner: key(d, 32), amount: u64(d, 64) };
}

export interface VerifiedMigration extends MigrationRecord {
  checks: Record<string, boolean>;
  /** DAMM v2: each migration position with its current NFT holder and claimable fees. */
  positionStates: { position: string; holder: string | null; liquidity: bigint; claimableA: bigint; claimableB: bigint; claimedA: bigint; claimedB: bigint }[];
  /** CPMM: the wallet receiving the CPMM creator fee. */
  cpmmPoolCreator: string | null;
  tokenAMint: string | null;
  tokenBMint: string | null;
}

/**
 * Prove a migration record against current chain state. Every check must pass before any
 * post-graduation adapter may attribute fees from the destination pool.
 */
export async function verifyMigration(rpc: ChainRpc, m: MigrationRecord, mints: { base: string; quote: string }): Promise<VerifiedMigration> {
  const checks: Record<string, boolean> = {};
  const out: VerifiedMigration = { ...m, checks, positionStates: [], cpmmPoolCreator: null, tokenAMint: null, tokenBMint: null };
  const { value: acc } = await rpc.getAccountInfo(m.destinationPool);
  checks.destinationExists = !!acc;
  if (!acc) return out;
  checks.ownedByExpectedProgram = acc.owner === m.destinationProgram && [DAMM_V2_PROGRAM_ID, DAMM_V1_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_AMM_V4_PROGRAM_ID].includes(acc.owner);
  const sameMints = (x: string, y: string) => new Set([x, y]).size === 2 && [x, y].includes(mints.base) && [x, y].includes(mints.quote);
  const pk = (s: string) => new PublicKey(s);
  const [hi, lo] = Buffer.compare(pk(mints.base).toBuffer(), pk(mints.quote).toBuffer()) > 0 ? [mints.base, mints.quote] : [mints.quote, mints.base];

  if (m.kind === "dbc_damm_v2") {
    const p = decodeDammV2Pool(acc.data);
    out.tokenAMint = p.tokenAMint;
    out.tokenBMint = p.tokenBMint;
    checks.mintsMatch = sameMints(p.tokenAMint, p.tokenBMint);
    checks.createdByDbcPoolAuthority = p.creator === DBC_POOL_AUTHORITY;
    if (m.destinationConfig) {
      const pda = PublicKey.findProgramAddressSync([Buffer.from("pool"), pk(m.destinationConfig).toBuffer(), pk(hi).toBuffer(), pk(lo).toBuffer()], pk(DAMM_V2_PROGRAM_ID))[0].toBase58();
      checks.pdaDerivesFromConfigAndMints = pda === m.destinationPool;
    }
    const accounts = await rpc.getMultipleAccounts(m.positions.flatMap((x) => [x.position, x.nftAccount]));
    m.positions.forEach((x, i) => {
      const posAcc = accounts.value[i * 2];
      const nftAcc = accounts.value[i * 2 + 1];
      if (!posAcc || posAcc.owner !== DAMM_V2_PROGRAM_ID) return; // second position not created
      const pos = decodeDammV2Position(posAcc.data);
      if (pos.pool !== m.destinationPool || pos.nftMint !== x.nftMint) {
        checks[`position:${x.position}`] = false;
        return;
      }
      const nft = nftAcc ? decodeTokenAccount(nftAcc.data) : null;
      const fees = dammV2ClaimableFees(p, pos);
      out.positionStates.push({
        position: x.position,
        holder: nft && nft.mint === x.nftMint && nft.amount === 1n ? nft.owner : null, // null: NFT moved — resolve via the mint's largest holder
        liquidity: pos.unlockedLiquidity + pos.vestedLiquidity + pos.permanentLockedLiquidity,
        claimableA: fees.a,
        claimableB: fees.b,
        claimedA: pos.totalClaimedAFee,
        claimedB: pos.totalClaimedBFee,
      });
    });
    checks.positionsResolved = out.positionStates.length > 0;
  } else if (m.kind === "launchlab_cpmm") {
    const p = decodeCpmmPool(acc.data);
    out.tokenAMint = p.token0Mint;
    out.tokenBMint = p.token1Mint;
    out.cpmmPoolCreator = p.poolCreator;
    checks.mintsMatch = sameMints(p.token0Mint, p.token1Mint);
    if (m.destinationConfig) {
      checks.configMatches = p.ammConfig === m.destinationConfig;
      const [t0, t1] = Buffer.compare(pk(mints.base).toBuffer(), pk(mints.quote).toBuffer()) < 0 ? [mints.base, mints.quote] : [mints.quote, mints.base];
      const pda = PublicKey.findProgramAddressSync([Buffer.from("pool"), pk(p.ammConfig).toBuffer(), pk(t0).toBuffer(), pk(t1).toBuffer()], pk(RAYDIUM_CPMM_PROGRAM_ID))[0].toBase58();
      checks.pdaDerivesFromConfigAndMints = pda === m.destinationPool;
    }
  }
  return out;
}

export function migrationVerified(v: VerifiedMigration): boolean {
  const vals = Object.values(v.checks);
  return vals.length > 0 && vals.every(Boolean);
}
