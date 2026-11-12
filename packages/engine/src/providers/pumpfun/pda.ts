/**
 * pump.fun addresses derived from the token mint and the coin creator (seeds from the official IDLs,
 * `pump` and `pump_amm`, vendored in `./idl` and `../destination/idl`; cross-checked on mainnet accounts).
 *
 *   bonding curve              ["bonding-curve", mint]                              pump
 *   creator vault (lamports)   ["creator-vault", creator]                           pump
 *   pool authority             ["pool-authority", mint]                             pump
 *   canonical PumpSwap pool    ["pool", u16 LE 0, pool_authority, mint, quote]      pump_amm
 *   coin creator vault auth    ["creator_vault", coin_creator]                      pump_amm
 *   coin creator vault         the vault authority's associated token account of the quote mint
 *
 * Both creator vaults are keyed by the CREATOR, not by the coin: every coin of one creator pays into
 * the same two vaults.
 */
import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WSOL_MINT } from "@last60/shared";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP = new PublicKey(PUMP_PROGRAM_ID);
const PUMP_AMM = new PublicKey(PUMP_AMM_PROGRAM_ID);

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const PUMP_GLOBAL = pda([Buffer.from("global")], PUMP).toBase58();
export const PUMP_EVENT_AUTHORITY = pda([Buffer.from("__event_authority")], PUMP).toBase58();
export const PUMP_AMM_GLOBAL_CONFIG = pda([Buffer.from("global_config")], PUMP_AMM).toBase58();
export const PUMP_AMM_EVENT_AUTHORITY = pda([Buffer.from("__event_authority")], PUMP_AMM).toBase58();

/** The bonding curve of `tokenMint` (exists from the coin's creation; kept after graduation). Throws on an invalid key. */
export function derivePumpBondingCurve(tokenMint: string): string {
  return pda([Buffer.from("bonding-curve"), new PublicKey(tokenMint).toBuffer()], PUMP).toBase58();
}

/** Bonding-curve creator vault: a system account holding the creator's SOL fees of ALL their coins. */
export function pumpCreatorVault(creator: string): string {
  return pda([Buffer.from("creator-vault"), new PublicKey(creator).toBuffer()], PUMP).toBase58();
}

export function pumpPoolAuthority(tokenMint: string): string {
  return pda([Buffer.from("pool-authority"), new PublicKey(tokenMint).toBuffer()], PUMP).toBase58();
}

/** The PumpSwap pool a pump.fun coin graduates into (index 0, created by the coin's pool authority). */
export function canonicalPumpSwapPool(tokenMint: string, quoteMint: string = WSOL_MINT): string {
  const index = Buffer.alloc(2); // u16 LE 0
  return pda([Buffer.from("pool"), index, new PublicKey(pumpPoolAuthority(tokenMint)).toBuffer(), new PublicKey(tokenMint).toBuffer(), new PublicKey(quoteMint).toBuffer()], PUMP_AMM).toBase58();
}

export function pumpSwapCreatorVaultAuthority(coinCreator: string): string {
  return pda([Buffer.from("creator_vault"), new PublicKey(coinCreator).toBuffer()], PUMP_AMM).toBase58();
}

/** PumpSwap coin-creator vault: the vault authority's token account of the quote mint (WSOL for SOL pools). */
export function pumpSwapCreatorVaultAta(coinCreator: string, quoteMint: string = WSOL_MINT, quoteTokenProgram: string = TOKEN_PROGRAM_ID.toBase58()): string {
  return getAssociatedTokenAddressSync(new PublicKey(quoteMint), new PublicKey(pumpSwapCreatorVaultAuthority(coinCreator)), true, new PublicKey(quoteTokenProgram), ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
}
