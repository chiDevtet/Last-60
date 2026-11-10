/**
 * Physical custody of credited Last-60 contributions (docs/REWARD_FUNDING.md §14).
 *
 * Four things are kept strictly apart:
 *   1. economic contribution — the `reward_funding` credit (who contributed, attributed by PR #6–#8);
 *   2. physical custody      — a verified SOL transfer of that contribution into the dedicated payout
 *                              wallet (`custody_transfers`, this module);
 *   3. round funding         — a round consuming the credit (scheduler, only once 1 and 2 hold);
 *   4. buyer payout          — the payout executor signing the round's payouts.
 *
 * A custody transfer is NEVER a reward contribution. It is bound to exactly one existing credit, never
 * credits more than that credit's outstanding (not yet custodied) amount, and its on-chain transfer is
 * reserved in `transfer_uses` so it can never also be counted as a contribution (or vice versa).
 *
 * By default Last-60 does not control creator wallets: a custody transfer is creator- (or custodian-)
 * initiated. When the operator configures the launch creator's own key in the rewards worker
 * (creator/creatorWallet.ts), the creator wallet automation opens the request and signs the sweep itself —
 * through exactly the same request, verification and binding below. Otherwise the operator opens a sweep
 * request for one credit; the custodian
 * sends exactly that SOL to the payout wallet (ideally with the memo `last60:custody:v1:<custodyId>`,
 * which the indexer matches automatically); or the operator submits the transaction signature. Either
 * way the transfer is verified from the chain: finalized, successful, native SOL System transfer, from
 * the custodian, to the payout wallet, after the contribution, transfer-only transaction, not used
 * before. A balance increase alone is never evidence.
 */
import type { ClientSession } from "mongoose";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import { inTransaction } from "../db/connection";
import type { ChainRpc } from "../chain/rpc";
import { normalizeTransaction, decodeTokenTransfer, tokenAccountInfo, type NormalizedTx } from "../chain/tx";
import { COMPUTE_BUDGET_PROGRAM_ID, custodyMemosOf, decodeSystemTransfer, MEMO_PROGRAM_IDS, SYSTEM_PROGRAM_ID } from "../revenue/decode";
import { CURRENT_PHASE_AWARE_VERSION, CUSTODY_ID_RE, CUSTODY_MEMO_PREFIX, FORGE_CREATOR_DISTRIBUTION, WSOL_MINT } from "../accounting/revenueStreams";
import { randomToken } from "../util/crypto";

export const transferKeyOf = (signature: string, ordinal: number) => `${signature}:${ordinal}`;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/** Custody rows whose credited amount counts against the contribution (bound and not failed). */
export const BOUND_CUSTODY_STATUSES = ["awaiting_finality", "reconciled", "partial"] as const;
/** Custody rows that make SOL available for rounds (also requires confirmationStatus finalized). */
export const SETTLED_CUSTODY_STATUSES = ["reconciled", "partial"] as const;
/** A bound transfer whose signature is still unknown this long after binding is treated as dropped. */
const DROP_AFTER_MS = 15 * 60_000;

export class CustodyError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CustodyError";
  }
}

export interface CustodySettings {
  enabled: boolean;
  payoutWallet: string | null;
  requestTtlMs?: number;
}

// ── transfer uses: one on-chain transfer, one use ────────────────────────────────────────────

/**
 * Reserve an on-chain transfer for ONE use. Idempotent for the same (use, ref); refuses any other.
 * Inserted before the use is recorded, so a crash in between leaves a reservation that the retry of
 * the same use re-enters, while the other use stays refused.
 */
export async function claimTransferUse(db: Models, u: { key: string; use: "reward_funding" | "custody_transfer"; ref: string; signature: string; ordinal: number }, session?: ClientSession): Promise<{ ok: true } | { ok: false; existing: string }> {
  const judge = (ex: any): { ok: true } | { ok: false; existing: string } => (ex.use === u.use && ex.ref === u.ref ? { ok: true } : { ok: false, existing: `${ex.use}:${ex.ref}` });
  if (session) {
    // Inside a transaction a duplicate-key error aborts the transaction, so read first: a concurrent
    // insert of the same key is a write conflict, and the retried transaction then sees it here.
    const ex: any = await db.TransferUse.findOne({ key: u.key }, null, { session }).lean();
    if (ex) return judge(ex);
    await db.TransferUse.create([{ ...u, createdAt: new Date() }], { session });
    return { ok: true };
  }
  try {
    await db.TransferUse.create([{ ...u, createdAt: new Date() }]);
    return { ok: true };
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const ex: any = await db.TransferUse.findOne({ key: u.key }).lean();
    return ex ? judge(ex) : { ok: false, existing: "unknown" };
  }
}

// ── what a credit needs ──────────────────────────────────────────────────────────────────────

export type CustodyMode = "direct" | "transfer" | "not_applicable";
export interface CustodyRequirement {
  mode: CustodyMode;
  /** Wallet that holds the contribution (null when unknown). */
  custodian: string | null;
  /** Amount that must reach the payout wallet (the credit's creditable amount). */
  required: bigint;
  reason: string | null;
}

/**
 * Pure: how a credit's SOL reaches the payout wallet.
 *   direct    — the contribution transfer itself went into the payout wallet (route last60_destination,
 *               destination = payout wallet): the credit's own finalized transfer is the custody proof;
 *   transfer  — the contribution sits elsewhere (the creator's wallet for Forge's creator payout, or an
 *               intermediate funding destination): a verified custody transfer is required;
 *   not_applicable — the credit can never fund rounds (not payable, not native SOL, custodian unknown,
 *               no payout wallet configured).
 */
export function custodyRequirement(credit: any, payoutWallet: string | null): CustodyRequirement {
  const required = big(credit.creditableAmount);
  const custodian: string | null = credit.destinationWallet ?? null;
  if (!credit.payoutEligible || required <= 0n) return { mode: "not_applicable", custodian, required: 0n, reason: "credit_not_payable" };
  if (credit.fundingMint !== WSOL_MINT) return { mode: "not_applicable", custodian, required: 0n, reason: "custody_only_for_native_sol (rounds pay SOL; other mints are recorded, never converted)" };
  if (!payoutWallet) return { mode: "not_applicable", custodian, required, reason: "payout_wallet_not_configured" };
  const route = credit.route ?? "last60_destination";
  if (route === "last60_destination" && custodian === payoutWallet) return { mode: "direct", custodian, required, reason: null };
  if (!custodian) return { mode: "not_applicable", custodian, required, reason: "custodian_unknown (credit predates destination-wallet records)" };
  if (custodian === payoutWallet) return { mode: "not_applicable", custodian, required, reason: `route_${route}_into_the_payout_wallet_is_not_a_recognised_custody_path` };
  return { mode: "transfer", custodian, required, reason: null };
}

/** Σ credited amount of bound custody rows per contribution (optionally only settled+finalized ones). */
export async function custodiedTotals(db: Models, fundingKeys: string[], o: { settledOnly?: boolean; payoutWallet?: string | null; session?: ClientSession } = {}): Promise<Map<string, { amount: bigint; signatures: string[]; rows: number }>> {
  if (!fundingKeys.length) return new Map();
  const match: Record<string, unknown> = { fundingKey: { $in: fundingKeys }, status: { $in: o.settledOnly ? [...SETTLED_CUSTODY_STATUSES] : [...BOUND_CUSTODY_STATUSES] } };
  if (o.settledOnly) match.confirmationStatus = "finalized";
  if (o.payoutWallet) match.destinationWallet = o.payoutWallet;
  const rows: any[] = await db.CustodyTransfer.find(match, { fundingKey: 1, creditedAmount: 1, signature: 1 }, o.session ? { session: o.session } : {}).lean();
  const out = new Map<string, { amount: bigint; signatures: string[]; rows: number }>();
  for (const r of rows) {
    const e = out.get(r.fundingKey) ?? { amount: 0n, signatures: [], rows: 0 };
    e.amount += big(r.creditedAmount);
    if (r.signature) e.signatures.push(r.signature);
    e.rows++;
    out.set(r.fundingKey, e);
  }
  return out;
}

export interface CustodyCoverage {
  mode: CustodyMode;
  satisfied: boolean;
  required: bigint;
  custodied: bigint;
  /** Custody transfer signatures whose finality the round re-checks on-chain. */
  signatures: string[];
  reason: string | null;
}

/**
 * For each credit: is its SOL independently observed in the payout wallet? Direct credits are
 * satisfied by their own (finalized) transfer; transfer-mode credits need settled, finalized custody
 * rows into THIS payout wallet covering the whole creditable amount (partial custody waits).
 */
export async function custodyCoverage(db: Models, credits: any[], payoutWallet: string | null): Promise<Map<string, CustodyCoverage>> {
  const reqs = new Map(credits.map((c) => [c.key as string, custodyRequirement(c, payoutWallet)]));
  const keys = [...reqs].filter(([, r]) => r.mode === "transfer").map(([k]) => k);
  const settled = await custodiedTotals(db, keys, { settledOnly: true, payoutWallet });
  const out = new Map<string, CustodyCoverage>();
  for (const [k, r] of reqs) {
    if (r.mode === "direct") out.set(k, { mode: "direct", satisfied: true, required: r.required, custodied: r.required, signatures: [], reason: null });
    else if (r.mode === "not_applicable") out.set(k, { mode: r.mode, satisfied: false, required: r.required, custodied: 0n, signatures: [], reason: r.reason });
    else {
      const s = settled.get(k) ?? { amount: 0n, signatures: [], rows: 0 };
      const ok = s.amount >= r.required;
      out.set(k, { mode: "transfer", satisfied: ok, required: r.required, custodied: s.amount, signatures: s.signatures, reason: ok ? null : s.amount > 0n ? `partial_custody: ${s.amount} of ${r.required} in the payout wallet` : "awaiting_custody_transfer" });
    }
  }
  return out;
}

// ── requests ─────────────────────────────────────────────────────────────────────────────────

export const custodyMemo = (custodyId: string) => `${CUSTODY_MEMO_PREFIX}${custodyId}`;

/**
 * Open a sweep request for ONE credited contribution (operator action). Amount and destination are
 * derived from the credit and the configured payout wallet — never supplied by the caller.
 */
export async function createCustodyRequest(db: Models, cfg: CustodySettings, input: { fundingKey: string; actor: string; now?: number }) {
  if (!cfg.enabled) throw new CustodyError("custody_disabled", "custody workflow is disabled (LAST60_CUSTODY_ENABLED=false)");
  if (!cfg.payoutWallet) throw new CustodyError("payout_wallet_not_configured");
  const now = input.now ?? Date.now();
  const credit: any = await db.RewardFunding.findOne({ key: input.fundingKey }).lean();
  if (!credit) throw new CustodyError("unknown_contribution");
  if (credit.policyVersion !== CURRENT_PHASE_AWARE_VERSION && credit.policy?.version !== CURRENT_PHASE_AWARE_VERSION) throw new CustodyError("contribution_not_under_forge_phase_aware_v2");
  if (credit.roundNumber != null) throw new CustodyError("contribution_already_consumed");
  const req = custodyRequirement(credit, cfg.payoutWallet);
  if (req.mode === "direct") throw new CustodyError("custody_not_required", "the contribution was transferred directly into the payout wallet");
  if (req.mode !== "transfer") throw new CustodyError("contribution_not_custody_eligible", req.reason ?? undefined);
  const bound = (await custodiedTotals(db, [credit.key])).get(credit.key)?.amount ?? 0n;
  const outstanding = req.required - bound;
  if (outstanding <= 0n) throw new CustodyError("contribution_already_fully_custodied");
  const custodyId = `ct_${randomToken(16)}`;
  const row = {
    custodyId,
    fundingKey: credit.key,
    collectionKey: credit.collectionKey,
    stream: credit.stream,
    route: credit.route ?? "last60_destination",
    sourcePool: credit.sourcePool,
    tokenMint: credit.tokenMint,
    creator: credit.creator ?? null,
    sourceWallet: req.custodian!,
    destinationWallet: cfg.payoutWallet,
    mint: WSOL_MINT,
    contributionSignature: credit.signature,
    contributionSlot: credit.slot,
    expectedAmount: dec(outstanding),
    memo: custodyMemo(custodyId),
    requestedBy: input.actor,
    expiresAt: new Date(now + (cfg.requestTtlMs ?? 7 * 24 * 3_600_000)),
    status: "requested",
    history: [{ at: new Date(now), event: "requested", actor: input.actor, detail: { outstanding: outstanding.toString() } }],
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  try {
    await db.CustodyTransfer.create(row);
  } catch (err: any) {
    if (err?.code === 11000) throw new CustodyError("open_request_exists", "an open custody request already exists for this contribution");
    throw err;
  }
  return { ...row, instructions: custodyInstructions(row.sourceWallet, row.destinationWallet, outstanding, row.memo) };
}

export function custodyInstructions(from: string, to: string, lamports: bigint, memo: string) {
  return {
    from,
    to,
    lamports: lamports.toString(),
    memo,
    text: `From ${from}, send exactly ${lamports} lamports of native SOL (a System Program transfer, not wrapped SOL) to the Asteroid Protocol payout wallet ${to}, in a transfer-only transaction carrying the SPL memo "${memo}". Do not include any other instruction.`,
  };
}

export async function cancelCustodyRequest(db: Models, input: { custodyId: string; actor: string; reason: string; now?: number }) {
  const now = new Date(input.now ?? Date.now());
  const r = await db.CustodyTransfer.updateOne({ custodyId: input.custodyId, status: "requested" }, { $set: { status: "cancelled", failureReason: `cancelled: ${input.reason}`.slice(0, 300), updatedAt: now }, $push: { history: { at: now, event: "cancelled", actor: input.actor, detail: { reason: input.reason.slice(0, 300) } } } });
  if (!r.modifiedCount) throw new CustodyError("request_not_open");
  return { cancelled: true };
}

// ── verification (pure) ──────────────────────────────────────────────────────────────────────

const CUSTODY_PROGRAMS = new Set([SYSTEM_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, ...MEMO_PROGRAM_IDS]);

export interface CustodyVerification {
  ok: boolean;
  reasons: string[];
  ordinal: number | null;
  observed: bigint;
  memo: "match" | "absent";
}

/**
 * Pure: does `tx` move the requested contribution into the payout wallet? Never by balance deltas:
 * exactly one native SOL System `transfer` from the custodian to the payout wallet, in a successful,
 * transfer-only transaction (System / ComputeBudget / Memo), strictly after the contribution's slot,
 * carrying no memo that names another request. The amount is the instruction's lamports — the network
 * fee is paid separately by the fee payer and never counted.
 */
export function verifyCustodyTransfer(tx: NormalizedTx, req: { custodyId: string; sourceWallet: string; destinationWallet: string; mint: string; contributionSlot: number }, ctx: { payoutWallet: string | null; requireMemo: boolean }): CustodyVerification {
  const reasons: string[] = [];
  const out = (ordinal: number | null = null, observed = 0n, memo: "match" | "absent" = "absent"): CustodyVerification => ({ ok: reasons.length === 0, reasons, ordinal, observed, memo });
  if (tx.err) reasons.push("transaction_failed");
  if (!ctx.payoutWallet || ctx.payoutWallet !== req.destinationWallet) reasons.push("payout_wallet_changed_since_request");
  if (req.mint !== WSOL_MINT) reasons.push("custody_only_for_native_sol");
  const memos = custodyMemosOf(tx);
  if (memos.length > 1) reasons.push("multiple_custody_memos");
  else if (memos.length === 1 && memos[0] !== req.custodyId) reasons.push("memo_names_another_custody_request");
  else if (memos.length === 0 && ctx.requireMemo) reasons.push("custody_memo_missing");
  const programs = [...new Set(tx.instructions.map((ix) => ix.programId))];
  const foreign = programs.filter((p) => !CUSTODY_PROGRAMS.has(p));
  if (foreign.length) reasons.push(`custody_transaction_not_transfer_only: ${foreign.join(",")}`);
  if (tx.slot <= req.contributionSlot) reasons.push(`transfer_not_after_contribution: slot ${tx.slot} ≤ contribution slot ${req.contributionSlot}`);
  const sys = tx.instructions.flatMap((ix) => {
    const t = decodeSystemTransfer(ix);
    return t && t.lamports > 0n ? [{ ordinal: ix.ordinal, t }] : [];
  });
  const matching = sys.filter((x) => x.t.from === req.sourceWallet && x.t.to === req.destinationWallet);
  const memo = memos.length === 1 && memos[0] === req.custodyId ? "match" : "absent";
  if (matching.length === 1) return out(matching[0]!.ordinal, matching[0]!.t.lamports, memo);
  if (matching.length > 1) reasons.push("multiple_transfers_to_payout_wallet_in_one_transaction");
  else if (sys.some((x) => x.t.to === req.destinationWallet)) reasons.push("incorrect_source_wallet: the transfer into the payout wallet does not come from the contribution's custodian");
  else if (sys.some((x) => x.t.from === req.sourceWallet)) reasons.push("incorrect_destination_wallet: the custodian's transfer does not reach the payout wallet");
  else if (tx.instructions.some((ix) => {
    const t = decodeTokenTransfer(ix);
    return !!t && tokenAccountInfo(tx, t.destination)?.owner === req.destinationWallet;
  })) reasons.push("incorrect_mint: an SPL / wrapped-SOL transfer is not native SOL custody");
  else reasons.push("no_native_sol_transfer_to_payout_wallet");
  return out(null, 0n, memo);
}

// ── binding a verified transfer to a request ─────────────────────────────────────────────────

export type BindResult = { accepted: true; duplicate: boolean; custodyId: string; status: string; credited: bigint; excess: bigint } | { accepted: false; custodyId: string; reason: string };

class Abort extends Error {}

/**
 * Bind one verified on-chain transfer to an open request (idempotent, concurrency-safe). In ONE
 * MongoDB transaction: reserve the transfer (`transfer_uses`), refuse a transfer already credited as a
 * contribution, recompute the outstanding amount from every bound custody row, and compare-and-set the
 * request from `requested`. Credited = min(observed, outstanding); any excess is recorded, never
 * credited. Funds count for rounds only once the transfer is FINALIZED (status reconciled / partial).
 */
export async function bindCustodyTransfer(db: Models, input: { custodyId: string; tx: NormalizedTx; commitment: "confirmed" | "finalized"; method: "memo_observed" | "operator_signature" | "creator_wallet_sweep"; actor: string; payoutWallet: string | null; requireMemo: boolean; now?: number }): Promise<BindResult> {
  const now = new Date(input.now ?? Date.now());
  const { tx } = input;
  const reject = async (reason: string): Promise<BindResult> => {
    await db.CustodyTransfer.updateOne({ custodyId: input.custodyId }, { $push: { history: { at: now, event: "submission_rejected", actor: input.actor, detail: { signature: tx.signature, reason: reason.slice(0, 300), method: input.method } } }, $set: { updatedAt: now } });
    return { accepted: false, custodyId: input.custodyId, reason };
  };
  const req: any = await db.CustodyTransfer.findOne({ custodyId: input.custodyId }).lean();
  if (!req) return { accepted: false, custodyId: input.custodyId, reason: "unknown_custody_request" };
  if (req.status !== "requested") {
    if (req.signature === tx.signature) return { accepted: true, duplicate: true, custodyId: req.custodyId, status: req.status, credited: big(req.creditedAmount), excess: big(req.excessAmount) };
    return reject(`request_not_open: ${req.status}`);
  }
  if (new Date(req.expiresAt).getTime() < now.getTime()) {
    await db.CustodyTransfer.updateOne({ custodyId: req.custodyId, status: "requested" }, { $set: { status: "expired", failureReason: "request expired before a transfer was bound", updatedAt: now }, $push: { history: { at: now, event: "expired", actor: input.actor, detail: null } } });
    return reject("request_expired");
  }
  const v = verifyCustodyTransfer(tx, req, { payoutWallet: input.payoutWallet, requireMemo: input.requireMemo });
  if (!v.ok || v.ordinal === null) return reject(v.reasons.join(" | ") || "verification_failed");
  const credit: any = await db.RewardFunding.findOne({ key: req.fundingKey }).lean();
  const r = credit ? custodyRequirement(credit, input.payoutWallet) : null;
  if (!credit || !r || r.mode !== "transfer" || r.custodian !== req.sourceWallet) return reject("contribution_no_longer_custody_eligible");
  if (credit.roundNumber != null) return reject("contribution_already_consumed");
  const transferKey = transferKeyOf(tx.signature, v.ordinal);
  const finalized = input.commitment === "finalized";
  try {
    const res = await inTransaction(db, async (session) => {
      // A transfer that is itself a recorded contribution (incl. credits written before transfer_uses
      // existed) can never also be custody.
      if (await db.RewardFunding.exists({ signature: tx.signature, ordinal: v.ordinal }).session(session)) throw new Abort("transfer_already_credited_as_contribution");
      const use = await claimTransferUse(db, { key: transferKey, use: "custody_transfer", ref: req.custodyId, signature: tx.signature, ordinal: v.ordinal! }, session);
      if (!use.ok) throw new Abort(`transfer_already_used: ${use.existing}`);
      const bound = (await custodiedTotals(db, [req.fundingKey], { session })).get(req.fundingKey)?.amount ?? 0n;
      const outstanding = r.required - bound;
      if (outstanding <= 0n) throw new Abort("contribution_already_fully_custodied");
      const credited = v.observed < outstanding ? v.observed : outstanding;
      const excess = v.observed - credited;
      const onFinality = credited === outstanding ? "reconciled" : "partial";
      const reconciliation = excess > 0n ? "excess" : credited < outstanding ? "partial" : "matched";
      const u = await db.CustodyTransfer.updateOne(
        { custodyId: req.custodyId, status: "requested" },
        {
          $set: {
            method: input.method,
            boundBy: input.actor,
            transferKey,
            signature: tx.signature,
            ordinal: v.ordinal,
            slot: tx.slot,
            blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
            observedAmount: dec(v.observed),
            creditedAmount: dec(credited),
            excessAmount: dec(excess),
            networkFeeLamports: dec(tx.fee),
            feePayer: tx.feePayer,
            statusOnFinality: onFinality,
            confirmationStatus: finalized ? "finalized" : "confirmed",
            status: finalized ? onFinality : "awaiting_finality",
            reconciliation,
            finalizedSlot: finalized ? tx.slot : null,
            updatedAt: now,
          },
          $push: { history: { at: now, event: finalized ? "bound_finalized" : "bound_awaiting_finality", actor: input.actor, detail: { signature: tx.signature, ordinal: v.ordinal, observed: v.observed.toString(), credited: credited.toString(), excess: excess.toString(), outstandingBefore: outstanding.toString(), memo: v.memo, method: input.method } } },
        },
        { session },
      );
      if (!u.modifiedCount) throw new Abort("request_not_open");
      return { status: finalized ? onFinality : "awaiting_finality", credited, excess };
    });
    return { accepted: true, duplicate: false, custodyId: req.custodyId, ...res };
  } catch (err) {
    if (err instanceof Abort) return reject(err.message);
    if ((err as any)?.code === 11000) return reject("transfer_already_used");
    throw err;
  }
}

/** Operator path: verify a submitted transaction signature against an open request, from the chain. */
export async function submitCustodySignature(db: Models, rpc: Pick<ChainRpc, "getTransactionRaw">, cfg: CustodySettings, input: { custodyId: string; signature: string; actor: string; now?: number }): Promise<BindResult> {
  if (!cfg.enabled) throw new CustodyError("custody_disabled", "custody workflow is disabled (LAST60_CUSTODY_ENABLED=false)");
  if (!CUSTODY_ID_RE.test(input.custodyId)) throw new CustodyError("invalid_custody_id");
  if (!SIG_RE.test(input.signature)) throw new CustodyError("invalid_signature");
  let raw = await rpc.getTransactionRaw(input.signature, "finalized").catch(() => null);
  let commitment: "confirmed" | "finalized" = "finalized";
  if (!raw) {
    raw = await rpc.getTransactionRaw(input.signature, "confirmed").catch(() => null);
    commitment = "confirmed";
  }
  if (!raw) {
    const now = new Date(input.now ?? Date.now());
    await db.CustodyTransfer.updateOne({ custodyId: input.custodyId }, { $push: { history: { at: now, event: "submission_rejected", actor: input.actor, detail: { signature: input.signature, reason: "transaction_not_found_or_not_confirmed" } } } });
    return { accepted: false, custodyId: input.custodyId, reason: "transaction_not_found_or_not_confirmed" };
  }
  const tx = normalizeTransaction(raw);
  if (tx.signature !== input.signature) return { accepted: false, custodyId: input.custodyId, reason: "rpc_returned_a_different_transaction" };
  return bindCustodyTransfer(db, { custodyId: input.custodyId, tx, commitment, method: "operator_signature", actor: input.actor, payoutWallet: cfg.payoutWallet, requireMemo: false, now: input.now });
}

/** Indexer path: transfers carrying `last60:custody:v1:<id>` are matched to their request automatically. */
export async function ingestCustodyTransfers(db: Models, tx: NormalizedTx, cfg: CustodySettings | undefined | null, commitment: "confirmed" | "finalized"): Promise<BindResult[]> {
  if (!cfg?.enabled || !cfg.payoutWallet || tx.err) return [];
  const ids = custodyMemosOf(tx);
  const out: BindResult[] = [];
  for (const id of ids) {
    if (!(await db.CustodyTransfer.exists({ custodyId: id }))) continue; // memo naming no request: not ours
    out.push(await bindCustodyTransfer(db, { custodyId: id, tx, commitment, method: "memo_observed", actor: "indexer", payoutWallet: cfg.payoutWallet, requireMemo: true }));
  }
  return out;
}

/**
 * Promote bound transfers to finalized (or failed) from on-chain signature status, and expire stale
 * open requests. Idempotent; run by the rewards worker's reconciliation pass and the CLI.
 */
export async function refreshCustodyFinality(db: Models, rpc: Pick<ChainRpc, "getSignatureStatuses">, now = Date.now()): Promise<{ finalized: number; failed: number; expired: number }> {
  let finalized = 0;
  let failed = 0;
  const at = new Date(now);
  const exp = await db.CustodyTransfer.updateMany({ status: "requested", expiresAt: { $lt: at } }, { $set: { status: "expired", failureReason: "request expired before a transfer was bound", updatedAt: at }, $push: { history: { at, event: "expired", actor: "system", detail: null } } });
  const rows: any[] = await db.CustodyTransfer.find({ status: "awaiting_finality" }, { custodyId: 1, signature: 1, statusOnFinality: 1, updatedAt: 1 }).limit(200).lean();
  if (rows.length) {
    const st = await rpc.getSignatureStatuses(rows.map((r) => r.signature), true);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const s = st[i];
      if (s && s.err && s.confirmationStatus === "finalized") {
        const u = await db.CustodyTransfer.updateOne({ custodyId: r.custodyId, status: "awaiting_finality" }, { $set: { status: "failed", confirmationStatus: "failed", failureReason: `transaction failed on-chain: ${JSON.stringify(s.err).slice(0, 200)}`, updatedAt: at }, $push: { history: { at, event: "failed", actor: "system", detail: { reason: "transaction_failed" } } } });
        failed += u.modifiedCount;
      } else if (s && !s.err && s.confirmationStatus === "finalized") {
        const u = await db.CustodyTransfer.updateOne({ custodyId: r.custodyId, status: "awaiting_finality" }, { $set: { status: r.statusOnFinality ?? "partial", confirmationStatus: "finalized", finalizedSlot: s.slot, updatedAt: at }, $push: { history: { at, event: "finalized", actor: "system", detail: { slot: s.slot } } } });
        finalized += u.modifiedCount;
      } else if (!s && now - new Date(r.updatedAt).getTime() > DROP_AFTER_MS) {
        // Never finalized: the funds never arrived. The transfer stays reserved (it can never be reused);
        // a new request covers the still-outstanding amount.
        const u = await db.CustodyTransfer.updateOne({ custodyId: r.custodyId, status: "awaiting_finality" }, { $set: { status: "failed", confirmationStatus: "failed", failureReason: "transaction never finalized (dropped)", updatedAt: at }, $push: { history: { at, event: "failed", actor: "system", detail: { reason: "not_finalized" } } } });
        failed += u.modifiedCount;
      }
    }
  }
  return { finalized, failed, expired: exp.modifiedCount };
}

/** Forge route helper for reports: the creator payout credit is custodied by the creator until swept. */
export const isForgeCreatorRoute = (credit: any) => credit.route === FORGE_CREATOR_DISTRIBUTION;
