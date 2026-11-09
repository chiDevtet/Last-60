/**
 * Raydium LaunchLab addresses that are deterministic before launch (no RPC, no heavy imports).
 *
 * The bonding-curve pool is the PDA ["pool", base_mint, quote_mint] of the LaunchLab program (bundled IDL,
 * `initialize` / `initialize_v2` / `initialize_with_token_2022`: `pool_state`). Knowing the token mint
 * (and the quote mint — WSOL for SOL-quoted Forgepad launches) is therefore enough to know the pool
 * address before the pool exists; the indexer and rewards worker wait until it is created.
 */
import { PublicKey } from "@solana/web3.js";
import { WSOL_MINT } from "@last60/shared";

export const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

/** The LaunchLab bonding-curve pool of `tokenMint` quoted in `quoteMint` (default: SOL). Throws on an invalid key. */
export function deriveLaunchLabPool(tokenMint: string, quoteMint: string = WSOL_MINT): string {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), new PublicKey(tokenMint).toBuffer(), new PublicKey(quoteMint).toBuffer()], new PublicKey(LAUNCHLAB_PROGRAM))[0].toBase58();
}
