/**
 * READ-ONLY verification of a Raydium LaunchLab PlatformConfig account (and the CPMM AmmConfig it
 * names). Uses getAccountInfo only; nothing is signed or sent.
 */
import type { ChainRpc } from "../chain/rpc";
import { CPMM_CONFIG_DISC, CPMM_CONFIG_SIZE, decodeCpmmConfig, RAYDIUM_CPMM_PROGRAM_ID } from "../providers/migration";
import { decodeLaunchLabPool, LAUNCHLAB_PROGRAM_ID, validateLaunchLabPlatformConfig, type LaunchLabPlatformConfig } from "../providers/raydium/RaydiumLaunchLabProvider";
import { explainPlatformConfig, interpretPlatformConfig, type CpmmConfigFacts, type FeeStreamInterpretation, type FieldExplanation } from "./launchlabPlatform";

export type PlatformCheckCode = "ok" | "missing" | "wrong_owner" | "unsupported_layout" | "invalid_values" | "cpmm_config_invalid" | "pool_not_bound";

/** Process exit code per outcome (0 = decoded and validated). */
export const PLATFORM_CHECK_EXIT: Record<PlatformCheckCode, number> = { ok: 0, missing: 2, wrong_owner: 3, unsupported_layout: 4, invalid_values: 4, cpmm_config_invalid: 5, pool_not_bound: 6 };

export interface PlatformCheckResult {
  address: string;
  code: PlatformCheckCode;
  slot: number;
  owner: string | null;
  size: number;
  config: LaunchLabPlatformConfig | null;
  cpmm: CpmmConfigFacts | null;
  fields: FieldExplanation[];
  streams: FeeStreamInterpretation[];
  pool: { address: string; platformConfig: string; creator: string; status: number; bound: boolean } | null;
  problems: string[];
  notes: string[];
}

export async function checkLaunchLabPlatformConfig(rpc: ChainRpc, address: string, opts: { pool?: string | null } = {}): Promise<PlatformCheckResult> {
  const { slot, value } = await rpc.getAccountInfo(address, "finalized");
  const v = validateLaunchLabPlatformConfig(value ? { owner: value.owner, data: value.data } : null);
  const base: PlatformCheckResult = { address, code: v.code, slot, owner: value?.owner ?? null, size: value?.data.length ?? 0, config: v.config, cpmm: null, fields: [], streams: [], pool: null, problems: [...v.problems], notes: [] };
  if (!v.config || v.code !== "ok") return base;
  const c = v.config;
  // CPMM AmmConfig named by cpswap_config: sets the post-graduation trade and creator fee rates.
  const cfg = c.cpConfig ? (await rpc.getAccountInfo(c.cpConfig, "finalized")).value : null;
  if (!cfg || cfg.owner !== RAYDIUM_CPMM_PROGRAM_ID || cfg.data.length !== CPMM_CONFIG_SIZE || !cfg.data.subarray(0, 8).equals(CPMM_CONFIG_DISC)) {
    base.code = "cpmm_config_invalid";
    base.problems.push(`cpswap_config ${c.cpConfig ?? "?"} is not a Raydium CPMM AmmConfig (${cfg ? `owner ${cfg.owner}, ${cfg.data.length} bytes` : "missing"})`);
  } else {
    const d = decodeCpmmConfig(cfg.data);
    base.cpmm = { address: c.cpConfig!, ...d };
  }
  base.fields = explainPlatformConfig(c);
  base.streams = interpretPlatformConfig(c, base.cpmm);
  base.notes.push("the protocol trade fee rate is set by the GlobalConfig a launch selects (restrict_global_config decides which are allowed) and the referral share by each trade — both launch / trade specific");
  if (c.platformLockNftWallet === c.platformFeeWallet) base.notes.push("platform_nft_wallet = platform_fee_wallet: if this wallet is ever a token creator, its locked-LP Fee Keys are still platform-owned and are never attributed to it as creator");
  if ((c.creatorScale ?? 0n) > 0n) base.notes.push(`creator_scale ${c.creatorScale} > 0: this config predates the 2026-08-17 creator_scale = 0 rule (the program would reject it on create / MigrateNftInfo update); migrations now add it to the platform Fee Key`);
  if (opts.pool) {
    const p = (await rpc.getAccountInfo(opts.pool, "finalized")).value;
    if (!p || p.owner !== LAUNCHLAB_PROGRAM_ID) {
      base.code = "pool_not_bound";
      base.problems.push(`pool ${opts.pool} is not a LaunchLab PoolState`);
    } else {
      const ps = decodeLaunchLabPool(p.data);
      base.pool = { address: opts.pool, platformConfig: ps.platformConfig, creator: ps.creator, status: ps.status, bound: ps.platformConfig === address };
      if (!base.pool.bound) {
        base.code = "pool_not_bound";
        base.problems.push(`pool ${opts.pool} is bound to PlatformConfig ${ps.platformConfig}, not ${address}`);
      } else base.notes.push(`pool ${opts.pool} is bound to this PlatformConfig; its creator (bonding-curve and default CPMM creator-fee beneficiary) is ${ps.creator}; status ${ps.status === 0 ? "bonding" : ps.status === 1 ? "migrating" : "migrated"}`);
    }
  }
  return base;
}
