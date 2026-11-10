<p align="center"><img src="brand/logo-dark.svg" alt="Asteroid Protocol" height="72"></p>

<p align="center"><b>The final minute pays.</b><br>
Every five minutes, eligible creator fees are allocated to on-chain payouts for the five most
recent unique buyers and five randomly drawn holders — at a moment inside the final 60 seconds chosen
by a secure random draw and kept private until it happens. Payouts are based on verified creator fee
allocations.</p>

<p align="center"><img src="docs/screenshots/dashboard-final-minute.png" alt="Dashboard in the final minute" width="860"></p>

**Who is paid each round.** The five most recent unique wallets with a qualifying buy (`BUYER_COUNT`),
plus five wallets drawn at random from the token's holders (`HOLDER_COUNT`). A holder is eligible with
at least 100,000 tokens (`MIN_HOLDER_TOKENS`, 0.01% of the 1,000,000,000 supply) in its own wallet and
is never one of that round's paid buyers, so no wallet is paid twice in a round. All recipients receive
the same amount. A round with no qualifying buyer pays nobody and its reward rolls over.

> **Formerly LAST60.** The product is now **Asteroid Protocol** ([Brand](docs/BRAND.md)). Internal
> identifiers keep the `last60` namespace so existing deployments, databases and on-chain records stay
> valid: `LAST60_*` environment variables, the `last60:v1:` / `last60:custody:v1:` funding memos and
> `last60:r…` payout memos, the `last60` database, stream ids such as `forge_platform_lp_last60_contribution`,
> the `@last60/*` workspace packages and the `last60-*` PM2 process names.

---

## What's in the box

| | |
|---|---|
| **Rewards engine** (`apps/worker` → `rewards`) | Clock-anchored 5-minute rounds; CSPRNG execution time sealed with AES-GCM and reused across restarts; snapshot at the cluster slot; deterministic unique-buyer selection; integer reward/retained allocation with dust and rollover; one MongoDB transaction per allocation; individual payouts with persisted-before-broadcast signatures and expiry-proven retries; reconciliation that halts on over-attribution. |
| **Indexer** (`apps/worker` → `indexer`) | WebSocket fast path + gap-free cursor polling + backfill; idempotent ingestion; finality tracking and fork exclusion; v1-transaction aware. |
| **Launch providers** | Meteora DBC and Raydium LaunchLab adapters from the official IDLs, validated on real mainnet data; switch with `LAUNCH_PROVIDER` (or live, from the admin console). Strictly verified graduation to Meteora DAMM v2 and Raydium CPMM with post-migration buyer tracking and creator-entitlement accounting. |
| **Creator-fee accounting** | Only fees allocated to the creator by on-chain configuration and position ownership are counted; every record carries gross / allocated / excluded amounts, its allocation basis, evidence and payout eligibility ([Fee accounting](docs/FEE_ACCOUNTING.md)). |
| **Phase-aware reward funding** | Forge's two-phase model kept as seven separate streams: bonding-curve creator fees (25 % creator / 75 % Asteroid Protocol of what is **collected**), CPMM creator fees (direct creator revenue, never funding) and Forge platform LP claims (50 % the creator's allocation, dedicated to Asteroid Protocol / 50 % Forge). Only **observed, finalized, correlated** transfers fund rounds, capped at the expected allocation, once, under the versioned `forge_phase_aware_v2` policy: into an Asteroid Protocol funding destination (same transaction or memo), or — for the creator's 50 % LP allocation — **Forge's existing post-migration payout to the creator's wallet**, attributed to exactly one verified harvest by launch-scoped, complete-index evidence, never by amount; anything ambiguous is recorded and never payable ([Reward funding](docs/REWARD_FUNDING.md)). |
| **API** (`apps/api`) | Public REST + Server-Sent Events from whitelisted DTOs; wallet-signature admin API with audited, version-checked configuration. |
| **Web** (`apps/web`, Next.js 16) | Countdown centerpiece with final-minute intensification, live reward pool, buyer feed, live engine terminal, payout history with Solscan links, stats and charts, admin console, brand page. |
| **Brand** (`brand/`) | Asteroid Protocol identity — logo (light/dark), icon, favicons, social image, X banner, OG image. |

## Quick start (local, no Docker)

```bash
bun install
bun run dev:mongo                     # MongoDB replica set on 127.0.0.1:27017
cp .env.example .env                  # then edit — see below
bun run cli check-config              # validates every process role
bun run dev:indexer & bun run dev:rewards & bun run dev:api & bun run dev:web
open http://localhost:3000
```

Minimum `.env` for a **read-only run against a real pool** (payouts are dry-run by default):

```bash
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=…
LAUNCH_PROVIDER=raydium_launchlab            # or meteora_dbc
TOKEN_MINT=…  POOL_ADDRESS=…  FEE_BENEFICIARY_ROLE=creator
MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true'
SCHEDULE_ENCRYPTION_KEY=$(bun run cli gen-schedule-key)
LAST60_PAYOUT_WALLET_ADDRESS=<dedicated payout wallet address>   # see docs/PAYOUT_WALLET.md
INDEXER_BACKFILL=none
# REWARD_FUNDING_POLICY defaults to forge_phase_aware_v2 (activation slot pinned at first start).
# Wallets can instead be generated from the admin page (docs/WALLETS.md); TOKEN_MINT may be set there too,
# a LaunchLab POOL_ADDRESS is derived from the token mint, a Meteora DBC pool is found from it after launch. Hands-off creator flows: docs/CREATOR_WALLET.md
```
`bun scripts/find-active-pool.ts raydium_launchlab` prints a busy pool to try.

## Tests

```bash
bun run test        # real MongoDB replica set, fault-injecting chain, real Solana runtime (LiteSVM),
                    # real mainnet transaction fixtures — no network, no real keys (count: docs/VERIFICATION.md)
bun run typecheck
bun run build:web
```
CI (`.github/workflows/ci.yml`) runs install (frozen lockfile), test, typecheck and build on every
pull request.

## Verify the engine against the chain

```bash
bun run verify:allocation [--forgepad]                    # declared vs on-chain creator allocation (read-only)
bun run verify:platform-config [ADDRESS] [--pool P]       # decode + explain a LaunchLab PlatformConfig (default: Forgepad's; read-only)
bun run verify:fees meteora_dbc <pool> <mint> creator     # full-history attribution == on-chain counters
bun run verify:round <n> --fees                           # re-derive a round's recipients & fees from public data
bun run report:revenue [--pool P] [--json]                # phase-aware revenue streams, per fee mint (read-only)
bun run cli revenue | revenue-reconcile                   # same report / re-run claim ↔ transfer reconciliation
```

## Documentation

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | processes, rounds, snapshot, payouts, privacy, failure handling |
| [Fee accounting](docs/FEE_ACCOUNTING.md) | formulas, periods, ledger, collection, reconciliation |
| [Reward funding](docs/REWARD_FUNDING.md) | two-phase business model, revenue streams, claim ↔ transfer evidence, how Forge's existing post-migration creator payout is attributed (§4a), funding policy, Forgepad findings, runbook |
| [Payout wallet](docs/PAYOUT_WALLET.md) | the dedicated payout wallet: key generation and installation, fail-closed signer, verification, funding for fees |
| [Wallets & pre-launch](docs/WALLETS.md) | generate the payout / creator wallets from the admin page (encrypted vault, end-to-end encrypted export), pool derived from the token mint before launch |
| [Creator wallet](docs/CREATOR_WALLET.md) | hands-off creator wallet automation: claim bonding fees, send 75 % to the payout wallet, sweep Forge's post-migration creator payouts |
| [Providers](docs/PROVIDERS.md) | Meteora DBC & Raydium LaunchLab internals, graduation support matrix |
| [Database](docs/DATABASE.md) | collections, constraints, state machines, reconstruction |
| [API](docs/API.md) | public, SSE and admin endpoints |
| [Security](docs/SECURITY.md) | keys, money-movement invariants, schedule privacy, admin |
| [Deployment](docs/DEPLOYMENT.md) | build, env split, PM2, reverse proxy, go-live sequence |
| [Operations](docs/OPERATIONS.md) | runbook |
| [Brand](docs/BRAND.md) | name exploration, identity, assets |
| [Verification](docs/VERIFICATION.md) | what was proven, evidence, and what is not done |
| [Audit](docs/AUDIT.md) | production-readiness audit: confirmed issues, fixes, risks, blockers |

## Acceptance criteria — status

| # | Criterion | Status |
|---|---|---|
| 1 | Token mint and pool configurable | ✔ env or admin console (validated against chain on load) |
| 2 | Monitors real qualifying Solana buys | ✔ ran on mainnet (Meteora DBC and Raydium LaunchLab pools) |
| 3 | Unique buyer tracking | ✔ tests + chain-verified recipients for every live round |
| 4 | Independent five-minute rounds | ✔ clock-anchored; runs without API/web |
| 5 | Random execution time survives restarts | ✔ sealed, CAS-persisted, tested; workers restarted mid-run |
| 6 | Accurate eligible-fee accounting | ✔ creator allocation only (gross, protocol, partner and other LP fees excluded); exact full-history reconciliation on two real DBC pools; live rounds match the chain to the lamport. Post-migration accounting verified on real transactions offline, **not yet on a live round** |
| 7 | Reward share calculated correctly | ✔ integer math, property-tested, chain-verified |
| 8 | Individual payouts executed and verified | ✔ on the real Solana runtime (LiteSVM) and fault-injection suite; **live mainnet transfers not sent (not authorized)** |
| 9 | Failed payouts recoverable safely | ✔ expiry-proven retries, max attempts → requeue, tested |
| 10 | Real-time dashboard | ✔ SSE, server-clock-synced countdown |
| 11 | Payout history with verified transactions | ✔ signatures shown only once final, Solscan links (dry-run rounds labelled) |
| 12 | Terminal shows actual worker activity | ✔ every line is a real backend event |
| 13 | Scheduling information stays private | ✔ not in any public response, terminal line, log or admin endpoint (tested) |
| 14 | Provider switch by configuration only | ✔ performed live via the admin API |
| 15 | Runs without the frontend | ✔ separate processes |
| 16 | Phase-aware reward funding (PR #6–#8) | ✔ streams, correlation, reconciliation, policy-gated round funding and CPMM `creator_fee_on` / `CreatorFeeShare` verification; Forge's existing post-migration creator payout recognised with no Forgepad change (PR #8). Tested on real fixtures and synthetic transactions mirroring Forge's flow; **not verified on real Forge harvests** (none existed when written) and **not yet verified funding a live round** (`forge_phase_aware_v2` is now the default policy) ([§4a](docs/REWARD_FUNDING.md#4a-forges-existing-post-migration-creator-distribution), [§13](docs/REWARD_FUNDING.md#13-known-limitations)) |
| 17 | Dedicated payout wallet, custody and recovery (PR #10) | ✔ fail-closed payout signer bound to `LAST60_PAYOUT_WALLET_ADDRESS`; contributions fund rounds only once their SOL is verified in the payout wallet (custody transfers never create a second credit); audited operator re-run of unresolved Forge attributions. Tested on synthetic transactions; custody is on by default under `forge_phase_aware_v2`, recovery is **disabled by default**; **no real custody sweep or mainnet transaction performed** ([§14–§16](docs/REWARD_FUNDING.md#14-physical-custody-getting-credited-sol-into-the-payout-wallet-pr-10)) |
| 18 | Hands-off creator wallet (forge_phase_aware_v2 default) | ✔ `forge_phase_aware_v2` is the default policy with an automatically pinned, shared activation slot; with the creator key in the rewards worker, bonding-curve fees are claimed, 75 % is sent to the payout wallet (memo-correlated, `direct` custody) and Forge's post-migration creator payouts are swept into it (custody, `creator_wallet_sweep`), persisted before broadcast and never repeated. Tested on synthetic transactions on the FakeChain; **no mainnet transaction sent** ([Creator wallet](docs/CREATOR_WALLET.md)) |

**Before going live:** resolve the production blockers in [Audit §7](docs/AUDIT.md) — verify the
real Forgepad pool and declare its allocation (`EXPECTED_*`; undeclared or mismatching allocations
are recorded but never distributed) in dry-run, observe a graduation end-to-end, and run
an authorized small-value payout test — then follow the go-live sequence in
[Deployment](docs/DEPLOYMENT.md). Live mainnet payouts require `PAYOUT_MODE=live` **and**
`ALLOW_MAINNET_PAYOUTS=true`. Fee collection is `manual` unless the launch creator wallet is configured
(then claims, the 75 % settlement and post-migration sweeps are automatic — [Creator wallet](docs/CREATOR_WALLET.md));
verify the creator key against the pool in dry-run first (`bun run cli creator-wallet`).

> `dashboard-final-minute.png` and `dashboard-mobile.png` in `docs/screenshots/` show the Asteroid Protocol
> identity on an offline mock run (dry-run, no trades). The other dashboard screenshots predate the rebrand and the
> copy change: they show the former LAST60 identity and an older percentage headline.

## Layout

```
apps/
  api/        Hono API (public REST, SSE, admin)
  web/        Next.js 16 dashboard, admin console, brand page
  worker/     indexer, rewards and CLI entrypoints
packages/
  engine/     config, db, chain, providers, indexer, rewards, terminal (server-only)
  shared/     DTOs and exact amount formatting (browser-safe)
brand/        identity assets
scripts/      fixtures, brand rendering, verification and screenshot tools
docs/         documentation, screenshots
```
