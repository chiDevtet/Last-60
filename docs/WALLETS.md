# Wallets from the admin console, and the pool before launch

The admin page (**Wallets & launch**) can generate the **payout wallet** and the **creator wallet**, show
their balances, back them up, and show the pool derived from the token mint before the token is launched.
No environment variable has to be edited for any of it.

## 1. Generate a wallet

1. Admin page → **Wallets & launch** → **Generate payout wallet** / **Generate creator wallet**.
2. The API only records the request. The **rewards worker** (the only process with the vault key) creates
   the key pair within seconds and stores the secret key **encrypted** (AES-256-GCM; the role and address
   are bound in as associated data, so an entry cannot be swapped or tampered with undetected).
3. Every Last-60 process notices the new wallet and restarts itself (PM2 restarts it, about 15 s). They
   then use it exactly as if its address had been set in the environment: the payout wallet becomes the
   payout signer, a funding destination and the custody destination; the creator wallet drives the
   creator wallet automation (docs/CREATOR_WALLET.md) and claims fees.
4. **Export a backup right away** (§2). The page shows "⚠ not backed up yet" until you do.

A generated wallet is never replaced from the admin console. A wallet configured in the environment
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
2. Generate the creator wallet; export it (backup + Phantom import); fund it.
3. Launch the token on Forgepad **from the creator wallet**.
4. Set the token mint in Configuration (pool derived). This can also be done before step 3.
5. Switch payout mode to `live` when ready (mainnet also needs `ALLOW_MAINNET_PAYOUTS=true` in the rewards
   environment).

From then on: claims, the 75 % settlement, post-migration sweeps and rewards are automatic.
