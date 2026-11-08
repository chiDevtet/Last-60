/**
 * Operator recovery of an unresolved Forge creator-distribution attribution (docs/REWARD_FUNDING.md §15).
 *
 * Recovery is permission to RE-RUN verification, never permission to override it. An authenticated
 * operator selects ONE unresolved `funding_attributions` row; this module then:
 *
 *   1. checks the attribution is genuinely unresolved, of this launch, not recovered, not credited;
 *   2. requires complete indexing coverage of the launch's attribution addresses through the payout
 *      slot, and that the payout slot is finalized;
 *   3. re-runs the NORMAL deterministic attribution (`evaluateForgeDistribution` →
 *      `attributeForgeDistribution`) over the indexed history — every launch, wallet, harvest-sequence,
 *      slot-ordering, exclusivity, alternation, mint, amount-bound and correlation check applies unchanged;
 *   4. only if that yields a linked leg (and the linked harvest and payout are finalized and successful
 *      on-chain) writes the credit through the normal `writeCredit` — which alone decides payability —
 *      inside a MongoDB transaction that re-checks the attribution, the absence of a credit and the
 *      collection's other credits;
 *   5. otherwise leaves the attribution unresolved.
 *
 * The original decision (status, reasons, candidates, evidence) is never rewritten: a linked recovery
 * only sets the one-time `recovery` pointer, and every request — accepted, still unresolved or rejected —
 * is recorded as an append-only `attribution_recoveries` row. The request carries no amount, eligibility,
 * collection key, status or correlation: any such field is refused.
 */
import type { Models } from "../db/models";
import { inTransaction } from "../db/connection";
import type { ChainRpc } from "../chain/rpc";
import type { LaunchProvider } from "../providers/LaunchProvider";
import { randomToken } from "../util/crypto";
import { FORGE_CREATOR_DISTRIBUTION, policySnapshot } from "../accounting/revenueStreams";
import { evaluateForgeDistribution, forgeCoverage, forgeLaunchContextOf, linkedTotals, preActivationAbsorption, writeCredit, type RevenueRuntime } from "../revenue/ingest";

export const RECOVERY_ALGORITHM = "attributeForgeDistribution/forge_distribution_sequence (PR #8), re-run unchanged";
const REQUEST_ID_RE = /^rr_[A-Za-z0-9_-]{8,64}$/;
const ALLOWED_FIELDS = new Set(["attributionKey", "operator", "requestId", "note"]);

export interface RecoveryRequest {
  attributionKey: string;
  operator: string;
  /** Optional client idempotency key (`rr_…`); a repeated request returns the recorded result. */
  requestId?: string;
  note?: string;
}

export interface RecoveryDeps {
  db: Models;
  /** The configured launch (or a lazy loader, resolved only once the request passes the first checks). */
  provider: LaunchProvider | (() => Promise<LaunchProvider>);
  runtime: RevenueRuntime;
  rpc: Pick<ChainRpc, "getSlot" | "getSignatureStatuses">;
  /** LAST60_ATTRIBUTION_RECOVERY_ENABLED. */
  enabled: boolean;
  now?: () => number;
}

export class RecoveryError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RecoveryError";
  }
}

class Abort extends Error {}

/** Run one recovery request. Always returns the (append-only) audit record that was written. */
export async function recoverAttribution(d: RecoveryDeps, req: RecoveryRequest): Promise<any> {
  const now = d.now ?? (() => Date.now());
  const requestedAt = new Date(now());
  if (!req || typeof req !== "object") throw new RecoveryError("invalid_request");
  if (typeof req.operator !== "string" || !req.operator.trim()) throw new RecoveryError("operator_identity_required");
  if (typeof req.attributionKey !== "string" || !req.attributionKey.trim() || req.attributionKey.length > 500) throw new RecoveryError("invalid_attribution_key");
  if (req.requestId !== undefined && !REQUEST_ID_RE.test(req.requestId)) throw new RecoveryError("invalid_request_id");
  const requestId = req.requestId ?? `rr_${randomToken(16)}`;

  // Idempotent replay of a request id.
  const prior: any = await d.db.AttributionRecovery.findOne({ requestId }).lean();
  if (prior) {
    if (prior.attributionKey !== req.attributionKey) throw new RecoveryError("request_id_reused_for_another_attribution");
    return prior;
  }

  const base: Record<string, unknown> = { requestId, attributionKey: req.attributionKey, operator: req.operator, requestedAt, note: typeof req.note === "string" ? req.note.slice(0, 500) : null, original: null, evaluation: null, resultReasons: [], linkedHarvestSignature: null, linkedHarvestSlot: null, previousHarvestSignature: null, rewardFundingKey: null, payoutEligible: false, transactions: null, failureReason: null };
  const record = async (o: Record<string, unknown>) => {
    const doc = { ...base, ...o, completedAt: new Date(now()) };
    try {
      await d.db.AttributionRecovery.create(doc);
    } catch (err: any) {
      if (err?.code === 11000) return d.db.AttributionRecovery.findOne({ requestId }).lean();
      throw err;
    }
    return doc;
  };
  const reject = (failureReason: string, extra: Record<string, unknown> = {}) => record({ outcome: "rejected", failureReason, resultReasons: [failureReason], ...extra });

  // Recovery never accepts an amount, eligibility, collection key, status or correlation.
  const extra = Object.keys(req).filter((k) => !ALLOWED_FIELDS.has(k));
  if (extra.length) return reject(`override_fields_not_allowed: ${extra.join(",").slice(0, 200)} (recovery re-runs verification; it never accepts amounts, eligibility, collection keys, status or correlation)`);
  if (!d.enabled) return reject("recovery_disabled (LAST60_ATTRIBUTION_RECOVERY_ENABLED=false)");

  const att: any = await d.db.FundingAttribution.findOne({ key: req.attributionKey }).lean();
  if (!att) return reject("unknown_attribution");
  base.original = { status: att.status, reasons: att.reasons ?? [], candidates: att.candidates ?? [], evidence: att.evidence ?? null, evaluatedAt: att.evaluatedAt ?? null, evaluations: att.evaluations ?? 0, signature: att.signature, slot: att.slot, ordinal: att.ordinal, asset: att.asset, amount: String(att.amount), sourcePool: att.sourcePool, tokenMint: att.tokenMint, sourceOwner: att.sourceOwner, destinationOwner: att.destinationOwner };
  base.transactions = { distribution: { signature: att.signature, slot: att.slot } };
  if (att.route !== FORGE_CREATOR_DISTRIBUTION) return reject("not_a_forge_creator_distribution");
  if (att.status !== "unresolved") return reject(`not_unresolved: status is ${att.status}`);
  if (att.recovery) return reject("already_recovered");
  const provider = typeof d.provider === "function" ? await d.provider() : d.provider;
  const info = provider.info();
  if (att.sourcePool !== info.poolAddress) return reject(`wrong_launch: attribution belongs to ${att.sourcePool}, the configured launch is ${info.poolAddress}`);
  const forge = forgeLaunchContextOf(provider, d.runtime);
  if (!forge) return reject("forge_attribution_context_unavailable (FORGE_PLATFORM_LP_BENEFICIARY, verified LaunchLab → CPMM migration and creator required)");
  if (att.tokenMint !== forge.tokenMint) return reject("wrong_launch_token");
  if (await d.db.RewardFunding.exists({ key: att.key })) return reject("existing_reward_funding_credit");

  // Complete, finalized indexing coverage of the historical window (through the payout slot).
  const covered = await forgeCoverage(d.db, forge);
  let finalizedSlot: number | null = null;
  try {
    finalizedSlot = await d.rpc.getSlot("finalized");
  } catch {
    finalizedSlot = null;
  }
  const evaluation: Record<string, unknown> = { algorithm: RECOVERY_ALGORITHM, policy: policySnapshot(d.runtime.policy), coverageKeys: forge.coverageKeys, coveredThroughSlot: covered, finalizedSlot, distributionSignature: att.signature, distributionSlot: att.slot, forgeWallet: forge.forgeWallet, creator: forge.creator, tokenMint: forge.tokenMint };
  base.evaluation = evaluation;
  if (covered === null || covered < att.slot) return reject(`indexing_coverage_incomplete: covered through ${covered ?? "unknown"}, payout slot ${att.slot}`);
  if (finalizedSlot === null) return reject("finality_unverifiable: RPC unavailable");
  if (finalizedSlot < att.slot) return reject(`distribution_not_finalized: finalized slot ${finalizedSlot} < payout slot ${att.slot}`);

  // Re-run the normal attribution, read-only.
  const launch = { sourcePool: info.poolAddress, quoteMint: info.quoteMint, provider: info.provider, tokenMint: info.tokenMint };
  const absorbed = await preActivationAbsorption(d.db, launch, d.runtime.policy);
  const ev = await evaluateForgeDistribution(d.db, launch, forge, absorbed, att.signature, covered, null);
  if (!ev) return reject("distribution_events_missing");
  Object.assign(evaluation, { harvestCandidates: ev.harvestCandidates, windowTruncated: ev.windowTruncated });
  const dcs = ev.decisions.get(att.key);
  if (dcs?.attribution) evaluation.attributionOutcome = dcs.attribution.outcome;
  if (!dcs || dcs.status !== "linked" || !dcs.plan) {
    return record({ outcome: "still_unresolved", resultReasons: dcs?.reasons?.length ? dcs.reasons : ["normal attribution did not produce a linked result"], failureReason: dcs?.status === "pending" ? "evidence_incomplete" : "attribution_still_unresolved" });
  }
  const plan = dcs.plan;
  const harvest = plan.col.signature as string;
  const linkedInfo = { linkedHarvestSignature: harvest, linkedHarvestSlot: plan.col.slot as number, previousHarvestSignature: dcs.attribution?.outcome === "linked" ? dcs.attribution.previousHarvest : null };
  base.transactions = { distribution: { signature: att.signature, slot: att.slot }, harvest: { signature: harvest, slot: plan.col.slot }, ...(linkedInfo.previousHarvestSignature ? { previousHarvest: { signature: linkedInfo.previousHarvestSignature } } : {}) };

  // The linked evidence itself must be finalized and successful on-chain.
  const sigs = [...new Set([att.signature, harvest])];
  let statuses: Awaited<ReturnType<RecoveryDeps["rpc"]["getSignatureStatuses"]>> = [];
  try {
    statuses = await d.rpc.getSignatureStatuses(sigs, true);
  } catch {
    return reject("finality_unverifiable: RPC unavailable", linkedInfo);
  }
  const notFinal = sigs.filter((_, i) => !statuses[i] || statuses[i]!.err || statuses[i]!.confirmationStatus !== "finalized");
  if (notFinal.length) return record({ outcome: "still_unresolved", ...linkedInfo, resultReasons: [`linked_evidence_not_finalized: ${notFinal.join(",")}`], failureReason: "linked_evidence_not_finalized" });

  const recoveryEvidence = { requestId, operator: req.operator, algorithm: RECOVERY_ALGORITHM, coveredThroughSlot: covered, finalizedSlot, originalReasons: att.reasons ?? [] };
  try {
    const out = await inTransaction(d.db, async (session) => {
      const cur: any = await d.db.FundingAttribution.findOne({ key: att.key }, null, { session }).lean();
      if (!cur || cur.status !== "unresolved") throw new Abort(`state_changed: status is ${cur?.status ?? "missing"}`);
      if (cur.recovery) throw new Abort("already_recovered");
      if (await d.db.RewardFunding.exists({ key: att.key }).session(session)) throw new Abort("existing_reward_funding_credit");
      const now2 = (await linkedTotals(d.db, [plan.col.key], plan.excludeKeys, session)).get(plan.col.key)?.creditable ?? 0n;
      if (now2 !== plan.alreadyCreditable) throw new Abort(`collection_credits_changed: ${now2} ≠ ${plan.alreadyCreditable} at evaluation; re-run the recovery`);
      const w = await writeCredit(d.db, launch, d.runtime, plan.t, plan.col, plan.fact, plan.method, plan.alreadyCreditable, { ...plan.o, attribution: { ...(plan.o.attribution ?? { method: plan.method }), recovery: recoveryEvidence }, session });
      if (!w.inserted) throw new Abort(`credit_not_written: ${w.reasons.join(" | ")}`);
      const credit: any = await d.db.RewardFunding.findOne({ key: att.key }, { payoutEligible: 1, ineligibleReason: 1, collectionKey: 1 }, { session }).lean();
      const outcome = credit?.payoutEligible ? "linked" : "linked_not_payable";
      const u = await d.db.FundingAttribution.updateOne({ key: att.key, status: "unresolved", recovery: null }, { $set: { recovery: { requestId, outcome, rewardFundingKey: att.key, collectionKey: credit?.collectionKey ?? null, payoutEligible: !!credit?.payoutEligible, at: new Date(now()), operator: req.operator } } }, { session });
      if (!u.modifiedCount) throw new Abort("already_recovered");
      const doc = { ...base, ...linkedInfo, outcome, resultReasons: credit?.ineligibleReason ? String(credit.ineligibleReason).split(" | ") : [], rewardFundingKey: att.key, payoutEligible: !!credit?.payoutEligible, completedAt: new Date(now()) };
      await d.db.AttributionRecovery.create([doc], { session });
      return doc;
    });
    return out;
  } catch (err) {
    if (err instanceof Abort) return reject(err.message, linkedInfo);
    if ((err as any)?.code === 11000) return reject("concurrent_or_duplicate_write", linkedInfo);
    throw err;
  }
}
