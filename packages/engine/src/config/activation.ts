/**
 * Automatic activation slot of the forge_phase_aware_v2 funding policy (the default policy).
 *
 * With REWARD_FUNDING_POLICY_ACTIVATION_SLOT unset, the slot is pinned ONCE — to the finalized slot at
 * the first start of any Last-60 process — and persisted in `system_state.funding_policy_activation`.
 * Every later start of every process (indexer, rewards, API, CLI) reads the same value, so they all
 * agree on which collections, transfers and rounds the approved model governs.
 *
 * Pinning at the deployment that enables the policy is exactly the documented rule ("set it at or after
 * the switch-over"): fees accrued before it were distributed under the legacy policy and are absorbed
 * (never funded twice), and no historical claim can become creditable retroactively.
 */
import type { AppConfig } from "./env";
import type { ChainRpc } from "../chain/rpc";
import type { Models } from "../db/models";
import { CURRENT_PHASE_AWARE_VERSION, makeFundingPolicy } from "../accounting/revenueStreams";

export const FUNDING_ACTIVATION_STATE_ID = "funding_policy_activation";

export interface FundingActivation {
  slot: number | null;
  source: AppConfig["revenue"]["activation"]["source"];
  /** True when this call pinned the slot (first start). */
  pinnedNow: boolean;
  pinnedAt: Date | null;
}

/** Resolve (and if needed pin) the activation slot; updates `cfg.revenue.policy` in place. Idempotent and race-safe. */
export async function resolveFundingActivation(cfg: AppConfig, db: Models, rpc: Pick<ChainRpc, "getSlot">): Promise<FundingActivation> {
  const act = cfg.revenue.activation;
  if (act.source !== "auto") return { slot: cfg.revenue.policy.activationSlot, source: act.source, pinnedNow: false, pinnedAt: null };
  const read = async () => {
    const doc: any = await db.SystemState.findById(FUNDING_ACTIVATION_STATE_ID).lean();
    const v = doc?.value;
    return v && v.version === CURRENT_PHASE_AWARE_VERSION && Number.isInteger(v.slot) && v.slot >= 0 ? { slot: v.slot as number, at: v.pinnedAt ? new Date(v.pinnedAt) : null } : null;
  };
  let pinned = await read();
  let pinnedNow = false;
  if (!pinned) {
    const slot = await rpc.getSlot("finalized");
    if (!Number.isInteger(slot) || slot < 0) throw new Error(`cannot pin the funding policy activation slot: RPC returned ${slot}`);
    const at = new Date();
    try {
      const r = await db.SystemState.updateOne(
        { _id: FUNDING_ACTIVATION_STATE_ID },
        { $setOnInsert: { value: { version: CURRENT_PHASE_AWARE_VERSION, slot, pinnedAt: at.toISOString(), pinnedBy: cfg.instanceId }, updatedAt: at } },
        { upsert: true },
      );
      pinnedNow = !!r.upsertedCount;
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // a concurrent first start pinned it: read theirs
    }
    pinned = await read();
    if (!pinned) throw new Error(`system_state.${FUNDING_ACTIVATION_STATE_ID} exists but does not hold a ${CURRENT_PHASE_AWARE_VERSION} slot; set REWARD_FUNDING_POLICY_ACTIVATION_SLOT explicitly`);
  }
  const { id: _id, ...rest } = cfg.revenue.policy;
  cfg.revenue.policy = makeFundingPolicy({ ...rest, activationSlot: pinned.slot });
  cfg.revenue.activation = { source: "auto", pending: false };
  return { slot: pinned.slot, source: "auto", pinnedNow, pinnedAt: pinned.at };
}
