# Deployment

## Prerequisites

* **Bun 1.4.4** (the version CI uses; workers, API) and **Node ≥ 20** (Next.js web). Bun ≥ 1.3 installs
  workspaces with the isolated linker, so packages are linked per workspace (`apps/web/node_modules/next`)
  rather than hoisted to the root; scripts that import packages must run from a workspace that depends on them.
* **MongoDB replica set** — Atlas (M10+ for production) or self-hosted `mongod --replSet rs0`. The
  `last60-mongo` PM2 app runs a local single-node set in `./.mongo-dev`; it has no backups, so set
  those up separately, and remove the app when using Atlas.
* **Solana RPC** with WebSocket — a paid provider (e.g. Helius) is strongly recommended. The public
  endpoint works for read-only testing but rate-limits busy pools. Budget ≈ one `getTransaction`
  per pool transaction plus a few calls per second.
* **PM2** (`npm i -g pm2`) or any supervisor (systemd, Kubernetes).
* TLS reverse proxy (nginx, Caddy) for `last60.fun` (web and API on one domain).

## 1. Install & build

```bash
git clone <repo> last60 && cd last60
bun install --frozen-lockfile
bun run typecheck && bun run test
NEXT_PUBLIC_API_URL=https://last60.fun NEXT_PUBLIC_SITE_URL=https://last60.fun bun run build:web
```
`NEXT_PUBLIC_*` values are compiled into the web bundle at build time.

## 2. Configure (one env file per process)

Start from `.env.example`. Recommended split (all chmod 600):

| File | Contains |
|---|---|
| `.env.indexer` | Solana, provider, rewards params, Mongo, indexer settings. **No keys.** |
| `.env.rewards` | Same + `SCHEDULE_ENCRYPTION_KEY`, `PAYOUT_WALLET_*`, payout/fee-collection settings, and (optional) the creator wallet key `LAST60_CREATOR_WALLET_KEYPAIR_PATH` (docs/CREATOR_WALLET.md). Only `LAST60_CREATOR_WALLET_ADDRESS` goes in the other files. Wallets generated from the admin page need none of these (docs/WALLETS.md); for key export add `ADMIN_WALLETS` here too, and back up `~/.last60/wallet-vault.key` (or export the keys). |
| `.env.api` | Solana (read-only), provider, Mongo, API/admin settings, `ADMIN_SESSION_SECRET`. **No keys, no schedule key.** |
| `.env.web` | `NEXT_PUBLIC_*`, `API_INTERNAL_URL`, `NODE_ENV=production`. |
| `.env.mongo` | `MONGO_PORT` only (for the local `last60-mongo` app). **No secrets.** |

Generate secrets: `openssl rand -base64 32` (schedule key), `openssl rand -base64 48` (session).
Validate everything before starting: `bun run cli check-config` (per role).

## 3. Start

Each process loads **only its own** env file through the runtime (`bun --env-file=.env.<role>`,
`node --env-file` for the web app) — PM2 itself has no env-file option. Do not keep a root `.env`
on production hosts: Bun auto-loads it into any process started without `--env-file`.

```bash
pm2 start ecosystem.config.cjs --only last60-mongo   # wait for :27017
pm2 start ecosystem.config.cjs --only last60-indexer,last60-rewards,last60-api,last60-web
pm2 save && pm2 startup
pm2 logs last60-rewards
```
Start PM2 from a **clean environment**. PM2 copies the calling shell's environment into every app
it starts and saves it in `dump.pm2`, and Bun lets inherited variables override `--env-file`. A stray
export such as an old `SOLANA_RPC_URL` then silently wins over the env files, survives restarts and
reboots, and lands on disk with any tokens the shell held. Wrap PM2 so it never inherits:

```bash
env -i HOME=/root PATH="$PATH" PM2_HOME=/root/.pm2-last60 pm2 start ecosystem.config.cjs
```
Check it with `tr '\0' '\n' < /proc/$(pm2 pid last60-indexer)/environ`: no `SOLANA_*` or other app
variables should appear there, since they come from the env files.

The Bun apps run `bun` as the PM2 command (`script: "bun"`, `interpreter: "none"`), because PM2's
Bun wrapper `require()`s the entrypoint and fails on modules with top-level await. Check `node -v`
first: PM2 and the web app need Node ≥ 20 on `PATH`, which on an nvm host is not always the
system `node`.

Processes: `last60-mongo`, `last60-indexer`, `last60-rewards`, `last60-api`, `last60-web`. Running a second
indexer/rewards instance on another host is safe: it stands by until the leader's lease expires.
Exit code 78 means invalid configuration; PM2 will not restart-loop it.

### Sharing a host with another PM2 daemon

Check `ls ~/.pm2` and `ps aux | grep 'God Daemon'` before starting anything. If another daemon is
already running, give Asteroid Protocol its own `PM2_HOME` and do not share the default one:

```bash
export PM2_HOME=/root/.pm2-last60
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root --service-name pm2-last60
```

**`pm2 startup` ignores `PM2_HOME`** and writes `PM2_HOME=/root/.pm2` and
`PIDFile=/root/.pm2/pm2.pid` into the unit. Correct both lines to the Asteroid Protocol home and run
`systemctl daemon-reload` **before** the first `systemctl start`. A unit left at the default adopts
the other daemon as its main process, and stopping it then kills that daemon and everything it runs.

Once such a unit has been started, do not simply stop it. Set `KillMode=none`, `ExecStop=/bin/true`
and `Restart=no`, run `systemctl daemon-reload`, and `systemctl stop` it. That releases the other
daemon without signalling it, after which the unit can be corrected.

On the production host, use the `pm2-last60` wrapper in `/usr/local/bin`, which sets this
`PM2_HOME`; plain `pm2` talks to the other daemon.

## 4. Reverse proxy (one domain, SSE needs buffering off)

nginx is the only public entry point. The API is served under `/api/` on the site's own domain,
so no `api.` DNS record is needed, and everything else goes to the web app. Issue the certificate
first (webroot, with a deploy hook so renewals reload nginx):

```bash
certbot certonly --webroot -w /var/www/letsencrypt -d last60.fun \
  --deploy-hook 'systemctl reload nginx'
certbot renew --cert-name last60.fun --dry-run
```

```nginx
upstream last60_web { server 127.0.0.1:3060; keepalive 32; }
upstream last60_api { server 127.0.0.1:4000; keepalive 32; }

server {
  listen 80;
  server_name last60.fun;
  location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name last60.fun;
  ssl_certificate     /etc/letsencrypt/live/last60.fun/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/last60.fun/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000" always;

  location /api/v1/stream {
    proxy_pass http://last60_api;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
  }
  location /api/ {
    proxy_pass http://last60_api;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location / {
    proxy_pass http://last60_web;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
In `.env.api` set `CORS_ORIGINS=https://last60.fun`, `PUBLIC_SITE_URL=https://last60.fun` (both
**required** for the API in production), `API_TRUST_PROXY_HOPS=1` (one nginx) and
`API_HOST=127.0.0.1`. The API takes the client address from the right-most X-Forwarded-For entry
appended by your proxy; with `0` it ignores forwarding headers and uses the socket peer.

The web app listens on `127.0.0.1:3060`, not 3000, so it cannot be picked up by another site on a
shared host that proxies to the common Next.js port.

## 5. Go-live sequence (do not skip)

1. **Mock / local** — `LAUNCH_PROVIDER=mock`, `bun run test`.
2. **Mainnet, dry-run** — real token + pool, `PAYOUT_MODE=dry_run`, `FEE_COLLECTION_MODE=manual`,
   and the declared creator allocation (`EXPECTED_*`, see `.env.example`). Confirm the pool's
   `allocation.verification` is `verified` (no `ALLOCATION MISMATCH` warning). Let it run for at least a few
   hours. Check `bun run cli reconcile` reports `ok`, run `scripts/verify-round.ts` on several
   rounds, and review the simulated payouts.
3. **Payout wallet** — generate and install the dedicated keypair (docs/PAYOUT_WALLET.md §4–§5), fund
   it for fees (§7), and confirm `bun run cli payout-wallet` reports the signer configured with a
   matching derived key. Custody (`LAST60_CUSTODY_ENABLED`) and recovery
   (`LAST60_ATTRIBUTION_RECOVERY_ENABLED`) stay off until explicitly wanted. A devnet or small-value
   live test of the payout path is recommended.
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

* `GET https://last60.fun/api/v1/health` — overall + per component (heartbeats older than 30 s
  are `down`). Wire it to uptime monitoring.
* Optional per-worker local endpoints: `WORKER_HEALTH_PORT` (127.0.0.1 only).
* Logs are JSON (pino). Alert on `level >= 50`, on terminal `WARN`/`ERROR`, on
  `awaiting_funds` rounds and on reconciliation status other than `ok`/`shared_vault`.

## Local development

```bash
bun install
bun run dev:mongo                         # local replica set on :27017 (no Docker)
cp .env.example .env && edit              # LAUNCH_PROVIDER=mock for an offline loop, or a real pool + dry_run
bunx concurrently -k "bun run dev:indexer" "bun run dev:rewards" "bun run dev:api" "bun run dev:web"
```
Ctrl+C stops all four. With `cmd & cmd &` only the last command stays in the foreground, and the
rest keep running. Do not run these on the production host: the API collides on port 4000.
Find an active pool for read-only experiments: `bun scripts/find-active-pool.ts raydium_launchlab`.
