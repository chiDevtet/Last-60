"use client";
/**
 * Wallets & launch (admin). Generate the payout and creator wallets, see their balances, back them up, and
 * see the pool derived from the token mint before launch.
 *
 * Key material never passes through the API in the clear:
 *   - "Generate" only records a request; the rewards worker creates the key pair and stores it encrypted.
 *   - "Export private key" creates a one-time key pair HERE, has your admin wallet sign an export intent
 *     naming this browser's key, and the rewards worker seals the secret to that key. Only this tab can open
 *     it; the API and database relay ciphertext, delivered once. Nothing is written to storage.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import bs58 from "bs58";
import { EXPORT_MAX_TTL_MS, exportIntentMessage, newExportRequest, openExport, type ExportWalletRole } from "@last60/shared";
import { dateTime, shortAddress, sol } from "@/lib/format";

type Call = (p: string, i?: RequestInit) => Promise<any>;
export type SignMessage = (message: string) => Promise<{ signature: string; address: string }>;

const ROLES: { role: ExportWalletRole; title: string; blurb: string }[] = [
  { role: "payout", title: "Payout wallet", blurb: "Holds the SOL that buyer rewards are paid from. Creator settlements and sweeps arrive here." },
  { role: "creator", title: "Creator wallet", blurb: "The launch creator: claims bonding-curve fees, sends 75 % to the payout wallet and sweeps Forge's post-migration payouts — automatically." },
];

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
      className="focus-ring rounded border border-line px-2 py-0.5 text-[11px] text-mist hover:text-frost"
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** The revealed key, held in component state only, wiped on "Hide" / unmount. */
function Revealed({ role, address, secret, onHide }: { role: string; address: string; secret: Uint8Array; onHide: () => void }) {
  const b58 = bs58.encode(secret);
  useEffect(() => () => void secret.fill(0), [secret]);
  const download = () => {
    const blob = new Blob([JSON.stringify(Array.from(secret))], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `last60-${role}-${address.slice(0, 6)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs">
      <p className="font-semibold text-warn">Private key — anyone who sees it controls this wallet.</p>
      <p className="mt-1 text-mist">Store it offline (password manager / paper). To launch from the creator wallet, import it in Phantom: Add account → Import private key.</p>
      <div className="mt-2 flex items-start gap-2">
        <code className="block flex-1 break-all rounded bg-black/40 p-2 font-mono text-[11px] text-frost">{b58}</code>
        <Copy text={b58} />
      </div>
      <div className="mt-2 flex gap-2">
        <button onClick={download} className="focus-ring rounded border border-line px-2 py-1 text-[11px] text-mist hover:text-frost">Download keypair file (Solana CLI JSON)</button>
        <button onClick={onHide} className="focus-ring rounded border border-line px-2 py-1 text-[11px] text-mist hover:text-frost">Hide</button>
      </div>
    </div>
  );
}

export function WalletsPanel({ call, signMessage }: { call: Call; signMessage: SignMessage }) {
  const [data, setData] = useState<any>(null);
  const [launch, setLaunch] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ role: string; address: string; secret: Uint8Array } | null>(null);
  const [mint, setMint] = useState("");
  const [derived, setDerived] = useState<any>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const [w, l] = await Promise.all([call("/wallets"), call("/launch")]);
    if (!alive.current) return;
    setData(w);
    setLaunch(l);
  }, [call]);
  useEffect(() => {
    alive.current = true;
    load().catch((e) => setErr(e.message));
    const id = setInterval(() => load().catch(() => undefined), 5_000);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [load]);

  async function generate(role: ExportWalletRole) {
    if (!confirm(`Generate a new ${role} wallet?\n\nThe rewards worker creates the key and stores it encrypted. All Last-60 processes then restart automatically (about 15 seconds) to load it. Export a backup right after.`)) return;
    setErr(null);
    setMsg(null);
    setBusy(`gen:${role}`);
    try {
      await call(`/wallets/${role}/generate`, { method: "POST", body: JSON.stringify({ reason: "generated from the admin console" }) });
      setMsg(`Generating the ${role} wallet… it appears below within a few seconds (requires the rewards worker to be running).`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function exportKey(role: ExportWalletRole, address: string) {
    if (!confirm(`Reveal the ${role} wallet's private key in this browser?\n\nYour admin wallet will ask you to sign an export request. The key is encrypted end to end to this tab and delivered once.`)) return;
    setErr(null);
    setMsg(null);
    setBusy(`exp:${role}`);
    const req = newExportRequest();
    try {
      const expiresAt = new Date(Date.now() + EXPORT_MAX_TTL_MS - 30_000).toISOString();
      const message = exportIntentMessage({ site: data?.site ?? window.location.host, role, address, requestId: req.requestId, browserKey: req.browserKey, expiresAt });
      const { signature } = await signMessage(message);
      const r = await call(`/wallets/${role}/export`, { method: "POST", body: JSON.stringify({ requestId: req.requestId, message, signature }) });
      if (!r.accepted) throw new Error(`export refused: ${r.reason}`);
      setMsg("Waiting for the rewards worker to seal the key to this browser…");
      const deadline = Date.parse(expiresAt);
      for (;;) {
        if (Date.now() > deadline) throw new Error("export expired before the rewards worker answered (is it running?)");
        await new Promise((res) => setTimeout(res, 1_500));
        const t = await call(`/wallets/exports/${req.requestId}`);
        if (t.status === "refused") throw new Error(`the rewards worker refused the export: ${t.reason}`);
        if (t.status === "consumed" || t.status === "expired") throw new Error(`export ${t.status}`);
        if (t.status !== "ready") continue;
        const secret = await openExport(req.secret, t.sealed, req.requestId);
        setRevealed({ role, address, secret });
        setMsg(null);
        await load();
        return;
      }
    } catch (e) {
      setErr((e as Error).message);
      setMsg(null);
    } finally {
      req.secret.fill(0);
      setBusy(null);
    }
  }

  async function derive() {
    setErr(null);
    try {
      setDerived(await call(`/launch/derive?mint=${encodeURIComponent(mint.trim())}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!data || !launch) return <section className="card p-5 text-sm text-mist">{err ? `✕ ${err}` : "Loading wallets…"}</section>;
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold">Wallets & launch</h2>
      <p className="mt-1 text-xs text-mist">Generated keys are created and stored encrypted by the rewards worker; this page never receives a key unless you export it.</p>
      {msg && <p className="mt-3 rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-xs text-good">{msg}</p>}
      {err && <p className="mt-3 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">✕ {err}</p>}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {ROLES.map(({ role, title, blurb }) => {
          const w = data.wallets[role];
          const pending = w.vault?.status === "requested";
          return (
            <div key={role} className="rounded-xl border border-line p-4">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{title}</h3>
                {w.source && <span className="rounded border border-line px-1.5 text-[10px] text-mist">{w.source === "vault" ? "generated" : "environment"}</span>}
                {w.pendingRestart && <span className="text-[10px] text-warn">◷ restarting processes to load it</span>}
              </div>
              <p className="mt-1 text-[11px] text-dim">{blurb}</p>
              {w.address ? (
                <>
                  <div className="mt-3 flex items-center gap-2">
                    <code className="break-all font-mono text-xs">{w.address}</code>
                    <Copy text={w.address} />
                  </div>
                  <p className="mt-2 text-xl font-semibold">{w.balanceLamports !== null ? sol(w.balanceLamports, 6) : "—"} <span className="text-sm text-mist">SOL</span></p>
                  {role === "creator" && (
                    <p className="mt-2 text-[11px] text-mist">
                      Fund this address with a little SOL for network fees (≈0.05 SOL), then <b>launch the token from this wallet</b> (export → import into Phantom) so it is the pool&apos;s on-chain creator. Last-60 refuses to sign for a wallet that is not the creator.
                    </p>
                  )}
                  {w.source === "vault" && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button disabled={!!busy} onClick={() => exportKey(role, w.address)} className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs text-mist hover:text-frost disabled:opacity-40">
                        {busy === `exp:${role}` ? "Exporting…" : "Export private key"}
                      </button>
                      <span className={`text-[11px] ${w.vault?.lastExportedAt ? "text-mist" : "text-warn"}`}>{w.vault?.lastExportedAt ? `last backed up ${dateTime(w.vault.lastExportedAt)}` : "⚠ not backed up yet"}</span>
                    </div>
                  )}
                  {revealed?.role === role && <Revealed role={role} address={revealed.address} secret={revealed.secret} onHide={() => setRevealed(null)} />}
                </>
              ) : pending ? (
                <p className="mt-3 text-xs text-warn">◷ Generation requested {dateTime(w.vault.requestedAt)} — waiting for the rewards worker.</p>
              ) : (
                <button disabled={!!busy} onClick={() => generate(role)} className="focus-ring mt-3 rounded-lg bg-frost px-3 py-1.5 text-xs font-semibold text-void disabled:opacity-40">
                  {busy === `gen:${role}` ? "Requesting…" : `Generate ${title.toLowerCase()}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-xl border border-line p-4">
        <h3 className="text-sm font-semibold">Launch</h3>
        <div className="mt-2 space-y-1 text-xs">
          <p><span className="text-mist">Token mint:</span> <span className="font-mono">{launch.tokenMint ?? "not set — set it in Configuration below"}</span></p>
          <p>
            <span className="text-mist">Pool:</span> <span className="font-mono">{launch.poolAddress ? shortAddress(launch.poolAddress, 6, 6) : "—"}</span>{" "}
            {launch.poolAddressSource === "derived" && <span className="rounded border border-line px-1 text-[10px] text-mist">derived from the mint</span>}{" "}
            {launch.poolExists === true && <span className="text-good">✓ live on chain</span>}
            {launch.poolExists === false && <span className="text-warn">◷ not created yet — workers wait for the launch, then start automatically</span>}
          </p>
        </div>
        <div className="mt-3 flex gap-2">
          <input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Check another token mint…" className="focus-ring flex-1 rounded-lg border border-line bg-carbon px-3 py-1.5 font-mono text-xs" />
          <button onClick={derive} disabled={mint.trim().length < 32} className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs text-mist hover:text-frost disabled:opacity-40">Derive pool</button>
        </div>
        {derived && (
          <p className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-mist">Raydium LaunchLab pool (SOL quote):</span> <code className="font-mono">{derived.poolAddress}</code> <Copy text={derived.poolAddress} />
            <span className={derived.poolExists ? "text-good" : "text-mist"}>{derived.poolExists ? "exists" : "not created yet"}</span>
          </p>
        )}
        <p className="mt-2 text-[11px] text-dim">Set the token mint in Configuration and leave the pool address empty: the pool is derived automatically. A pool quoted in another token (e.g. USD1) must be entered explicitly.</p>
      </div>
    </section>
  );
}
