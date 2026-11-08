# API

Bun + Hono, `apps/api`. CORS: only `CORS_ORIGINS` (required in production; loopback only in development when empty). Public routes are read-only, rate-limited per IP (20 rps, burst 60) and
built exclusively from the whitelisted DTO builders in `packages/engine/src/public/publicData.ts`
(types in `packages/shared/src/dto.ts`). Amounts are base-unit decimal strings.

## Public — `/api/v1`

| Method & path | Returns |
|---|---|
| `GET /health` | `HealthDTO`: database, indexer, rewards, api status from heartbeats; provider, cluster, payout mode |
| `GET /round/current` | `CurrentRoundDTO`: number, start/end, final-window start, server time, phase, buyer count, min buy, reward bps, unique qualifying buyers in the current period |
| `GET /countdown` | compact subset of the above |
| `GET /pool` | `RewardPoolDTO`: payout-eligible creator fees of the current period (bonding pool + verified destination), period reward (incl. rollover), retained, pending payouts, distributed 24h / all-time; `asset.decimals` is the payout mint's on-chain decimals |
| `GET /buys/recent?limit=` | latest buys with qualification flag |
| `GET /rounds?cursor=&limit=` | settled/rolled-over/missed rounds, newest first, cursor = round number |
| `GET /rounds/:n` | `RoundDetailDTO` incl. snapshot slot and payouts (signature only once confirmed) |
| `GET /payouts?cursor=&limit=` | confirmed and simulated payouts |
| `GET /stats` | totals from the ledger |
| `GET /chart?limit=` | fees / reward / recipients per executed round |
| `GET /terminal?before=&limit=` | terminal events, newest first, cursor = seq |
| `GET /dashboard` | everything the home page needs, in one object |
| `GET /stream` | **Server-Sent Events**: `snapshot` (dashboard, every `STREAM_SNAPSHOT_INTERVAL_MS`), `terminal` (each new event), `heartbeat` (15 s). Limited to 4 concurrent streams per client address and 5 000 in total (`429`); each stream closes after 30 min and `EventSource` reconnects |

One snapshot computation and one terminal query per interval are shared by all SSE clients, so
database load does not grow with the audience. Slow clients have a bounded queue.

**Never returned publicly:** the scheduled execution instant, the random delay, sealed
ciphertexts, locks, in-flight transaction bytes, candidate lists, the instant a round executed
(`settledAt` — the time settlement finished — is published instead). `apps/api/test/api.test.ts`
asserts this across every public route both during the final window and after settlement.

## Admin — `/api/admin`

Wallet-signature authentication (rate-limited 3 rps):

1. `POST /auth/nonce {wallet}` → `{nonce, message, signInInput, expiresAt}` — only for
   `ADMIN_WALLETS`; `message` is a Sign-In-With-Solana message bound to `PUBLIC_SITE_URL`'s host
   (required in production — `503` otherwise; never taken from the `Host` header), single-use,
   5-minute TTL.
2. Sign with the wallet: `solana:signIn(signInInput)` (preferred — the wallet checks the domain) or
   `solana:signMessage(message)`.
3. `POST /auth/verify {wallet, nonce, signature, signedMessage?}` → `{token, expiresAt}`.
   `signedMessage` (from `signIn`) must carry exactly the issued SIWS fields; a browser `Origin`
   other than the sign-in site is refused (`403`). Session: HMAC,
   `ADMIN_SESSION_TTL_SECONDS`). Send as `Authorization: Bearer <token>`. Tokens are re-checked
   against `ADMIN_WALLETS` on every request, so removing a wallet revokes it immediately.

| Method & path | Purpose |
|---|---|
| `GET /me` | current admin |
| `GET /config` | settings version, overrides, effective settings (RPC keys masked), redacted environment, critical keys |
| `PUT /config {patch, expectedVersion, reason?, confirmCritical?}` | validated update; `null` removes an override; critical keys require `confirmCritical` + `reason`; `409` on a stale version |
| `GET /audit` | change history |
| `GET /status` | workers, payout halt, pool (incl. allocation basis + verification, warnings, migration status / failed checks), recent reconciliation reports, failed payouts, payout wallet balance |
| `POST /workers/:indexer\|payouts\|scheduler/:pause\|resume` | audited kill switches |
| `POST /payouts/:id/requeue` | requeue a `failed` payout |
| `POST /halt/clear {reason}` | clear a reconciliation halt |
| `GET /reconciliation`, `GET /payouts?state=` | reports, payout rows |
| `GET /payout-wallet` | read-only verification of the dedicated payout wallet: address, signer configured, derived key matches, balance, latest payout / custody reconciliation, payouts enabled (never key material) |
| `GET /funding` | wallet verification + the funding pipeline: (1) attribution, (2) custody, (3) round funding, (4) payouts, liquidity and mismatch, unresolved Forge attributions, recovery attempts |
| `POST /funding/custody {fundingKey, reason?}` | open a sweep request for one credited contribution (`LAST60_CUSTODY_ENABLED`); amount, source and destination are derived, never accepted; `409` with `code` when refused |
| `POST /funding/custody/:custodyId/submit {signature}` | verify a custodian's transaction from the chain and bind it (`422` with the rejection reason) |
| `POST /funding/custody/:custodyId/cancel {reason}`, `GET /funding/custody/:custodyId` | cancel an open request; read one |
| `GET /funding/attributions?status=unresolved\|pending\|linked` | Forge creator-distribution attributions |
| `POST /funding/attributions/recover {attributionKey, requestId?, note?}` | re-run the normal attribution for one unresolved row (`LAST60_ATTRIBUTION_RECOVERY_ENABLED`); strict body — any amount / eligibility / status / collection / correlation field is `400`; returns the append-only audit record (`409` when rejected) |
| `GET /funding/recoveries?attributionKey=` | recovery audit history |

All funding mutations are written to `config_audit` (`custody_request`, `custody_submit`,
`custody_cancel`, `attribution_recovery`) with the admin wallet as actor.

Runtime-editable settings: launch provider, token mint, pool, fee role, buyer count, minimum buy,
reward bps, minimum payout, skipped-round policy, excluded wallets, payout asset, payout mode,
expected payout public key, fee collection mode, RPC/WS endpoints, indexer polling/websocket,
pause flags. **Secrets are environment-only** and can never be set or read through the API.
Enabling live payouts on mainnet additionally requires `ALLOW_MAINNET_PAYOUTS=true` in the
environment.
