# Deployment

## Prerequisites

* **Bun ≥ 1.3** (workers, API) and **Node ≥ 20** (Next.js web).
* **MongoDB replica set** — Atlas (M10+ for production) or self-hosted `mongod --replSet rs0`.
* **Solana RPC** with WebSocket — a paid provider (e.g. Helius) is strongly recommended. The public
  endpoint works for read-only testing but rate-limits busy pools. Budget ≈ one `getTransaction`
  per pool transaction plus a few calls per second.
* **PM2** (`npm i -g pm2`) or any supervisor (systemd, Kubernetes).
* TLS reverse proxy (nginx, Caddy) for `last60.io` (web) and `api.last60.io` (API).

## 1. Install & build

```bash
git clone <repo> last60 && cd last60
bun install --frozen-lockfile
bun run typecheck && bun run test
NEXT_PUBLIC_API_URL=https://api.last60.io NEXT_PUBLIC_SITE_URL=https://last60.io bun run build:web
```
`NEXT_PUBLIC_*` values are compiled into the web bundle at build time.

## 2. Configure (one env file per process)

Start from `.env.example`. Recommended split (all chmod 600):

| File | Contains |
|---|---|
| `.env.indexer` | Solana, provider, rewards params, Mongo, indexer settings. **No keys.** |
| `.env.rewards` | Same + `SCHEDULE_ENCRYPTION_KEY`, `PAYOUT_WALLET_*`, payout/fee-collection settings. |
| `.env.api` | Solana (read-only), provider, Mongo, API/admin settings, `ADMIN_SESSION_SECRET`. **No keys, no schedule key.** |
| `.env.web` | `NEXT_PUBLIC_*`, `API_INTERNAL_URL`. |

Generate secrets: `openssl rand -base64 32` (schedule key), `openssl rand -base64 48` (session).
Validate everything before starting: `bun run cli check-config` (per role).

## 3. Start

Each process loads **only its own** env file through the runtime (`bun --env-file=.env.<role>`,
`node --env-file` for the web app) — PM2 itself has no env-file option. Do not keep a root `.env`
on production hosts: Bun auto-loads it into any process started without `--env-file`.

```bash
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 logs last60-rewards
```
Processes: `last60-indexer`, `last60-rewards`, `last60-api`, `last60-web`. Running a second
indexer/rewards instance on another host is safe: it stands by until the leader's lease expires.
Exit code 78 means invalid configuration; PM2 will not restart-loop it.

## 4. Reverse proxy (SSE needs buffering off)

```nginx
location /api/v1/stream {
  proxy_pass http://127.0.0.1:4000;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 1h;
}
location / { proxy_pass http://127.0.0.1:4000; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
```
Set `CORS_ORIGINS=https://last60.io`, `PUBLIC_SITE_URL=https://last60.io` (both **required** for the
API in production) and `API_TRUST_PROXY_HOPS=1` (one nginx). The API takes the client address from the right-most
X-Forwarded-For entry appended by your proxy; with `0` it ignores forwarding headers and uses the
socket peer. Bind the API to `127.0.0.1` when it sits behind the proxy (`API_HOST`).

## 5. Go-live sequence (do not skip)

1. **Mock / local** — `LAUNCH_PROVIDER=mock`, `bun run test`.
2. **Mainnet, dry-run** — real token + pool, `PAYOUT_MODE=dry_run`, `FEE_COLLECTION_MODE=manual`,
   and the declared creator allocation (`EXPECTED_*`, see `.env.example`). Confirm the pool's
   `allocation.verification` is `verified` (no `ALLOCATION MISMATCH` warning). Let it run for at least a few
   hours. Check `bun run cli reconcile` reports `ok`, run `scripts/verify-round.ts` on several
   rounds, and review the simulated payouts.
3. **Devnet or small-value live test** of the payout wallet path if desired.
4. **Mainnet live** — requires explicit authorization from the project owner:
   `PAYOUT_MODE=live` **and** `ALLOW_MAINNET_PAYOUTS=true` in `.env.rewards`, a funded dedicated
   payout wallet, `PAYOUT_COMMITMENT=finalized`. Watch the first rounds closely. The rewards
   worker re-checks `ALLOW_MAINNET_PAYOUTS` in **its own** environment before every signature, so
   a live override set from the admin console (or written to the database) cannot bypass it;
   such payouts stay queued.
5. Graduation: the indexer verifies the migration and attaches the destination automatically
   (DAMM v2 / CPMM). Check `pools.migration.status = verified` in the admin status (or run
   `bun scripts/resolve-migration.ts …`, exit 0) before relying on post-migration rounds; DAMM v1 /
   AMM v4 destinations are unsupported and are not accounted.

## 6. Health & monitoring

* `GET https://api.last60.io/api/v1/health` — overall + per component (heartbeats older than 30 s
  are `down`). Wire it to uptime monitoring.
* Optional per-worker local endpoints: `WORKER_HEALTH_PORT` (127.0.0.1 only).
* Logs are JSON (pino). Alert on `level >= 50`, on terminal `WARN`/`ERROR`, on
  `awaiting_funds` rounds and on reconciliation status other than `ok`/`shared_vault`.

## Local development

```bash
bun install
bun run dev:mongo                         # local replica set on :27017 (no Docker)
cp .env.example .env && edit              # LAUNCH_PROVIDER=mock for an offline loop, or a real pool + dry_run
bun run dev:indexer & bun run dev:rewards & bun run dev:api & bun run dev:web
```
Find an active pool for read-only experiments: `bun scripts/find-active-pool.ts raydium_launchlab`.
