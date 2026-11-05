# LAST60 production-readiness audit

Date: 2026-11-05 · Scope: the whole repository at `main` (`fa115b1`) · Fixes: branch
`fix/production-readiness-critical`. No live payouts were enabled, no mainnet transaction was sent,
no wallet or deployment was touched. All chain evidence below comes from read-only mainnet RPC
calls (`getAccountInfo`, `getSignaturesForAddress`, `getTransaction`) and the programs' public
source code.

## 1. Verdict

**Not production-ready yet.** The architecture is sound and most of the money-movement design
(persist-before-broadcast, fencing, unique constraints, integer allocation, CAS state machines) is
well executed. However, the audit found **three ways real funds could be sent twice or without
authorization** (C1–C3), several silent accounting gaps, and deployment tooling that reported
success without doing anything. Those are fixed on the feature branch with regression tests that
failed before the fix. Remaining blockers (§7) are the missing post-graduation adapter, verification
of the actual Forgepad pool configuration, and a handful of unfixed P1 issues (§3).

## 2. Test evidence

| Run | Result |
|---|---|
| `main` — `bun run test` (real MongoDB 8.0.4 replica set, FakeChain, LiteSVM, mainnet fixtures) | **90 pass / 0 fail**, 44.4 s |
| `main` — `tsc` engine, shared, api, worker | clean |
| `main` — `bun run typecheck` / `bun run build:web` | exit 0 **but the web steps never ran**: `bun --cwd apps/web run X` prints usage and exits 0 under Bun 1.4.4 — even for a script that does not exist (`exit=0`) |
| `main` — web typecheck / `next build` run directly in `apps/web` | clean / builds (Next 16.4.5) |
| New regression tests against **unfixed** code (`test/audit-regressions.test.ts`, `apps/api/test/hardening.test.ts`) | **0 pass / 11 fail** — every defect reproduced (e.g. buyer paid twice, 1 001 of 2 501 transactions indexed, second transfer for a landed payout) |
| Branch — `bun run test` | **109 pass / 0 fail**, 52 s (90 original + 13 regression + 6 migration) |
| Branch — `bun run typecheck` (now includes web) / `bun run build:web` (now builds) | clean / builds |

## 3. Confirmed issues

Severity: **Critical** = funds can move incorrectly; **High** = incorrect payments, silent accounting
loss, or broken deployment; **Medium** = wrong-but-safe behaviour, false halts, abuse vectors.

### Fixed on the branch (each with a regression test)

| # | Sev. | Issue | Where | Fix |
|---|---|---|---|---|
| C1 | **Critical** | **Mainnet live-payout gate not enforced by the signer.** `ALLOW_MAINNET_PAYOUTS` was checked only at env load (when `PAYOUT_MODE=live` in env) and by whichever process wrote the `payoutMode` override — normally the **API**, against the **API's** env (key presence was a string check), or nobody for a direct DB write. The rewards worker loads the key whenever one is configured and signed whenever settings said `live`. | `rewards/payouts.ts`, `config/runtime.ts`, `apps/worker/src/rewards.ts` | `liveSigningBlockReason()` re-checked in the signing process before every signature (payouts and auto-claim); payouts stay queued. |
| C2 | **Critical** | **Snapshot slots could go backwards → same period paid twice.** A lagging node answering `getSlot` (load balancer, failover) with a slot ≤ the previous snapshot made `prev` skip the last round; the new period overlapped an already-paid one and re-used its rollover. Reproduced: buyer A paid in round 1 **and again** in round 2. | `rewards/scheduler.ts` | Snapshot slot must be > every earlier snapshot; otherwise the round refuses and retries. |
| C3 | High | **Payout re-signed on a stale "unknown" status.** Expiry = "finalized height > lastValid and status null"; the null could come from a node that had not processed the landing slot → new transaction → **second transfer** (reproduced). | `rewards/payouts.ts` `checkSubmitted` | Status read with context slot; retire only if both null answers come from nodes at/after the finalized slot that proves expiry (`getEpochInfo` gives slot + height from one node). |
| C4 | High | **Indexer/catch-up silently skipped the oldest part of large backlogs.** Paging stopped at `cap` keeping the **newest** signatures; the indexer then advanced its cursor past the gap forever (cap 50 000), and catch-up (cap 20 000) snapshotted incomplete data although the code says it throws. Reproduced: 1 001 of 2 501 indexed. | `indexer/signatureSync.ts`, `rewards/scheduler.ts` | Anchored reads keep the **oldest** `cap` (sliding window) and report `truncated`; catch-up throws on truncation. |
| C5 | High | **Snapshot completeness race.** Catch-up read signatures without `minContextSlot`; a backend behind the snapshot slot omitted transactions ≤ snapshot, which then belonged to **no** round (next period starts after the snapshot). | `rewards/scheduler.ts`, `chain/rpc.ts` | `minContextSlot = snapshotSlot` on catch-up (and reconciliation); reconciliation now re-computes recent rounds' period fees and flags any difference. |
| C6 | High | **Fee claim / reconciliation blocked the scheduler.** `maybeClaim` waits up to ~60 s for confirmation and reconciliation can ingest 20 000 transactions + scan 500 rounds, both awaited inside the loop that fires the private execution instant → late execution or **missed round**. | `rewards/RewardsWorker.ts` | Both run as guarded background tasks. |
| C7 | Medium | **Landed auto-claim stuck as "failed"** after an ambiguous send error / unobserved confirmation; ingestion only upgraded `submitted` rows, so the claim was missing from reconciliation → **false over-attribution halt**. | `indexer/ingest.ts` | An on-chain claim always sets the row to `confirmed`. |
| C8 | Medium | **Mid-period pool/provider switch silently dropped** the previous pool's activity after the last snapshot — at graduation, exactly the final bonding-curve trades. | `rewards/scheduler.ts`, `selection.ts` | First post-switch period includes the previous pool's indexed activity (`rounds.config.previousPool`) + terminal WARN. |
| C9 | Medium | **Rate limit bypass / spoofable audit IPs.** Client IP = left-most `X-Forwarded-For` (client-controlled; the documented nginx `$proxy_add_x_forwarded_for` keeps the client's value). The SSE location sent no XFF, so every viewer shared one bucket ("local") → 429s at scale. | `apps/api/src/app.ts`, `docs/DEPLOYMENT.md` | `API_TRUST_PROXY_HOPS`; otherwise socket peer; nginx doc fixed. |
| C10 | Medium | Public `limit` values became cache keys (unbounded memory), `chart` limit unclamped, invalid cursors → 500. | `public/publicData.ts`, `app.ts` | Validated, clamped integers. |
| C11 | Medium | `rpcUrls` / `wsUrl` editable at runtime **without** critical confirmation although the rewards worker trusts the RPC for balances, expiry and fee attribution (a hostile endpoint can fabricate swaps or "expired" statuses). | `config/runtime.ts` | Added to `CRITICAL_KEYS` (with `feeCollectionMode`). |
| C12 | Medium | Switching `payoutMode` back to `dry_run` still signed queued live payouts. | `rewards/payouts.ts` | Live signing requires the current mode to be live; payouts stay pending. |
| C13 | High (deploy) | Root `typecheck`, `build:web`, `dev:web`, `start:web` were **no-ops that exit 0** under Bun 1.4.4 (web never type-checked; `build:web` built nothing, so `next start` would fail after a "successful" deploy). | `package.json` | `bun run --cwd apps/web <script>` (verified it fails on a missing script). |
| C14 | High (deploy/security) | **Per-process env isolation did not exist.** PM2 has no `env_file` option (checked PM2 7.1.2 source) — the setting was silently ignored. Bun auto-loads a root `.env` into every process started without `--env-file`, so with the README quick-start `.env` on the host **the API received the payout key and schedule key**; otherwise every process exited 78. | `ecosystem.config.cjs` | `interpreter_args: --env-file=.env.<role>` (`node_args` for web); verified `--env-file` suppresses `.env` auto-load. |

### Not fixed (need a decision or a larger change)

| # | Sev. | Issue | Recommendation |
|---|---|---|---|
| U1 | **High** | Changing `feeBeneficiaryRole` (or anything that changes `eligibleFee`) on a pool with history: stored swaps keep the old role's `eligibleFee` (`$setOnInsert`), so the current period mixes bases → wrong reward; reconciliation compares mismatched bases (possible false halt). | Store the fee basis (`provider:pool:role`) on each swap and re-attribute on change, or reject role changes for a pool with ingested swaps. Until then: **never change the role on a live pool** (runbook). |
| U2 | Medium | `confirm()` updates the payout, then writes `PAYOUT_CONFIRMED` and buyer stats in separate non-transactional writes; a crash in between leaves the ledger short (`totalPaid` low) with no repair. Same for `PAYOUT_FAILED`. | One transaction, or an idempotent reconciler repair. |
| U3 | Medium | Finality pass marks a swap `dropped` on a single null status (same lagging-node problem as C3 → a real buyer excluded); dropped swaps stay `commitment=confirmed` and occupy the oldest-first 256-row window forever, eventually stalling promotion of newer swaps. | Context-slot check; exclude `dropped` from the main window and re-check them separately. |
| U4 | Medium | LaunchLab claim amount = **net** vault delta of the whole transaction; a claim plus a trade by the same creator in one tx is mis-recorded → reconciliation mismatch / false halt. The shared creator vault also lets other pools' fees mask over-attribution (documented). | Derive the claim from the claim instruction's inner transfer. |
| U5 | Low | SPL payouts have no token-balance or SOL fee/rent check before signing; the SOL funds check is not atomic across `PAYOUT_CONCURRENCY` workers. Both end in preflight failures consuming attempts (never double payment). | Check token balance + SOL for ATA rent; reserve in-flight amounts atomically. |
| U6 | Low | Admin sign-in: domain line falls back to the request `Origin`/`Host` when `PUBLIC_SITE_URL` is unset, and the plain `signMessage` format lets wallets skip origin checks (phishing relay). No per-IP SSE connection cap; Bun `idleTimeout: 0` server-wide. | Require `PUBLIC_SITE_URL` with `ADMIN_WALLETS`; use SIWS `signIn`; cap SSE connections. |
| U7 | Low | `orderInSlot` is the event index inside a transaction, not the transaction's block position (schema comment says otherwise); only the selection boundary is tie-broken with `getBlock`. Payouts unaffected; ranking display within a slot is arbitrary. | Store the transaction index (available from `getBlock`) or fix the comment. |
| U8 | Low | Public DTOs report 9 decimals for every SPL payout mint; CORS reflects any origin when `CORS_ORIGINS` is empty (bearer tokens, so not directly exploitable). | Use the mint's decimals; require `CORS_ORIGINS` in production. |

## 4. Live-money execution paths — review notes

* **Native SOL / SPL transfers** — one recipient per transaction, canonical on-curve recipients only,
  amount > 0, `MIN_PAYOUT_LAMPORTS ≥ 890 880` (rent-exempt), Token-2022 aware `transferChecked`.
  Verified on LiteSVM. ✔ (see U5 for SPL funds checks)
* **Persistence before broadcast** — signature, blockhash, `lastValidBlockHeight` and bytes are
  written under a fencing token; a lost lock never broadcasts; abandoned `signing` rows are provably
  unsent. ✔
* **Blockhash expiry / rebroadcast** — identical bytes rebroadcast every 2 s until expiry, which is
  judged at *finalized* height. ✔ — but see **C3** (now fixed). Preflight `-32002` on the first
  broadcast is correctly treated as "never forwarded".
* **Duplicate prevention** — unique `(roundNumber, recipient)`, unique `confirmedSignature`, CAS on
  every transition, one allocation transaction per round. ✔ — but see **C2** (period overlap
  bypassed all of these, since the second payment was a *new* round) — now fixed.
* **Recovery** — `failed` only after every attempt was proven dead; requeue is safe given C3.
* **Fee claims** — DBC creator claim instruction's account order matches current program source
  (`ix_claim_creator_trading_fee.rs`); LaunchLab claim is byte-identical to the SDK (existing test).
  Claims transfer only to the beneficiary/payout wallet. See C6/C7/U4.
* **Accounting** — allocation conserves `fees + rolloverIn = retained + dust + rolloverOut + payouts`
  (property-tested); reconciliation halts on over-attribution. Gaps were C4/C5/C8/U1.

## 5. Provider findings

### Meteora DBC and "Forgepad"
* Forgepad's configuration **could not be verified from public sources** (no docs, repository, or
  config key found). It must be verified against the actual pool the token is launched on.
* What matters, and what the code now surfaces as pool warnings at load:
  * `creator_trading_fee_percentage` — the creator's share of the LP trading fee during bonding.
    **A real launchpad config sampled on mainnet (`CaDBnXEG…`, the repo's own fixture) has 0%**: with
    `FEE_BENEFICIARY_ROLE=creator` every round has zero eligible fees until graduation. (This pool is
    the one the verification report says "graduated minutes later … recorded no eligible fees"; with
    a 0% creator share that outcome was expected regardless of the migration.)
  * `collect_fee_mode` — `OutputToken` (also on that config) makes buy-side fees accrue in the token:
    recorded but not distributable as SOL.
  * Claim signer — auto-claim works only if the configured claim key **is** `pool.creator`
    (creator role) or `config.fee_claimer` (partner role). If Forgepad creates pools with its own
    wallet as creator, the creator role is not claimable by the project. Transfer-hook pools are
    refused by auto-claim. Use `FEE_COLLECTION_MODE=manual` until verified.
* Attribution formula (`⌊trading_fee × pct / 100⌋`, split at swap time into per-pool counters) matches
  program source and the repo's full-history reconciliations. ✔ The vendored IDL (0.2.2) lags source
  (0.2.3: `create_config2_with_transfer_hook`, `revoke_transfer_hook`); no impact on decoded paths.

### Raydium LaunchLab
* Creator/platform fees move per trade into shared vault PDAs; per-event attribution is
  authoritative; reconciliation can only check `vault ≥ expected` (shared). See U4.
* Post-graduation the creator's income changes mechanism entirely (§6).

## 6. Post-graduation (migration) — findings and work done

Verified on mainnet (fixtures `test/fixtures/mainnet/migration-*.json`, tests `test/migration.test.ts`):

| | Meteora DBC | Raydium LaunchLab |
|---|---|---|
| Destination | **DAMM v2** (`migration_option = 1`); DAMM v1 legacy only | **CPMM** (`migrate_type = 1`) or AMM v4 (`0`) |
| Real example | `AX7tzZ96…` → DAMM v2 `26n3vvi7…`, tx `2xu4wQep…`, slot 465 800 030 | `8AH7Rbje…` → CPMM `2ZJpQEny…`, tx `371QXpQ6…`, slot 465 826 675 |
| Detection | `is_migrated = 1` / `migration_progress = 3` | `status = 2` |
| Destination proof | migration ix account #4; owner; mints; `PDA("pool", config, max, min)`; `pool.creator` = DBC pool authority | migration ix #5; owner; mints; `amm_config`; `PDA("pool", config, t0, t1)` |
| Fee entitlement | **LP position NFTs** (pro rata liquidity incl. vested/locked), split by the config's LP percentages — the example creator got 0% while bonding and ~100% of LP fees after | **CPMM creator fee** to `pool_creator` (= LaunchLab creator in the example) **minus a protocol `share_rate` applied at collection**; collection is permissionless; locked-LP fee keys per platform/creator scales; AMM v4: none |
| Exactness | `claimable = pending + liquidity × Δfee_per_liquidity >> 128` reproduces the pool's own `total_lp_fee` to 2 base units | swap-event `creator_fee` ≠ amount received |

Implemented: `providers/migration.ts` (find, parse, verify, position fee math), indexer records the
verified destination (`pools.migration`) and announces it, provider config warnings,
`scripts/resolve-migration.ts`. **Not implemented:** destination swap decoding (buyers) and
position/creator-fee period accounting — specified in `docs/PROVIDERS.md`. Until then rounds after
graduation have no buyers and no fees.

## 7. Production deployment blockers

1. **Merge the fixes** (C1–C3 are money-safety). Re-run `bun run test` / `typecheck` / `build:web`.
2. **Post-graduation adapter** (DAMM v2 and/or CPMM) — required before the token graduates.
3. **Verify the real Forgepad pool** in dry-run: check `pools.warnings`, `feeParams`, `beneficiary`,
   run `bun run verify:fees` and `verify:round`; confirm the claim signer equals `pool.creator`.
4. **Resolve U1** (role change) or forbid it operationally; fix U2/U3 before relying on ledger totals
   and drop detection.
5. **Deployment config**: use the fixed `ecosystem.config.cjs`, remove any root `.env` from hosts,
   set `API_TRUST_PROXY_HOPS=1`, `PUBLIC_SITE_URL`, `CORS_ORIGINS`, bind the API to 127.0.0.1.
6. **RPC**: one dedicated provider for the rewards worker (heterogeneous failover lists increase
   inconsistent views; C2/C3 now defend against them but every refusal delays rounds).
7. **Authorized small-value live test** of the payout path (only LiteSVM / FakeChain so far).
8. **CI**: none in the repository — add one running test, typecheck and build on every PR.

## 8. Documentation vs. code discrepancies

| Doc says | Reality |
|---|---|
| README / VERIFICATION: `bun run typecheck` clean incl. web; `next build` succeeds | True when run directly; the root scripts never ran the web steps (C13). |
| VERIFICATION / FEE_ACCOUNTING: logs in `docs/evidence/*.log` | Directory not in the repository. |
| SECURITY / README / API: live mainnet requires `ALLOW_MAINNET_PAYOUTS=true` | Not enforced by the signing process (C1, fixed). |
| DEPLOYMENT: one env file per process via PM2 | PM2 ignored `env_file`; Bun loaded root `.env` everywhere (C14, fixed). |
| DEPLOYMENT nginx snippet + API "per-IP rate limits" | Left-most XFF trusted; SSE location without XFF (C9, fixed). |
| `scheduler.catchUp`: "throws rather than snapshotting incomplete data" | Not with > 20 000 signatures (C4, fixed). |
| ARCHITECTURE: provider switch "ingests the whole current reward period" | Previous pool's tail was dropped from rounds (C8, fixed). |
| `models.ts`: `orderInSlot` = tx position × 1000 + event index | Event index only (U7). |
| API.md: nonce message bound to `PUBLIC_SITE_URL` | Falls back to request `Origin`/`Host` when unset (U6). |
| README: "90 tests" | 109 on the fix branch. |
| PROVIDERS (old): post-migration needs checkpoint tracking over time | Refined: claimable is a cumulative counter readable at each snapshot (§6). |
