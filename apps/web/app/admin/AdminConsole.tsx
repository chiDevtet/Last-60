"use client";
/**
 * Admin console. Authentication is a wallet signature over a server-issued, single-use,
 * domain-bound message; the session token lives in sessionStorage only. Every mutation is
 * validated server-side and written to the audit log. No secret is ever displayed or editable.
 */
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PUBLIC_API_URL } from "@/lib/config";
import { shortAddress, sol, dateTime } from "@/lib/format";

type Field = { key: string; label: string; kind: "int" | "lamports" | "bps" | "text" | "select" | "bool" | "list"; options?: string[]; help?: string };
const FIELDS: { group: string; fields: Field[] }[] = [
  {
    group: "Token & provider",
    fields: [
      { key: "launchProvider", label: "Launch provider", kind: "select", options: ["meteora_dbc", "raydium_launchlab"] },
      { key: "tokenMint", label: "Token mint", kind: "text" },
      { key: "poolAddress", label: "Pool address", kind: "text" },
      { key: "feeBeneficiaryRole", label: "Fee beneficiary role", kind: "select", options: ["creator", "partner", "platform"], help: "Whose fee share is distributed (DBC: creator|partner, LaunchLab: creator|platform)" },
    ],
  },
  {
    group: "Rewards",
    fields: [
      { key: "buyerCount", label: "Recipients per round", kind: "int" },
      { key: "minBuyQuote", label: "Minimum qualifying buy (SOL)", kind: "lamports" },
      { key: "rewardBps", label: "Reward percentage (%)", kind: "bps" },
      { key: "minPayoutLamports", label: "Minimum payout per wallet (SOL)", kind: "lamports" },
      { key: "skippedRoundPolicy", label: "Skipped round policy", kind: "select", options: ["rollover", "retain"] },
      { key: "excludedWallets", label: "Excluded wallets (comma separated)", kind: "list" },
    ],
  },
  {
    group: "Payout authority",
    fields: [
      { key: "payoutAsset", label: "Payout asset", kind: "text", help: '"SOL" or the pool quote mint' },
      { key: "payoutMode", label: "Payout mode", kind: "select", options: ["dry_run", "live"], help: "Live on mainnet also requires ALLOW_MAINNET_PAYOUTS=true in the worker environment" },
      { key: "expectedPayoutPublicKey", label: "Payout wallet public key", kind: "text", help: "Must match the key loaded by the rewards worker; signing is refused otherwise" },
      { key: "feeCollectionMode", label: "Fee collection", kind: "select", options: ["manual", "auto_claim"] },
    ],
  },
  {
    group: "RPC & indexer",
    fields: [
      { key: "rpcUrls", label: "RPC endpoints (comma separated, first is primary)", kind: "list" },
      { key: "wsUrl", label: "WebSocket endpoint", kind: "text" },
      { key: "indexerPollIntervalMs", label: "Poll interval (ms)", kind: "int" },
      { key: "indexerUseWebsocket", label: "Use websocket fast path", kind: "bool" },
    ],
  },
];

function toInput(f: Field, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (f.kind === "lamports") return sol(String(v), 9, 0).replace(/,/g, "");
  if (f.kind === "bps") return String(Number(v) / 100);
  if (f.kind === "list") return (v as string[]).join(", ");
  if (f.kind === "bool") return v ? "true" : "false";
  return String(v);
}
function fromInput(f: Field, s: string): unknown {
  const t = s.trim();
  if (f.kind === "int") return Number(t);
  if (f.kind === "bps") return Math.round(Number(t) * 100);
  if (f.kind === "bool") return t === "true";
  if (f.kind === "list") return t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  if (f.kind === "lamports") {
    const [w = "0", fr = ""] = t.split(".");
    return (BigInt(w || "0") * 1_000_000_000n + BigInt((fr + "000000000").slice(0, 9))).toString();
  }
  return t;
}

export function AdminConsole() {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [account, setAccount] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const api = getWallets();
    const usable = () => api.get().filter((w) => "standard:connect" in w.features && "solana:signMessage" in w.features);
    setWallets(usable());
    const off = api.on("register", () => setWallets(usable()));
    try {
      setToken(sessionStorage.getItem("last60.admin"));
    } catch {
      /* storage unavailable */
    }
    return off;
  }, []);

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${PUBLIC_API_URL}/api/admin${path}`, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && token) {
        setToken(null);
        try {
          sessionStorage.removeItem("last60.admin");
        } catch {}
      }
      if (!res.ok) throw new Error(body.issues ? `${body.error}: ${body.issues.join("; ")}` : body.error ?? `HTTP ${res.status}`);
      return body;
    },
    [token],
  );

  async function signIn(w: Wallet) {
    setError(null);
    try {
      const connect = (w.features["standard:connect"] as any).connect;
      const { accounts } = await connect();
      const acc: WalletAccount | undefined = accounts.find((a: WalletAccount) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
      if (!acc) throw new Error("wallet returned no account");
      setAccount({ wallet: w, account: acc });
      const n = await call("/auth/nonce", { method: "POST", body: JSON.stringify({ wallet: acc.address }) });
      const [out] = await (w.features["solana:signMessage"] as any).signMessage({ account: acc, message: new TextEncoder().encode(n.message) });
      const v = await call("/auth/verify", { method: "POST", body: JSON.stringify({ wallet: acc.address, nonce: n.nonce, signature: bs58.encode(out.signature) }) });
      setToken(v.token);
      try {
        sessionStorage.setItem("last60.admin", v.token);
      } catch {}
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!token) {
    return (
      <div className="card mx-auto mt-16 max-w-md p-8">
        <h1 className="text-xl font-semibold">Administrator sign-in</h1>
        <p className="mt-2 text-sm text-mist">Sign a one-time message with an allow-listed wallet. Signing never authorizes a transaction.</p>
        <div className="mt-6 space-y-2">
          {wallets.length === 0 && <p className="text-sm text-warn">No Solana wallet with message signing was detected in this browser.</p>}
          {wallets.map((w) => (
            <button key={w.name} onClick={() => signIn(w)} className="focus-ring flex w-full items-center gap-3 rounded-xl border border-line px-4 py-3 text-left hover:bg-white/[0.03]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={w.icon} alt="" className="h-6 w-6 rounded" />
              <span className="font-medium">{w.name}</span>
            </button>
          ))}
        </div>
        {error && <p className="mt-4 text-sm text-bad">✕ {error}</p>}
      </div>
    );
  }
  return <Console call={call} me={account?.account.address ?? null} onSignOut={() => { setToken(null); try { sessionStorage.removeItem("last60.admin"); } catch {} }} notice={notice} setNotice={setNotice} />;
}

function Console({ call, me, onSignOut, notice, setNotice }: { call: (p: string, i?: RequestInit) => Promise<any>; me: string | null; onSignOut: () => void; notice: string | null; setNotice: (s: string | null) => void }) {
  const [cfg, setCfg] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, s, a] = await Promise.all([call("/config"), call("/status"), call("/audit")]);
    setCfg(c);
    setStatus(s);
    setAudit(a);
  }, [call]);
  useEffect(() => {
    load().catch((e) => setErr(e.message));
    const id = setInterval(() => call("/status").then(setStatus).catch(() => undefined), 10_000);
    return () => clearInterval(id);
  }, [load, call]);

  const changes = useMemo(() => {
    if (!cfg) return {};
    const out: Record<string, unknown> = {};
    for (const g of FIELDS)
      for (const f of g.fields) {
        if (!(f.key in draft)) continue;
        const effKey = f.key === "payoutAsset" ? null : f.key;
        const current = effKey ? toInput(f, cfg.effective[effKey]) : toInput(f, cfg.overrides.payoutAsset ?? "SOL");
        if (draft[f.key] !== current) out[f.key] = fromInput(f, draft[f.key]!);
      }
    return out;
  }, [draft, cfg]);
  const critical = Object.keys(changes).filter((k) => cfg?.criticalKeys.includes(k));

  async function save() {
    setErr(null);
    try {
      const r = await call("/config", { method: "PUT", body: JSON.stringify({ patch: changes, reason: reason || undefined, expectedVersion: cfg.version, confirmCritical: confirm }) });
      setNotice(`Saved settings version ${r.version} (${r.changes.length} change${r.changes.length === 1 ? "" : "s"}). Workers apply changes within seconds; reward parameters apply from the next snapshot.`);
      setDraft({});
      setReason("");
      setConfirm(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function act(path: string, body?: unknown) {
    setErr(null);
    try {
      await call(path, { method: "POST", body: JSON.stringify(body ?? {}) });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!cfg || !status) return <div className="p-16 text-center text-mist">{err ? `✕ ${err}` : "Loading…"}</div>;
  const eff = cfg.effective;
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <span className="font-mono text-xs text-mist">{me ? shortAddress(me, 5, 5) : "signed in"} · settings v{cfg.version}</span>
        <button onClick={onSignOut} className="focus-ring ml-auto rounded-lg border border-line px-3 py-1.5 text-sm text-mist hover:text-frost">Sign out</button>
      </div>
      {notice && <p className="rounded-lg border border-good/30 bg-good/10 px-4 py-2 text-sm text-good">✓ {notice}</p>}
      {err && <p className="rounded-lg border border-bad/30 bg-bad/10 px-4 py-2 text-sm text-bad">✕ {err}</p>}

      <section className="grid gap-4 md:grid-cols-3">
        <div className="card p-5 md:col-span-2">
          <h2 className="text-sm font-semibold">Workers</h2>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {status.workers.filter((w: any) => !String(w._id).includes(":")).map((w: any) => {
                const age = w.heartbeatAt ? Math.round((Date.now() - new Date(w.heartbeatAt).getTime()) / 1000) : null;
                return (
                  <tr key={w._id} className="border-t border-line/60">
                    <td className="py-2 font-mono">{w._id}</td>
                    <td className="py-2">{age !== null && age > 30 ? <span className="text-bad">✕ stale ({age}s)</span> : <span className={w.status === "running" ? "text-good" : "text-warn"}>{w.status === "running" ? "✓" : "◷"} {w.status}</span>}</td>
                    <td className="py-2 text-xs text-mist">{w.detail ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-4 flex flex-wrap gap-2">
            {(["indexer", "payouts", "scheduler"] as const).map((c) => {
              const paused = eff[`pause${c[0]!.toUpperCase()}${c.slice(1)}`];
              return (
                <button key={c} onClick={() => act(`/workers/${c}/${paused ? "resume" : "pause"}`)} className={`focus-ring rounded-lg border px-3 py-1.5 text-sm ${paused ? "border-warn/40 text-warn" : "border-line text-mist hover:text-frost"}`}>
                  {paused ? `Resume ${c}` : `Pause ${c}`}
                </button>
              );
            })}
          </div>
        </div>
        <div className="card p-5">
          <h2 className="text-sm font-semibold">Payout wallet</h2>
          <p className="mt-2 break-all font-mono text-xs text-mist">{status.payoutWallet.publicKey ?? "not configured"}</p>
          <p className="mt-3 text-2xl font-semibold">{status.payoutWallet.balance ? sol(status.payoutWallet.balance) : "—"} <span className="text-sm text-mist">SOL</span></p>
          <p className="mt-1 text-xs text-mist">Mode: <span className={status.payoutWallet.mode === "live" ? "text-warn" : "text-frost"}>{status.payoutWallet.mode}</span> · rounds awaiting funds: {status.awaitingFundsRounds}</p>
          {status.halt && (
            <div className="mt-3 rounded-lg border border-bad/40 bg-bad/10 p-3 text-xs text-bad">
              ✕ Payouts halted: {status.halt.reason}
              <button onClick={() => { const r = prompt("Reason for clearing the halt (audited):"); if (r) act("/halt/clear", { reason: r }); }} className="focus-ring mt-2 block underline">Clear halt…</button>
            </div>
          )}
        </div>
      </section>

      {status.failedPayouts.length > 0 && (
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-bad">✕ Failed payouts</h2>
          <p className="mt-1 text-xs text-mist">Every attempt below is proven dead (expired or failed at finalized); requeueing cannot double pay.</p>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {status.failedPayouts.map((p: any) => (
                <tr key={p._id} className="border-t border-line/60">
                  <td className="py-2">#{p.roundNumber}</td>
                  <td className="py-2 font-mono text-xs">{shortAddress(p.recipient, 5, 5)}</td>
                  <td className="py-2 tabular">{sol(p.amount, 6)} SOL</td>
                  <td className="py-2 text-xs text-mist">{p.lastError}</td>
                  <td className="py-2 text-right"><button onClick={() => act(`/payouts/${p._id}/requeue`)} className="focus-ring rounded border border-line px-2 py-1 text-xs hover:text-frost">Requeue</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card p-5">
        <h2 className="text-sm font-semibold">Configuration</h2>
        <p className="mt-1 text-xs text-mist">Values shown are effective (environment default unless overridden). Secrets are environment-only and never shown.</p>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          {FIELDS.map((g) => (
            <fieldset key={g.group} className="space-y-3">
              <legend className="eyebrow mb-2">{g.group}</legend>
              {g.fields.map((f) => {
                const current = f.key === "payoutAsset" ? toInput(f, cfg.overrides.payoutAsset ?? "SOL") : toInput(f, eff[f.key]);
                const value = draft[f.key] ?? current;
                const isCritical = cfg.criticalKeys.includes(f.key);
                const id = `f-${f.key}`;
                return (
                  <div key={f.key}>
                    <label htmlFor={id} className="flex items-center gap-2 text-xs text-mist">
                      {f.label} {isCritical && <span className="rounded border border-warn/40 px-1 text-[10px] text-warn">critical</span>} {f.key in cfg.overrides && <span className="text-[10px] text-series">overridden</span>}
                    </label>
                    {f.kind === "select" || f.kind === "bool" ? (
                      <select id={id} value={value} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} className="focus-ring mt-1 w-full rounded-lg border border-line bg-carbon px-3 py-2 text-sm">
                        {(f.kind === "bool" ? ["true", "false"] : f.options!).map((o) => <option key={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input id={id} value={value} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} className="focus-ring mt-1 w-full rounded-lg border border-line bg-carbon px-3 py-2 font-mono text-sm" />
                    )}
                    {f.help && <p className="mt-1 text-[11px] text-dim">{f.help}</p>}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>
        {Object.keys(changes).length > 0 && (
          <div className="mt-6 rounded-xl border border-line-strong bg-black/20 p-4">
            <h3 className="text-sm font-semibold">Review {Object.keys(changes).length} change(s)</h3>
            <ul className="mt-2 space-y-1 font-mono text-xs">
              {Object.entries(changes).map(([k, v]) => <li key={k}><span className="text-mist">{k}</span> → {JSON.stringify(v)}</li>)}
            </ul>
            <label className="mt-3 block text-xs text-mist" htmlFor="reason">Reason (recorded in the audit log{critical.length ? ", required" : ""})</label>
            <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} className="focus-ring mt-1 w-full rounded-lg border border-line bg-carbon px-3 py-2 text-sm" />
            {critical.length > 0 && (
              <label className="mt-3 flex items-start gap-2 text-sm text-warn">
                <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-1" />
                I confirm changing critical settings ({critical.join(", ")}). Reward parameters apply from the next snapshot; provider/pool changes re-initialise the indexer.
              </label>
            )}
            <div className="mt-4 flex gap-2">
              <button onClick={save} disabled={critical.length > 0 && (!confirm || !reason.trim())} className="focus-ring rounded-lg bg-frost px-4 py-2 text-sm font-semibold text-void disabled:opacity-40">Save changes</button>
              <button onClick={() => setDraft({})} className="focus-ring rounded-lg border border-line px-4 py-2 text-sm text-mist">Discard</button>
            </div>
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-semibold">Audit log</h2>
        <table className="mt-3 w-full text-xs">
          <tbody>
            {audit.map((a) => (
              <tr key={a._id} className="border-t border-line/60 align-top">
                <td className="py-2 pr-3 text-mist">{dateTime(a.at)}</td>
                <td className="py-2 pr-3 font-mono">{shortAddress(a.actor, 4, 4)}</td>
                <td className="py-2 pr-3">{a.action}</td>
                <td className="py-2 pr-3 font-mono text-mist">{a.changes.map((c: any) => `${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join("; ")}</td>
                <td className="py-2 text-mist">{a.reason}</td>
              </tr>
            ))}
            {!audit.length && <tr><td className="py-2 text-mist">No changes recorded.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
