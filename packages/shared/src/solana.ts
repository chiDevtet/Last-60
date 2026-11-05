export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function shortAddress(address: string, head = 4, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function explorerTxUrl(explorer: string, signature: string, cluster: string): string {
  const base = explorer.replace(/\/$/, "");
  const q = cluster && cluster !== "mainnet-beta" ? `?cluster=${cluster}` : "";
  return `${base}/tx/${signature}${q}`;
}

export function explorerAccountUrl(explorer: string, address: string, cluster: string): string {
  const base = explorer.replace(/\/$/, "");
  const q = cluster && cluster !== "mainnet-beta" ? `?cluster=${cluster}` : "";
  return `${base}/account/${address}${q}`;
}
