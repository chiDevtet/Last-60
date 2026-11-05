# LAST60 production-readiness audit

**Round 1** (2026-11-05, `fa115b1` → merged to `main` as `4cf1bd3`): critical payout/accounting fixes
C1–C14 (below). **Round 2** (2026-11-05, branch `fix/creator-fee-accounting` on top of `4cf1bd3`):
creator-fee-only accounting, strict migration verification, post-migration providers and the
previously unresolved findings U1–U8. No live payouts were enabled, no mainnet transaction was sent,
no fee was claimed and no wallet or deployment was touched; all chain evidence comes from read-only
RPC calls (`getAccountInfo`, `getMultipleAccounts`, `getSignaturesForAddress`, `getTransaction`) and
the programs' public source code.

## 1. Verdict

**Not production-ready for live payouts yet** — but no longer for code reasons known to us. The
remaining blockers (§7) are operational verifications that require the real Forgepad pool, an
observed graduation, and an authorized small-value live test. The code now accounts only for
on-chain-verified creator allocations, fails safe (records but never pays) whenever an allocation
cannot be proven, and keeps every payout safeguard of round 1.

## 2. Test evidence

| Run | Result |
|---|---|
| `main` (`4cf1bd3`) — `bun run test`, re-run for this round | **109 pass / 0 fail** (55.1 s) — confirms the round-1 figure |
| Branch — `bun run test` | **172 pass / 0 fail** across 14 files (57.2 s) |
| Branch — `bun run typecheck` (engine, shared, api, worker, web) | clean (exit 0) |
| Branch — `bun run build:web` | builds (exit 0) |
| Branch — `bun scripts/resolve-migration.ts raydium_launchlab 8AH7Rbje… <mint> creator` against mainnet (read-only) | verified, exit 0 |

## 3. Confirmed issues

Severity: **Critical** = funds can move incorrectly; **High** = incorrect payments, silent accounting
loss, or broken deployment; **Medium** = wrong-but-safe behaviour, false halts, abuse vectors.

### Round 1 — fixed and merged into `main` (`4cf1bd3`), each with a regression test

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

### Round 2 — fixed on `fix/creator-fee-accounting` (each with regression tests)

| # | Sev. | Issue | Fix | Tests |
|---|---|---|---|---|
| U1 | High | Changing `feeBeneficiaryRole` on a pool with history mixed allocation bases. | Every fee record stores its allocation basis (`basisId` + snapshot: role, beneficiary, on-chain parameters, source, verification), written once. Role changes on a pool with records under another basis (or legacy records without one) are **refused** by the settings store and when a worker attaches with a conflicting environment role. History is never re-attributed implicitly. | `creator-fee-regressions` U1 ×2, `attribution` basis tests |
| U2 | Medium | Payout confirmation and ledger/stats were separate writes. | Confirmation, `PAYOUT_CONFIRMED` and buyer stats (and exhausted → `PAYOUT_FAILED`) commit in one MongoDB transaction; `ledgerApplied` flag; `repairPayoutLedger` (run by the reconciler) fixes legacy/partial rows idempotently. | crash between writes → nothing half-done, retry exactly once; legacy repair idempotent |
| U3 | Medium | A single null status dropped swaps; dropped rows blocked the finality window. | Drop requires status answers from nodes at/after the finalized slot, the swap's slot ≥ 150 slots below it, and two observations `INDEXER_DROP_AFTER_SECONDS` apart; dropped rows are re-checked in a separate bounded window and revived if seen. | lagging node never drops; 300 dropped rows don't block promotion; updated fork test |
| U4 | Medium | LaunchLab claims used whole-transaction vault deltas; shared vault masked over-attribution. | Claims = transfers out of the vault executed by that claim instruction (several claims per tx supported); other pools' deposits into the shared vault are indexed as excluded `shared_vault_inflow` records and counted in reconciliation, which is therefore exact. | claim + deposit in one tx, two claims in one tx, shared-vault inflow, exact and over-attribution reconciliation |
| U5 | Low | No SPL/SOL-rent checks; balance check not concurrency-safe. | The payout is reserved (`signing`) *before* the funds check, which counts all other reserved/in-flight payouts per mint; SPL checks token balance and SOL for fees + recipient ATA rent; actionable diagnostics; jittered retry. | two concurrent workers never both sign; SPL token and rent shortfalls |
| U6 | Low | Sign-in domain fell back to Origin/Host; plain message format; no SSE caps; `idleTimeout: 0`. | `PUBLIC_SITE_URL` required in production (config error), never `Host`; SIWS (CAIP-122) message + `solana:signIn` support; verify rejects altered SIWS fields and foreign browser origins; SSE per-IP/total caps and max lifetime; Bun `idleTimeout: 30` with heartbeats. | production config, Host ignored, SIWS tamper, origin relay, SSE cap |
| U7 | Low | `orderInSlot` documented as transaction position. | Documented as the event index (no cross-transaction ordering guarantee); selection keeps the `getBlock` tie-break at the boundary; `txIndex` field reserved for the resolved block position. | existing selection tie-break tests |
| U8 | Low | SPL payout DTOs assumed 9 decimals; CORS reflected any origin when empty. | Payout asset decimals from the pool's on-chain quote decimals; CORS: production requires `CORS_ORIGINS`, development allows loopback only, arbitrary origins never reflected. | decimals, CORS policy |

### Round 2 — creator-fee accounting (new requirements)

| Area | Before | Now |
|---|---|---|
| What is counted | the configured role's per-swap share while bonding; nothing after graduation | only payout-eligible creator allocations in every phase; gross/protocol/partner/platform/other-LP amounts recorded as excluded with a reason |
| Allocation source | on-chain params, no cross-check | on-chain params **verified** against the operator declaration (`EXPECTED_*`); mismatch → pool flagged, fees ineligible, declaration never substituted |
| LaunchLab rate semantics | implicit | `creator_fee_rate` proven to be a fee rate on trade value (real trade), events cross-checked with the vault transfer |
| Migration verification | DAMM v2 / CPMM partial; DAMM v1 / AMM v4 owner-only could pass | every required check per kind (program, layout + discriminator, mints, PDA, config, authority, positions/locks); DAMM v1 / AMM v4 explicitly unsupported |
| Post-migration | detection only | DAMM v2 and CPMM adapters: buyer tracking, creator-held position checkpoints, collected creator fees, creator LP-lock collections; periods span both pools |
| Reconciliation | bonding counters; LaunchLab ≥ only | exact LaunchLab, DAMM v2 checkpoint totals vs on-chain counters, payout-ledger repair |
| Public copy | advertised a fixed percentage | neutral ("eligible creator fees are allocated to payouts"); social images re-rendered |

## 4. Live-money execution paths — review notes

* **Native SOL / SPL transfers** — one recipient per transaction, canonical on-curve recipients only,
  amount > 0, `MIN_PAYOUT_LAMPORTS ≥ 890 880` (rent-exempt), Token-2022 aware `transferChecked`.
  Verified on LiteSVM. ✔ SPL token balance and SOL fee/rent preflight added (U5).
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
  (property-tested); reconciliation halts on over-attribution. Gaps were C4/C5/C8 (round 1) and U1
  (round 2), all fixed; `fees` is now the payout-eligible creator allocation only.

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
  authoritative; other pools' deposits are now indexed and excluded, so reconciliation is exact (U4).
* `creator_fee_rate` is a fee rate in millionths of the **trade value**, added to the total fee rate
  (e.g. 5 000 = 0.5 % of each trade) — proven on a real trade; it is not a share of the fee.
* Real platform sampled (`EB2LqTh8…`): `fee_rate` 7 500, `creator_fee_rate` 5 000, `platform_scale`
  1 000 000, `creator_scale` 0 — i.e. on that platform the creator gets **no** migrated LP.
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

**Round 2 — implemented:** strict verification for every supported kind (DAMM v1 / AMM v4 explicitly
unsupported); DAMM v2 and CPMM destination adapters (buyer tracking; creator-held position
checkpoints; collected CPMM creator fees; creator LP-lock collections); verified destinations
persisted as a spec and attached by both workers; destination indexed from the migration slot;
periods span bonding + destination pools; DAMM v2 reconciliation; `resolve-migration` uses the same
logic. Support matrix and evidence: `docs/PROVIDERS.md` §Post-migration. **Not yet observed:** a
live round across a real graduation, and a real `collect_cp_fees` from a creator lock.

## 7. Production deployment blockers (remaining)

1. **Review and merge `fix/creator-fee-accounting`**; re-run `bun run test` / `typecheck` / `build:web`.
2. **Verify the real Forgepad pool in dry-run**: set `EXPECTED_*` to Forgepad's intended allocation
   and confirm `pools.allocation.verification = verified` (no `ALLOCATION MISMATCH`); check
   `feeParams` (creator LP percentage / `creator_scale`), `beneficiary`, collect-fee mode (fees in the
   token are not distributable as SOL); run `verify:fees` and `verify:round`.
3. **Observe a real graduation end-to-end in dry-run** for the launch type used (DBC → DAMM v2 or
   LaunchLab → CPMM): `pools.migration.status = verified`, destination buyers indexed, first
   post-migration round's creator fees re-derived independently. Until then post-migration accounting
   is verified only offline on real transactions.
4. **Fee collection stays manual** until the actual Forgepad signer, authority, beneficiary and claim
   permissions are verified (who is `pool.creator` / CPMM `pool_creator` / position & fee-key NFT
   holder, and who can sign their claims).
5. **Deployment config**: fixed `ecosystem.config.cjs`, no root `.env` on hosts, `API_TRUST_PROXY_HOPS=1`,
   `PUBLIC_SITE_URL` and `CORS_ORIGINS` (now mandatory in production), API bound to 127.0.0.1.
6. **RPC**: one dedicated provider for the rewards worker.
7. **Authorized small-value live payout test** (only LiteSVM / FakeChain so far).
8. **CI**: none in the repository — add one running test, typecheck and build on every PR.
9. **Dashboard screenshots** in `docs/screenshots/` predate the copy change (they show an older
   percentage headline); re-capture from a running deployment.

## 8. Documentation vs. code discrepancies

| Doc says | Reality |
|---|---|
| README / VERIFICATION: `bun run typecheck` clean incl. web; `next build` succeeds | True when run directly; the root scripts never ran the web steps (C13). |
| VERIFICATION / FEE_ACCOUNTING: logs in `docs/evidence/*.log` | Directory not in the repository (still true; the evidence logs were never committed — treat those figures as reported, not reproducible from the repo). |
| SECURITY / README / API: live mainnet requires `ALLOW_MAINNET_PAYOUTS=true` | Not enforced by the signing process (C1, fixed). |
| DEPLOYMENT: one env file per process via PM2 | PM2 ignored `env_file`; Bun loaded root `.env` everywhere (C14, fixed). |
| DEPLOYMENT nginx snippet + API "per-IP rate limits" | Left-most XFF trusted; SSE location without XFF (C9, fixed). |
| `scheduler.catchUp`: "throws rather than snapshotting incomplete data" | Not with > 20 000 signatures (C4, fixed). |
| ARCHITECTURE: provider switch "ingests the whole current reward period" | Previous pool's tail was dropped from rounds (C8, fixed). |
| `models.ts`: `orderInSlot` = tx position × 1000 + event index | Event index only (U7) — documentation fixed in round 2. |
| API.md: nonce message bound to `PUBLIC_SITE_URL` | Fell back to request `Origin`/`Host` when unset (U6) — fixed in round 2. |
| README: "90 tests" / "109 tests" | 109 on `main` (re-verified); see §2 for this branch. |
| PROVIDERS (old): post-migration needs checkpoint tracking over time | Refined: claimable is a cumulative counter readable at each snapshot (§6). |
| PROVIDERS / OPERATIONS: "switch to the post-migration adapter" | Round 2: verified destinations attach automatically; docs updated. |
| Public copy: fixed percentage headline | Round 2: removed from UI, metadata, README, social images; screenshots pending (§7.9). |
