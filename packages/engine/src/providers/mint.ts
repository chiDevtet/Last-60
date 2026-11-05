import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { ChainRpc } from "../chain/rpc";
import { ProviderValidationError } from "./LaunchProvider";

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);

/** Reads decimals + owning token program of a mint (SPL Token and Token-2022 share the base layout). */
export async function readMint(rpc: ChainRpc, mint: string): Promise<{ decimals: number; program: string }> {
  const { value } = await rpc.getAccountInfo(mint);
  if (!value) throw new ProviderValidationError(`Mint ${mint} not found`);
  if (!TOKEN_PROGRAMS.has(value.owner)) throw new ProviderValidationError(`Account ${mint} is not a token mint (owner ${value.owner})`);
  if (value.data.length < 82) throw new ProviderValidationError(`Mint ${mint} has invalid data length`);
  return { decimals: value.data[44]!, program: value.owner };
}
