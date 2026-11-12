# Wallets from the admin console, and the pool before launch

The admin page (**Wallets & launch**) can generate — or **import** — the **payout wallet** and the **creator wallet**, show
their balances, back them up, and show the pool derived from the token mint before the token is launched.
No environment variable has to be edited for any of it.

## 1. Generate a wallet

1. Admin page → **Wallets & launch** → **Generate payout wallet** / **Generate creator wallet**.
2. The API only records the request. The **rewards worker** (the only process with the vault key) creates
   the key pair within seconds and stores the secret key **encrypted** (AES-256-GCM; the role and address
   are bound in as associated data, so an entry cannot be swapped or tampered with undetected).
3. Every Asteroid Protocol process notices the new wallet and restarts itself (PM2 restarts it, about 15 s). They
   then use it exactly as if its address had been set in the environment: the payout wallet becomes the
   payout signer, a funding destination and the custody destination; the creator wallet drives the
   creator wallet automation (docs/CREATOR_WALLET.md) and claims fees.
4. **Export a backup right away** (§2). The page shows "⚠ not backed up yet" until you do.

A generated wallet is never replaced from the admin console (the creator wallet can be **cleared** first, §2b). A wallet configured in the environment
(`LAST60_PAYOUT_WALLET_*`, `LAST60_CREATOR_WALLET_*`) takes precedence and cannot be generated over; an
environment address that differs from a generated one is a configuration error (the processes refuse to
start rather than guess).

### Where the key is kept

| What | Where | Alone, it reveals |
|---|---|---|
| Encrypted secret keys, addresses | MongoDB `wallet_vault` | nothing (ciphertext) |
| Vault key (32 random bytes) | a file on the rewards host, created on first use: `~/.last60/wallet-vault.key` (mode 600, directory 700, outside the repository so redeploys keep it); override the path with `LAST60_WALLET_VAULT_KEY_PATH`, or supply the key itself with `LAST60_WALLET_VAULT_KEY` (base64) | nothing (no ciphertext) |

Only the rewards worker reads the vault key. The API, indexer and web never can; they only ever see
addresses. The rewards worker refuses to start (exit 78, no PM2 loop) if the vault key is missing, readable
by group/others, or not the key the wallets were encrypted with; it never generates a wallet under a
different key than the existing ones.

**If the rewards host's disk is lost, the vault key goes with it** — that is why you export a backup.
Copying `~/.last60/wallet-vault.key` somewhere safe (it is useless without the database) is a second option.

## 2. Export a private key (backup, or import into Phantom)

Admin page → **Export private key**. You need it for a backup, and for the creator wallet to **launch the
token from it**: import the key into Phantom (Add account → Import private key) and launch on Forgepad
from that account, so it is the pool's on-chain creator.

How it stays private (end-to-end encrypted, code: `@last60/shared` `walletExport.ts`, engine
`wallets/vault.ts`):

1. The page creates a **one-time X25519 key pair** in the browser tab (memory only).
2. Your **admin wallet signs an export intent**: the site, wallet role and address, a request id, the
   browser's public key and an expiry (≤ 5 minutes).
3. The API checks the intent (signer = the signed-in admin, site, role, address, expiry) and stores it.
4. The rewards worker checks it again — including that the signer is in **its own** `ADMIN_WALLETS` —
   decrypts the wallet and seals the secret key to the browser's public key (X25519 → HKDF-SHA256 →
   AES-256-GCM, request id as salt and associated data).
5. The page fetches the sealed key (once; the ciphertext is then deleted), opens it, and shows it with a
   copy button and a Solana-CLI keypair download. Nothing is stored in the browser.

So neither the API, nor anyone able to write to the database, can obtain a key: they never see it in the
clear, and they cannot substitute their own browser key without your wallet's signature. Every request,
refusal and delivery is recorded (`config_audit`, `wallet_exports`).

**Requirement:** set `ADMIN_WALLETS` (your admin wallet address) in the **rewards worker's** environment
too — the worker trusts only its own list. Without it every export is refused with
`admin_wallets_not_configured_in_rewards_worker`.

On the rewards host, a shell alternative: `bun run cli wallet-export <payout|creator> --yes` (with the
rewards worker's environment) prints the key.

## 2a. Import an existing wallet (e.g. the Phantom wallet you launch from)

Admin page → **Import existing wallet** (shown while a role has no wallet). Paste the private key as
Phantom / Solflare export it (base58) or as a Solana CLI keypair file (JSON array).

1. The page checks the key **in the browser** and shows the address it controls. The key is never sent in
   the clear.
2. It fetches the rewards worker's **import key** — an X25519 public key the worker derives from its vault
   key and publishes on request — and shows its fingerprint. The first import **pins** that key in this
   browser; if it ever changes, the page warns you before going on (expected only if the vault key was
   replaced). Compare the fingerprint on the rewards host with `bun run cli wallets`
   (`importKey.fingerprintFromVaultKey`).
3. Your **admin wallet signs an import intent**: site, wallet role, the address being imported, a request
   id, the worker key the browser encrypts to, and an expiry (≤ 5 minutes).
4. The page seals the key to the worker key (one-time X25519 key → HKDF-SHA256 → AES-256-GCM, with a label
   distinct from exports) and sends only the ciphertext.
5. The API checks the intent (signer = the signed-in admin, site, role, expiry, the worker key it published)
   and stores the sealed key.
6. The rewards worker re-checks everything itself — the signer must be in **its own** `ADMIN_WALLETS`, and
   the browser must have encrypted to **its own** import key — decrypts, verifies the key really controls
   the signed address, then stores it encrypted at rest exactly like a generated wallet (marked
   `imported`). The sealed copy is deleted. All processes restart to load it.

Refusals are shown on the page and the terminal (`key_does_not_control_the_signed_address`,
`cannot_decrypt_sealed_key`, `encrypted_to_an_unknown_key`, `signer_not_in_rewards_worker_admin_wallets`,
…); you can retry after a refusal. `encrypted_to_an_unknown_key` is raised as an ERROR: the browser
encrypted to a key that is not the worker's, which can mean the API server was tampered with — check it
before retrying.

The same rules as generation apply: an imported wallet is never replaced from the admin page (clear the creator wallet first, §2b), an
environment wallet always wins, and one key cannot be both the payout and the creator wallet.

**What import protects and what it does not.** Nobody who can write to the database can store a key of
their own as your payout wallet (the worker requires your admin wallet's signature over the exact address),
and the API never sees the key. The one thing the browser must trust is the worker's import key, which it
receives through the API: a compromised API could serve its own key on a **first** import from a fresh
browser. The pin (and the fingerprint you can compare on the server) is the defence; the worker also
refuses — loudly — anything encrypted to a key that is not its own.

## 2b. Clear the creator wallet (for a new launch)

Each launch has its own creator wallet. To launch a new token from a fresh one, press **Clear wallet** on
the creator wallet in the admin page, confirm, and type its full address. Then generate or import the new
one as usual.

* Only the creator wallet can be cleared. The payout wallet and environment wallets (`LAST60_CREATOR_WALLET_*`)
  cannot; remove an environment wallet from the environment instead.
* Clearing is refused while a creator-wallet transfer (a 75 % settlement or a sweep) is still in flight;
  try again a minute later.
* Nothing is deleted. The encrypted entry moves unchanged to `wallet_vault_retired` (still bound to its
  role and address, still under the vault key), so the old key, and any SOL left in it, can be recovered
  on the rewards host with `loadRetiredKeypair(db, cfg, "<archive id>")`. The admin page cannot export a
  cleared wallet, so **export a backup before clearing** if you may need it.
* From then on Asteroid Protocol no longer claims fees or settles for the previous token's creator. All
  processes restart (about 15 s) without a creator wallet. The page lists previously cleared addresses,
  and the action is recorded in the configuration audit (`wallet_retire`).

## 3. Fund the wallets

* **Creator wallet:** a little SOL for network fees (≈ 0.05 SOL; the automation always keeps
  `LAST60_CREATOR_FEE_RESERVE_LAMPORTS`, default 0.002 SOL). Copy the address from the admin page.
* **Payout wallet:** an operating balance for payout fees (docs/PAYOUT_WALLET.md §7). Rewards themselves
  arrive from the creator wallet automatically.

## 4. The pool before launch

A Raydium LaunchLab (Forgepad) pool address is a program-derived address of the token mint:
`PDA(["pool", token mint, WSOL], LaunchLab program)`. So:

* Set **Token mint** in the admin Configuration (or `TOKEN_MINT` in the environment) and leave **Pool
  address** empty: the pool is derived (shown as "derived from the mint").
* Before launch the indexer and rewards worker show **waiting for launch** (not an error) and retry; the
  moment the pool exists on chain they attach and start, with no further action.
* **Derive pool** on the admin page checks any mint (and whether its pool exists yet).
* A pool quoted in another token (e.g. USD1) has a different address: enter it explicitly. Meteora DBC
  pools cannot be derived from the mint (they also depend on their config) and must be entered.

## 5. Launch checklist from the admin page

1. Generate the payout wallet; export a backup.
2. Creator wallet, either way:
   * **generate** it, export it (backup + Phantom import) and fund it; or
   * **import** the Phantom wallet you will launch from (§2a) — it is already funded and backed up.
3. Launch the token on Forgepad **from the creator wallet**.
4. Set the token mint in Configuration (pool derived). This can also be done before step 3.
5. Switch payout mode to `live` when ready (mainnet also needs `ALLOW_MAINNET_PAYOUTS=true` in the rewards
   environment).

From then on: claims, the 75 % settlement, post-migration sweeps and rewards are automatic.

### pump.fun: no token mint to enter

The mint of a pump.fun coin is unknown until it is created, so Asteroid Protocol finds it from the creator
wallet (docs/PROVIDERS.md, "Mint from the creator wallet"):

1. Clear the previous creator wallet if any (§2b), then generate (or import) a **fresh** creator wallet,
   export it into Phantom and fund it.
2. In Configuration set **Launch provider** to `pump_fun` and leave **Token mint** and **Pool address**
   empty (clear them if set). The page shows "watching the creator wallet …".
3. Launch the coin on pump.fun **from that wallet**. Within seconds the indexer detects it, the token mint
   is set ("detected from the creator wallet"), the bonding curve is derived, and the workers attach.
