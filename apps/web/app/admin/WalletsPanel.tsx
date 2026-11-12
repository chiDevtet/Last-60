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
 *   - "Import existing wallet" parses the pasted key HERE (it never leaves the tab in the clear), seals it to
 *     the rewards worker's published import key, and has your admin wallet sign an intent naming the address
 *     and that worker key. The worker key is pinned in this browser on first use; a change is flagged.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import bs58 from "bs58";
import { EXPORT_MAX_TTL_MS, exportIntentMessage, importIntentMessage, keyFingerprint, newExportRequest, openExport, parseSolanaSecretKey, sealImport, type ExportWalletRole } from "@last60/shared";
import { dateTime, shortAddress, sol } from "@/lib/format";

type Call = (p: string, i?: RequestInit) => Promise<any>;
export type SignMessage = (message: string) => Promise<{ signature: string; address: string }>;

const ROLES: { role: ExportWalletRole; title: string; blurb: string }[] = [
  { role: "payout", title: "Payout wallet", blurb: "Holds the SOL that buyer and holder rewards are paid from. Creator settlements and sweeps arrive here." },
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
    a.download = `asteroid-protocol-${role}-${address.slice(0, 6)}.json`;
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

const PIN_KEY = "last60.admin.importKey";
const readPin = () => {
  try {
    return localStorage.getItem(PIN_KEY);
  } catch {
    return null;
  }
};
const writePin = (k: string) => {
  try {
    localStorage.setItem(PIN_KEY, k);
  } catch {
    /* storage unavailable: no pin, every import asks for the fingerprint check */
  }
};

/** Import a private key the admin already holds (e.g. the Phantom wallet the token was launched from). */
function ImportForm({ role, title, call, signMessage, site, onDone, onError }: { role: ExportWalletRole; title: string; call: Call; signMessage: SignMessage; site: string | null; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = text.trim() ? parseSolanaSecretKey(text) : null;
  const clear = () => setText("");
  useEffect(() => clear, []); // never keep a pasted key around after the form closes

  async function submit() {
    if (!parsed || "error" in parsed) return;
    setBusy(true);
    const secretKey = Uint8Array.from(parsed.secretKey);
    try {
      // 1. The rewards worker's import key (published on request; it may take a couple of seconds).
      let k: any = null;
      for (let i = 0; i < 20; i++) {
        k = await call("/wallets/import-key");
        if (k.status === "ready") break;
        await new Promise((r) => setTimeout(r, 1_500));
      }
      if (k?.status !== "ready") throw new Error("the rewards worker did not publish its import key (is it running?)");
      // 2. Pin it on first use; a different key later is a red flag (it could mean the API was tampered with).
      const pinned = readPin();
      if (pinned && pinned !== k.publicKey) {
        const ok = confirm(`WARNING: the rewards worker's import key changed.\n\nPinned: ${keyFingerprint(pinned)}\nNow:    ${k.fingerprint}\n\nThis is expected only if the vault key was replaced on the rewards server. Check it there with: bun run cli wallets\n\nContinue and trust the new key?`);
        if (!ok) throw new Error("import cancelled: worker key changed");
      } else if (!pinned) {
        const ok = confirm(`First import from this browser.\n\nRewards worker import key fingerprint: ${k.fingerprint}\n(you can compare it on the rewards server with: bun run cli wallets)\n\nTrust this key?`);
        if (!ok) throw new Error("import cancelled");
      }
      writePin(k.publicKey);
      if (!confirm(`Import ${parsed.address} as the ${title.toLowerCase()}?\n\nYour admin wallet will ask you to sign. The key is encrypted in this browser before it is sent. All Asteroid Protocol processes restart (about 15 s) to load it.`)) throw new Error("import cancelled");
      // 3. Sign the intent (address + worker key), seal the key to the worker, send ciphertext only.
      const requestId = newExportRequest().requestId;
      const message = importIntentMessage({ site: site ?? window.location.host, role, address: parsed.address, requestId, workerKey: k.publicKey, expiresAt: new Date(Date.now() + EXPORT_MAX_TTL_MS - 30_000).toISOString() });
      const { signature } = await signMessage(message);
      const sealed = await sealImport(secretKey, k.publicKey, requestId);
      const r = await call(`/wallets/${role}/import`, { method: "POST", body: JSON.stringify({ requestId, message, signature, sealed }) });
      if (!r.accepted) throw new Error(`import refused: ${r.reason}`);
      clear();
      onDone(`Importing ${parsed.address} as the ${title.toLowerCase()}… processes restart in about 15 seconds to load it.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      secretKey.fill(0);
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-line p-3">
      <label className="text-[11px] text-mist" htmlFor={`imp-${role}`}>Private key (base58 from Phantom / Solflare, or a Solana CLI JSON array)</label>
      <input id={`imp-${role}`} type="password" autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} className="focus-ring mt-1 w-full rounded-lg border border-line bg-carbon px-3 py-1.5 font-mono text-xs" />
      {parsed && "error" in parsed && <p className="mt-1 text-[11px] text-bad">✕ {parsed.error}</p>}
      {parsed && "address" in parsed && <p className="mt-1 text-[11px] text-good">✓ Key for <span className="font-mono">{parsed.address}</span></p>}
      <p className="mt-1 text-[11px] text-dim">The key is checked and encrypted in this browser; the server never receives it in the clear.</p>
      <button disabled={busy || !parsed || "error" in parsed} onClick={submit} className="focus-ring mt-2 rounded-lg bg-frost px-3 py-1.5 text-xs font-semibold text-void disabled:opacity-40">{busy ? "Importing…" : "Import"}</button>
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
  const [importing, setImporting] = useState<string | null>(null);
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
    if (!confirm(`Generate a new ${role} wallet?\n\nThe rewards worker creates the key and stores it encrypted. All Asteroid Protocol processes then restart automatically (about 15 seconds) to load it. Export a backup right after.`)) return;
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

  async function retire(role: ExportWalletRole, title: string, w: any) {
    const name = title.toLowerCase();
    const bal = w.balanceLamports !== null ? `${sol(w.balanceLamports, 6)} SOL` : "an unknown balance";
    const backup = w.vault?.lastExportedAt ? `last backed up ${dateTime(w.vault.lastExportedAt)}` : w.vault?.origin === "imported" ? "imported — you already hold this key" : "NOT BACKED UP — export it first";
    if (!confirm(`Clear the ${name} ${w.address}?\n\nIt still holds ${bal} (${backup}).\n\nAfter clearing:\n• Asteroid Protocol stops claiming fees and settling for the current token's creator.\n• All processes restart (about 15 s); then you can generate or import a fresh ${name}.\n• The old key is archived encrypted on the server (not deleted), but this page can no longer export it — export a backup first if you might need it.`)) return;
    const typed = prompt(`To confirm, type the full address of the ${name} you are clearing:\n\n${w.address}`);
    if (typed === null) return;
    setErr(null);
    setMsg(null);
    setBusy(`ret:${role}`);
    try {
      await call(`/wallets/${role}/retire`, { method: "POST", body: JSON.stringify({ confirmAddress: typed.trim(), reason: "cleared from the admin console" }) });
      setRevealed(null);
      setMsg(`Cleared the ${name} ${shortAddress(w.address, 6, 6)}. Processes restart in about 15 seconds; then generate or import a fresh ${name} here.`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
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
                {w.source && <span className="rounded border border-line px-1.5 text-[10px] text-mist">{w.source === "vault" ? (w.vault?.origin === "imported" ? "imported" : "generated") : "environment"}</span>}
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
                      Fund this address with a little SOL for network fees (≈0.05 SOL), then <b>launch the token from this wallet</b> (export → import into Phantom) so it is the pool&apos;s on-chain creator. Asteroid Protocol refuses to sign for a wallet that is not the creator.
                    </p>
                  )}
                  {w.source === "vault" && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button disabled={!!busy} onClick={() => exportKey(role, w.address)} className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs text-mist hover:text-frost disabled:opacity-40">
                        {busy === `exp:${role}` ? "Exporting…" : "Export private key"}
                      </button>
                      {w.retirable && (
                        <button disabled={!!busy} onClick={() => retire(role, title, w)} className="focus-ring rounded-lg border border-bad/40 px-3 py-1.5 text-xs text-bad hover:bg-bad/10 disabled:opacity-40">
                          {busy === `ret:${role}` ? "Clearing…" : "Clear wallet"}
                        </button>
                      )}
                      <span className={`text-[11px] ${w.vault?.lastExportedAt || w.vault?.origin === "imported" ? "text-mist" : "text-warn"}`}>{w.vault?.lastExportedAt ? `last backed up ${dateTime(w.vault.lastExportedAt)}` : w.vault?.origin === "imported" ? "imported — you already hold this key" : "⚠ not backed up yet"}</span>
                    </div>
                  )}
                  {revealed?.role === role && <Revealed role={role} address={revealed.address} secret={revealed.secret} onHide={() => setRevealed(null)} />}
                </>
              ) : null}
              {!w.address && w.retired?.length > 0 && (
                <p className="mt-3 text-[11px] text-dim">
                  Previously cleared: {w.retired.slice(0, 3).map((x: any) => `${shortAddress(x.address, 4, 4)} (${dateTime(x.retiredAt)})`).join(", ")} — archived encrypted on the server.
                </p>
              )}
              {w.address ? null : pending ? (
                <p className="mt-3 text-xs text-warn">◷ {w.vault.origin === "imported" ? "Import" : "Generation"} requested {dateTime(w.vault.requestedAt)} — waiting for the rewards worker.</p>
              ) : (
                <>
                  {w.vault?.status === "refused" && <p className="mt-3 text-xs text-bad">✕ Last import refused: {w.vault.refusedReason}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button disabled={!!busy} onClick={() => generate(role)} className="focus-ring rounded-lg bg-frost px-3 py-1.5 text-xs font-semibold text-void disabled:opacity-40">
                      {busy === `gen:${role}` ? "Requesting…" : `Generate ${title.toLowerCase()}`}
                    </button>
                    <button onClick={() => setImporting(importing === role ? null : role)} className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs text-mist hover:text-frost">
                      {importing === role ? "Cancel import" : "Import existing wallet"}
                    </button>
                  </div>
                  {importing === role && (
                    <ImportForm role={role} title={title} call={call} signMessage={signMessage} site={data.site} onDone={(m) => { setImporting(null); setErr(null); setMsg(m); load().catch(() => undefined); }} onError={(m) => { setMsg(null); setErr(m); }} />
                  )}
                </>
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
            {launch.poolAddressSource === "derived" && <span className="rounded border border-line px-1 text-[10px] text-mist">derived from the mint</span>}
            {launch.poolAddressSource === "discovered" && <span className="rounded border border-line px-1 text-[10px] text-mist">found from the mint</span>}{" "}
            {!launch.poolAddress && launch.tokenMint && launch.provider === "meteora_dbc" && <span className="text-warn">◷ waiting for the Meteora DBC pool — found automatically once the token is launched</span>}
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
            <span className="text-mist">{derived.provider === "meteora_dbc" ? "Meteora DBC pool (SOL quote):" : derived.provider === "pump_fun" ? "pump.fun bonding curve (SOL quote):" : "Raydium LaunchLab pool (SOL quote):"}</span>{" "}
            {derived.poolAddress ? (
              <>
                <code className="font-mono">{derived.poolAddress}</code> <Copy text={derived.poolAddress} />
              </>
            ) : null}
            <span className={derived.poolExists ? "text-good" : "text-mist"}>{derived.poolExists ? "exists" : derived.lookup === "ambiguous" ? "several pools use this mint — enter the pool address" : derived.poolExists === false ? "not created yet" : "lookup unavailable"}</span>
          </p>
        )}
        <p className="mt-2 text-[11px] text-dim">Set the token mint in Configuration and leave the pool address empty: a Raydium LaunchLab pool and a pump.fun bonding curve are derived from the mint, a Meteora DBC pool is found on chain from the mint once the token is launched. A pump.fun coin must be created by the creator wallet above (or the wallet declared in EXPECTED_PUMPFUN_CREATOR) for its fees to be distributed. A pool quoted in another token (e.g. USD1) must be entered explicitly.</p>
      </div>
    </section>
  );
}
