/** Public, browser-safe configuration. Never put secrets in NEXT_PUBLIC_* variables. */
export const PUBLIC_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Asteroid Protocol";
export const EXPLORER = process.env.NEXT_PUBLIC_SOLANA_EXPLORER ?? "https://solscan.io";
/** Server-side only: the API as reachable from the Next.js server (may be a private address). */
export const INTERNAL_API_URL = (process.env.API_INTERNAL_URL ?? PUBLIC_API_URL).replace(/\/$/, "");
