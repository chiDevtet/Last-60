# API

Bun + Hono, `apps/api`. Public routes are read-only, rate-limited per IP (20 rps, burst 60) and
built exclusively from the whitelisted DTO builders in `packages/engine/src/public/publicData.ts`
(types in `packages/shared/src/dto.ts`). Amounts are base-unit decimal strings.

## Public — `/api/v1`

| Method & path | Returns |
|---|---|
| `GET /health` | `HealthDTO`: database, indexer, rewards, api status from heartbeats; provider, cluster, payout mode |
| `GET /round/current` | `CurrentRoundDTO`: number, start/end, final-window start, server time, phase, buyer count, min buy, reward bps, unique qualifying buyers in the current period |
| `GET /countdown` | compact subset of the above |
| `GET /pool` | `RewardPoolDTO`: period fees, period reward (incl. rollover), retained, pending payouts, distributed 24h / all-time |
| `GET /buys/recent?limit=` | latest buys with qualification flag |
| `GET /rounds?cursor=&limit=` | settled/rolled-over/missed rounds, newest first, cursor = round number |
| `GET /rounds/:n` | `RoundDetailDTO` incl. snapshot slot and payouts (signature only once confirmed) |
| `GET /payouts?cursor=&limit=` | confirmed and simulated payouts |
| `GET /stats` | totals from the ledger |
| `GET /chart?limit=` | fees / reward / recipients per executed round |
| `GET /terminal?before=&limit=` | terminal events, newest first, cursor = seq |
| `GET /dashboard` | everything the home page needs, in one object |
| `GET /stream` | **Server-Sent Events**: `snapshot` (dashboard, every `STREAM_SNAPSHOT_INTERVAL_MS`), `terminal` (each new event), `heartbeat` (15 s) |

One snapshot computation and one terminal query per interval are shared by all SSE clients, so
database load does not grow with the audience. Slow clients have a bounded queue.

**Never returned publicly:** the scheduled execution instant, the random delay, sealed
ciphertexts, locks, in-flight transaction bytes, candidate lists, the instant a round executed
(`settledAt` — the time settlement finished — is published instead). `apps/api/test/api.test.ts`
asserts this across every public route both during the final window and after settlement.

## Admin — `/api/admin`

Wallet-signature authentication (rate-limited 3 rps):

1. `POST /auth/nonce {wallet}` → `{nonce, message, expiresAt}` — only for `ADMIN_WALLETS`; the
   message is bound to `PUBLIC_SITE_URL`'s host, single-use, 5-minute TTL.
2. Sign `message` with the wallet (ed25519, `solana:signMessage`).
3. `POST /auth/verify {wallet, nonce, signature}` → `{token, expiresAt}` (HMAC session,
   `ADMIN_SESSION_TTL_SECONDS`). Send as `Authorization: Bearer <token>`. Tokens are re-checked
   against `ADMIN_WALLETS` on every request, so removing a wallet revokes it immediately.

| Method & path | Purpose |
|---|---|
| `GET /me` | current admin |
| `GET /config` | settings version, overrides, effective settings (RPC keys masked), redacted environment, critical keys |
| `PUT /config {patch, expectedVersion, reason?, confirmCritical?}` | validated update; `null` removes an override; critical keys require `confirmCritical` + `reason`; `409` on a stale version |
| `GET /audit` | change history |
| `GET /status` | workers, payout halt, pool, recent reconciliation reports, failed payouts, payout wallet balance |
| `POST /workers/:indexer\|payouts\|scheduler/:pause\|resume` | audited kill switches |
| `POST /payouts/:id/requeue` | requeue a `failed` payout |
| `POST /halt/clear {reason}` | clear a reconciliation halt |
| `GET /reconciliation`, `GET /payouts?state=` | reports, payout rows |

Runtime-editable settings: launch provider, token mint, pool, fee role, buyer count, minimum buy,
reward bps, minimum payout, skipped-round policy, excluded wallets, payout asset, payout mode,
expected payout public key, fee collection mode, RPC/WS endpoints, indexer polling/websocket,
pause flags. **Secrets are environment-only** and can never be set or read through the API.
Enabling live payouts on mainnet additionally requires `ALLOW_MAINNET_PAYOUTS=true` in the
environment.
