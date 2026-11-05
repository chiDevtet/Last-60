import { explorerAccountUrl, explorerTxUrl } from "@last60/shared";
export const txUrl = (explorer: string, sig: string, cluster: string) => explorerTxUrl(explorer, sig, cluster);
export const accountUrl = (explorer: string, addr: string, cluster: string) => explorerAccountUrl(explorer, addr, cluster);
