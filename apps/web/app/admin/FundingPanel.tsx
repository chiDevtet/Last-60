"use client";
/**
 * Reward funding & custody (admin). Four separate stages — never presented as interchangeable:
 *   1. economic attribution (who contributed)   2. physical custody (who holds the SOL)
 *   3. reward-round funding (credits consumed)   4. buyer payouts.
 * Shows the dedicated payout wallet's verification (address, signer status, derived-key match, balance)
 * from the server's sanitized report — never any key material. Actions only reference stored records:
 * no amount, recipient, eligibility or status is ever typed in here.
 */
import { useCallback, useEffect, useState } from "react";
import { shortAddress, sol, dateTime } from "@/lib/format";

type Call = (p: string, i?: RequestInit) => Promise<any>;

function Stage({ n, title, subtitle, children }: { n: number; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">Stage {n}</p>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-[11px] text-dim">{subtitle}</p>
      <div className="mt-3 space-y-1 text-sm">{children}</div>
    </div>
  );
}
const Row = ({ k, v, tone }: { k: string; v: React.ReactNode; tone?: "bad" | "warn" | "good" }) => (
  <div className="flex justify-between gap-3">
    <span className="text-mist">{k}</span>
    <span className={`tabular ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "good" ? "text-good" : ""}`}>{v}</span>
  </div>
);
const lamports = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${sol(v, 6)} SOL`);

export function FundingPanel({ call }: { call: Call }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => call("/funding").then(setData).catch((e) => setErr(e.message)), [call]);
  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  async function post(path: string, body: unknown, ok: (r: any) => string) {
    setErr(null);
    setMsg(null);
    try {
      const r = await call(path, { method: "POST", body: JSON.stringify(body) });
      setMsg(ok(r));
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!data) return <section className="card p-5 text-sm text-mist">{err ? `✕ ${err}` : "Loading reward funding…"}</section>;
  const w = data.wallet;
  const p = data.pipeline;
  const q = p.liquidity;
  const awaiting = p.custody.contributions.filter((c: any) => c.roundNumber == null && c.custodied !== c.required);
  return (
    <section className="space-y-4">
      <div className="card p-5">
        <h2 className="text-sm font-semibold">Dedicated payout wallet — verification</h2>
        <p className="mt-1 text-xs text-mist">Read-only. The private key exists only in the rewards worker; this page never receives it.</p>
        <div className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <Row k="Configured address" v={<span className="break-all font-mono text-xs">{w.address ?? "not configured"}</span>} tone={w.address ? undefined : "bad"} />
          <Row k="Balance" v={w.balanceLamports ? lamports(w.balanceLamports) : w.balanceError ?? "—"} />
          <Row k="Signer configured" v={w.signer ? (w.signer.configured ? "✓ yes" : `✕ ${w.signer.code}`) : "✕ not reported"} tone={w.signer?.configured ? "good" : "bad"} />
          <Row k="Derived key matches address" v={w.signerMatchesAddress === null ? "—" : w.signerMatchesAddress ? "✓ yes" : "✕ no"} tone={w.signerMatchesAddress ? "good" : "bad"} />
          <Row k="Payouts" v={w.payoutsEnabled ? "✓ enabled" : `◷ ${w.payoutsBlockedReason ?? "blocked"}`} tone={w.payoutsEnabled ? "good" : "warn"} />
          <Row k="Latest payout" v={w.latestPayout ? `#${w.latestPayout.roundNumber} · ${shortAddress(w.latestPayout.signature, 5, 5)}` : "—"} />
          <Row k="Latest custody reconciliation" v={w.latestCustodyReconciliation ? `${w.latestCustodyReconciliation.status} · ${lamports(w.latestCustodyReconciliation.credited)}` : "—"} />
          <Row k="Latest wallet check" v={w.latestWalletReconciliation ? `${w.latestWalletReconciliation.status} · ${dateTime(w.latestWalletReconciliation.at)}` : "—"} />
        </div>
        {w.signer && !w.signer.configured && <p className="mt-2 text-xs text-bad">✕ {w.signer.message}</p>}
      </div>

      {err && <p className="rounded-lg border border-bad/30 bg-bad/10 px-4 py-2 text-sm text-bad">✕ {err}</p>}
      {msg && <p className="rounded-lg border border-good/30 bg-good/10 px-4 py-2 text-sm text-good">✓ {msg}</p>}

      <div className="grid gap-4 md:grid-cols-4">
        <Stage n={1} title="Economic attribution" subtitle="Who contributed: verified credits (accounting only — not liquidity).">
          <Row k="Payable SOL credits" v={`${p.attribution.payableSolCredits} · ${lamports(p.attribution.payableSolAmount)}`} />
          {Object.entries(p.attribution.byRoute).map(([r, x]: any) => <Row key={r} k={r} v={lamports(x.amount)} />)}
          <Row k="Forge unresolved" v={p.attribution.forge.unresolved} tone={p.attribution.forge.unresolved ? "warn" : undefined} />
          <Row k="Forge pending" v={p.attribution.forge.pending} />
        </Stage>
        <Stage n={2} title="Physical custody" subtitle="Who holds the SOL: verified, finalized transfers into the payout wallet.">
          <Row k="Received by payout wallet" v={lamports(p.custody.verifiedReceivedByPayoutWallet)} tone="good" />
          <Row k="Pending finality" v={lamports(p.custody.pendingFinality)} />
          <Row k="Attributed, awaiting custody" v={lamports(p.custody.attributedAwaitingCustody)} tone={p.custody.attributedAwaitingCustody !== "0" ? "warn" : undefined} />
          <Row k="Outstanding (no transfer yet)" v={lamports(p.custody.outstanding)} />
        </Stage>
        <Stage n={3} title="Reward-round funding" subtitle="Credits consumed by rounds (only after custody is verified).">
          <Row k="Consumed by rounds" v={lamports(p.rounds.consumedTotal)} />
          {p.rounds.byRound.slice(0, 4).map((r: any) => <Row key={r.roundNumber} k={`round #${r.roundNumber}`} v={lamports(r.amount)} />)}
        </Stage>
        <Stage n={4} title="Buyer payouts" subtitle="Transfers signed by the payout signer.">
          <Row k="Confirmed" v={lamports(p.payouts.confirmed)} tone="good" />
          <Row k="Pending" v={lamports(p.payouts.pending)} />
          <Row k="Failed" v={lamports(p.payouts.failed)} tone={p.payouts.failed !== "0" ? "bad" : undefined} />
        </Stage>
      </div>

      <div className={`card p-5 ${q.mismatch ? "border-bad/40" : ""}`}>
        <h2 className="text-sm font-semibold">Actual payout liquidity</h2>
        <div className="mt-3 grid gap-2 text-sm md:grid-cols-3">
          <Row k="Wallet balance" v={lamports(q.balance)} />
          <Row k="Custodied, not yet consumed" v={lamports(q.custodiedUnconsumed)} />
          <Row k="Pending live payouts" v={lamports(q.pendingLivePayouts)} />
          <Row k="Operating reserve (fees)" v={lamports(q.reserve)} />
          <Row k="Available" v={lamports(q.available)} />
          <Row k="Shortfall" v={lamports(q.shortfall)} tone={q.mismatch ? "bad" : undefined} />
        </div>
        {q.mismatch && <p className="mt-2 text-xs text-bad">✕ {q.detail}</p>}
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold">Contributions awaiting custody</h2>
        <p className="mt-1 text-xs text-mist">Attributed contributions whose SOL is not yet verified in the payout wallet. They cannot fund a round until it is. A sweep request names one contribution; amount and destination come from the record.{data.features.custodyEnabled ? "" : " Custody workflow is disabled (LAST60_CUSTODY_ENABLED)."}</p>
        <table className="mt-3 w-full text-xs">
          <tbody>
            {awaiting.map((c: any) => (
              <tr key={c.fundingKey} className="border-t border-line/60 align-top">
                <td className="py-2 pr-2 font-mono" title={c.fundingKey}>{c.fundingKey.slice(0, 28)}…</td>
                <td className="py-2 pr-2">{c.route}</td>
                <td className="py-2 pr-2 font-mono">{c.custodian ? shortAddress(c.custodian, 4, 4) : "?"}</td>
                <td className="py-2 pr-2 tabular">{lamports(c.custodied)} / {lamports(c.required)}</td>
                <td className="py-2 pr-2 text-mist">{c.reason ?? ""}</td>
                <td className="py-2 text-right">
                  {data.features.custodyEnabled && c.mode === "transfer" && !c.openRequest && c.outstanding !== "0" && (
                    <button className="focus-ring rounded border border-line px-2 py-1 hover:text-frost" onClick={() => post("/funding/custody", { fundingKey: c.fundingKey }, (r) => `Sweep request ${r.custodyId}: ${r.instructions.text}`)}>Open sweep request</button>
                  )}
                  {c.openRequest && (
                    <span className="space-x-1">
                      <button className="focus-ring rounded border border-line px-2 py-1 hover:text-frost" onClick={() => { const s = prompt("Transaction signature of the custodian's transfer:"); if (s) post(`/funding/custody/${c.openRequest}/submit`, { signature: s.trim() }, (r) => r.accepted ? `Bound: ${r.status}` : `Rejected: ${r.reason}`); }}>Submit signature</button>
                      <button className="focus-ring rounded border border-line px-2 py-1 text-mist" onClick={() => { const r = prompt("Reason for cancelling (audited):"); if (r) post(`/funding/custody/${c.openRequest}/cancel`, { reason: r }, () => "Request cancelled"); }}>Cancel</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!awaiting.length && <tr><td className="py-2 text-mist">Nothing awaiting custody.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold">Custody transfers</h2>
        <p className="mt-1 text-xs text-mist">Status: {JSON.stringify(p.custody.transfersByStatus)}. A custody transfer moves an existing contribution; it is never a second contribution.</p>
        <table className="mt-3 w-full text-xs">
          <tbody>
            {p.custody.recentTransfers.map((t: any) => (
              <tr key={t.custodyId} className="border-t border-line/60 align-top">
                <td className="py-2 pr-2 font-mono">{t.custodyId}</td>
                <td className={`py-2 pr-2 ${["failed", "expired", "cancelled"].includes(t.status) ? "text-bad" : t.status === "reconciled" ? "text-good" : "text-warn"}`}>{t.status}</td>
                <td className="py-2 pr-2">{t.confirmationStatus} · {t.reconciliation}</td>
                <td className="py-2 pr-2 tabular">{t.credited ? lamports(t.credited) : "—"} / {lamports(t.expected)}{t.excess && t.excess !== "0" ? ` (+${lamports(t.excess)} excess)` : ""}</td>
                <td className="py-2 pr-2 font-mono">{t.signature ? shortAddress(t.signature, 5, 5) : t.memo}</td>
                <td className="py-2 text-mist">{t.failureReason ?? dateTime(t.updatedAt)}</td>
              </tr>
            ))}
            {!p.custody.recentTransfers.length && <tr><td className="py-2 text-mist">No custody transfers yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold">Unresolved Forge attributions</h2>
        <p className="mt-1 text-xs text-mist">Re-running verification re-applies the normal attribution to the indexed history. It never overrides a check or sets an amount; the original decision is kept and every attempt is audited.{data.features.recoveryEnabled ? "" : " Recovery is disabled (LAST60_ATTRIBUTION_RECOVERY_ENABLED)."}</p>
        <table className="mt-3 w-full text-xs">
          <tbody>
            {p.attribution.unresolvedForgeAttributions.map((a: any) => (
              <tr key={a.key} className="border-t border-line/60 align-top">
                <td className="py-2 pr-2 font-mono" title={a.key}>{shortAddress(a.signature, 5, 5)} · slot {a.slot}</td>
                <td className="py-2 pr-2 tabular">{a.amount}</td>
                <td className="py-2 pr-2 text-mist">{a.reasons[0] ?? ""}</td>
                <td className="py-2 text-right">
                  {a.recovery ? <span className="text-good">recovered ({a.recovery.outcome})</span> : data.features.recoveryEnabled && (
                    <button className="focus-ring rounded border border-line px-2 py-1 hover:text-frost" onClick={() => { const note = prompt("Why re-run verification now (audited)?"); if (note !== null) post("/funding/attributions/recover", { attributionKey: a.key, note: note || undefined }, (r) => `Recovery ${r.requestId}: ${r.outcome}${r.failureReason ? ` — ${r.failureReason}` : ""}`); }}>Re-run verification</button>
                  )}
                </td>
              </tr>
            ))}
            {!p.attribution.unresolvedForgeAttributions.length && <tr><td className="py-2 text-mist">No unresolved attributions.</td></tr>}
          </tbody>
        </table>
        {p.recoveries.length > 0 && (
          <>
            <h3 className="mt-4 text-xs font-semibold">Recovery attempts</h3>
            <table className="mt-2 w-full text-xs">
              <tbody>
                {p.recoveries.map((r: any) => (
                  <tr key={r.requestId} className="border-t border-line/60">
                    <td className="py-2 pr-2 text-mist">{dateTime(r.requestedAt)}</td>
                    <td className="py-2 pr-2 font-mono">{shortAddress(r.operator, 4, 4)}</td>
                    <td className={`py-2 pr-2 ${r.outcome === "linked" ? "text-good" : r.outcome === "rejected" ? "text-bad" : "text-warn"}`}>{r.outcome}</td>
                    <td className="py-2 text-mist">{r.failureReason ?? r.reasons[0] ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}
