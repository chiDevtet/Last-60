# Dedicated Last-60 payout wallet

The payout wallet is a separate Solana keypair, controlled by the operator, that holds the SOL Last-60
pays buyer rewards from. It is the destination of every custody transfer (docs/REWARD_FUNDING.md §14)
and the only wallet reward payouts are signed from.

> Alternatively, generate the payout wallet from the admin page: the rewards worker creates it and keeps it
> encrypted in its vault (docs/WALLETS.md); §4–§5 below then do not apply.
>
> This repository never ships a production key. The operator generates the
> keypair, installs it on the rewards server, and supplies only its **public address** to the rest of
> the configuration. No key appears in this repository, its documentation or its test fixtures (tests
> generate throwaway keys at runtime).

## 1. Variables

| Variable | Process | Meaning |
|---|---|---|
| `LAST60_PAYOUT_WALLET_ADDRESS` | indexer, rewards, api, cli | The public address (base58). Payout destination of custody transfers; the address the signer must derive. Required by the rewards worker. |
| `LAST60_PAYOUT_WALLET_KEYPAIR_PATH` | **rewards only** | Preferred: path to a Solana CLI keypair file (JSON array of 64 bytes), `chmod 600` (group/other access is refused). |
| `LAST60_PAYOUT_WALLET_PRIVATE_KEY` | **rewards only** | Alternative: the 64-byte secret key as base58 (Phantom / Solflare "export private key") or as the JSON array. Set exactly one of the two. |
| `PAYOUT_WALLET_PUBLIC_KEY`, `PAYOUT_WALLET_PRIVATE_KEY`, `PAYOUT_WALLET_KEYPAIR_PATH` | — | Legacy names (PR #1–#8), accepted as aliases. Setting a legacy and a new name to different values is a configuration error. |

Accepted encodings are exactly what `@solana/web3.js` `Keypair.fromSecretKey` accepts: 64 bytes
(32-byte seed + 32-byte public key), as base58 text or a JSON array of integers 0–255. The public half
must match the secret half, and the derived public key must equal `LAST60_PAYOUT_WALLET_ADDRESS`.

## 2. Fail-closed validation

At startup the rewards worker (`apps/worker/src/rewards.ts`) loads the key through the payout signer
(`packages/engine/src/signer/payoutSigner.ts`). The process **exits with code 78** (PM2 does not
hot-loop) when:

| Code | Cause |
|---|---|
| `address_missing` | a key is set but `LAST60_PAYOUT_WALLET_ADDRESS` is not |
| `malformed_key` | not a valid base58 / JSON 64-byte secret key (or the halves do not match) |
| `address_mismatch` | the key derives a different public address |
| `ambiguous_key_sources` | both an inline key and a keypair file are set |
| `insecure_key_file` / `key_file_unreadable` | the keypair file is group/other readable, or cannot be read |

`bun run cli check-config` reports the same problems for the `rewards` role. Messages are fixed,
sanitized strings: they never quote the key (a JSON or base58 parser error could). With **no** key
configured the worker runs, but live payouts stay queued (`no validated payout signer`) — Last-60 never
falls back to a creator wallet or any other wallet.

## 3. What the signer may and may not do

The signer signs **one kind of transaction**: a reward payout whose instructions match a fenced
authorization derived from the payout row the worker has claimed (state `signing`, its fencing token,
live mode, a round that is paying). Construction (`buildUnsignedPayoutTransaction`), authorization
(`authorizePayout`) and signing (`PayoutSigner.signPayout`) are separate steps; the signer re-validates
every instruction: fee payer = payout wallet; only ComputeBudget, one System `transfer` (SOL) or one
idempotent ATA create + one `TransferChecked` (SPL), and an optional memo; recipient, amount and mint
exactly as authorized. Anything else — a second transfer, another recipient, another amount, any other
program or System instruction — is refused.

It never signs fee claims (`FEE_COLLECTION_MODE=auto_claim` requires its own key: `FEE_CLAIM_AUTHORITY_*`
or the creator wallet key), custody sweeps (those are signed by the custodian — or, when configured, by
the separate creator wallet automation with the creator's own key, docs/CREATOR_WALLET.md), or arbitrary transfers, and it cannot change allocations, attribution, eligibility,
ownership or custody records. No API accepts a recipient or amount to pay.

The key lives in a JS private field; `JSON.stringify`, `String()` and `util.inspect` render only the
address. Secrets are deleted from `process.env` after loading, logger redaction covers
`*.LAST60_PAYOUT_WALLET_PRIVATE_KEY`, `*.PAYOUT_WALLET_PRIVATE_KEY` and `secrets`, and any `NEXT_PUBLIC_*`
variable containing a secret value is refused at startup.

## 4. Generate the keypair (operator, offline machine recommended)

```bash
solana-keygen new --no-bip39-passphrase --outfile ./last60-payout.json
```

```bash
solana-keygen pubkey ./last60-payout.json
```

* Record the printed public address — this is `LAST60_PAYOUT_WALLET_ADDRESS`.
* Keep an encrypted offline backup of the keypair file (or of a seed phrase if you generate one with
  a passphrase). Anyone holding it can spend the wallet.
* Never paste the key into chat, tickets, the admin console, a `NEXT_PUBLIC_*` variable or Git
  (`*.keypair.json`, `secrets/` and `.env.*` are git-ignored; keep it that way).

## 5. Install on the rewards server

```bash
sudo install -d -m 700 -o last60 -g last60 /etc/last60/secrets
```

```bash
sudo install -m 600 -o last60 -g last60 ./last60-payout.json /etc/last60/secrets/last60-payout.json
```

Then in `.env.rewards` (chmod 600, owned by the service user):

```
LAST60_PAYOUT_WALLET_ADDRESS=<public address from step 4>
LAST60_PAYOUT_WALLET_KEYPAIR_PATH=/etc/last60/secrets/last60-payout.json
```

Put **only** `LAST60_PAYOUT_WALLET_ADDRESS` in `.env.indexer`, `.env.api` and the CLI environment (the
API warns if a key is present there; it never loads one). Shred the local copy after the backup is
verified.

## 6. Verify (read-only)

```bash
bun run cli check-config
```

```bash
bun run cli payout-wallet
```

`payout-wallet` (also `GET /api/admin/payout-wallet` and the admin console card) reports: the
configured address, whether the rewards worker's signer is configured, whether its derived public key
matches the address, the current SOL balance, the latest confirmed payout and custody reconciliation,
and whether payouts are enabled (and why not). It never returns the key or any representation of it.
The signer status is published by the rewards worker in `system_state.payout_signer_status` (sanitized).

## 7. Fund the wallet for fees

The wallet pays a network fee (base fee + priority fee, ~10 000 lamports budgeted per payout) for every
payout, and keeps `PAYOUT_WALLET_MIN_RESERVE_LAMPORTS` (default 0.01 SOL) untouched. Send an operating
balance for fees from an **operator wallet** (not a launch creator or Forge wallet): such a top-up is not
a launch's contribution and is never recorded as reward funding. Start with ≥ 0.05 SOL plus a day of
expected payouts' fees; the funding report shows the reserve, pending payouts, custodied contributions
and the available liquidity separately.

## 8. Rotation

Rotate only when the funding report shows **no custodied, unconsumed contribution** and no open custody
request: custody verified into the old wallet does not carry over (custody is always checked against the
currently configured wallet, and SOL moved from the old payout wallet is not a custodian's transfer).
Then: pause payouts → wait until no payout is `submitted` → move the remaining operating SOL → change
`LAST60_PAYOUT_WALLET_ADDRESS` everywhere and the key on the rewards server (and the admin
`expectedPayoutPublicKey` override, if set) → restart all processes → resume.
