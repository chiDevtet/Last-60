# Verification report

What was verified, how, and against what. Everything listed as verified was observed, not
assumed. Date: 2026-11-05.

## 1. Automated tests — 90 passing (`bun run test`)

| Suite | What it proves |
|---|---|
| `packages/engine/test/providers.test.ts` (19) | Both adapters on **real mainnet transactions/accounts**: legacy/v0/v1 normalisation; event→instruction linking; one swap per DBC swap ix despite three events; amounts equal vault token deltas; exact creator/partner split; base-token fees on `OutputToken` pools; router-CPI trader resolution; `load()` validation (owner, mint, payout asset); DBC claim ix vs IDL; LaunchLab account decoders vs Raydium SDK layouts; LaunchLab creator-fee vault inflow = event; claim detection; LaunchLab claim ix **byte-identical** to the Raydium SDK. |
| `test/allocation.test.ts` (14) | 75/25 split, spec examples (2 SOL → 0.3 SOL × 5; three buyers), rounding dust, rollover, minimum payout, u64-scale exactness, 2 000-case property test of the conservation invariant, clock-anchored rounds, uniform CSPRNG execute time (χ²), late-start window. |
| `test/rewards.test.ts` (24) | Full rounds on a real MongoDB replica set + fault-injecting chain: unique-buyer selection (incl. the brief's sequence), intra-slot tie-break by block order, sells/failed/excluded never qualify, sealed execute time survives restart and is never stored in plaintext, nothing happens 1 ms early, **no double execution with concurrent workers**, crash mid-snapshot resumes deterministically, bounded catch-up, no-buyer rollover, insufficient balance, dropped/failed/timed-out/transient-error transactions all paid **exactly once**, max attempts → requeue, crash between signing and persisting never broadcasts, unique constraint, key mismatch refusal, dry-run, missed windows, late start, leases, schedule-change refusal. |
| `test/payouts-runtime.test.ts` (5) | Payout transactions executed by the **real Solana runtime (LiteSVM)**: SOL transfers with compute budget + memo deliver exact amounts; the runtime rejects duplicate bytes; expired blockhash → single re-sign; insufficient funds → nothing sent; SPL path (ATA + `transferChecked`) moves exact units. |
| `test/indexer.test.ts` (7) | Backfill + cursor resume after restart, concurrent duplicate ingestion, RPC failure mid-sync leaves no gap, transient errors, finality promotion and fork-dropped transactions excluded, one terminal line per buy, no-backfill attach covers the current period only. |
| `test/config.test.ts` (20) | Env defaults = spec, all problems reported at once, `NEXT_PUBLIC_` secret guard, role/provider validation, rent-exempt minimum, exact percentage parsing, URL key redaction, runtime-override validation, mainnet live switch, key parsing, sealed values bound to round, Decimal128 exactness, float-free parsing. |
| `apps/api/test/api.test.ts` (6) | **No public route ever contains the execute time, delay, ciphertext or locks** (checked during the final window and after settlement); real engine state via API; wallet-signature login, nonce replay, forged signature, non-admin rejection; validated, version-checked, audited config changes; public cannot reach admin; SSE snapshot + live terminal. |

Typecheck: `bun run typecheck` clean across engine, shared, api, worker, web. Production web
build: `next build` succeeds.

## 2. Fee attribution vs. on-chain accounting (real pools, full history)

`scripts/verify-fee-attribution.ts` replays a pool's entire history through the adapter and
compares with the program's own unclaimed counters at the same slot.

| Pool | Split | Swaps | Attributed | Claims | Expected unclaimed | On-chain | Result |
|---|---|---|---|---|---|---|---|
| DBC `46ou9r…` | creator 100% | 259 | 203,187,431 | 0 | 203,187,431 | 203,187,431 | exact |
| DBC `3cz51P…` | creator 44% | 68 | 807,297,326 | 807,283,921 | 13,405 | 13,405 | exact |

Logs: `docs/evidence/dbc-fee-reconciliation-*.log`.

## 3. Live mainnet run (dry-run payouts)

All four processes ran against Solana mainnet-beta on the public RPC: indexer (WebSocket +
polling), rewards worker, API, web.

* Attached to a Meteora DBC pool, which **graduated minutes later**; the migration was detected,
  published as a WARN and the round correctly recorded "no eligible fees".
* Switched to a busy Raydium LaunchLab pool **at runtime through the admin API** (wallet-signed
  login, audited, version-checked) — both workers re-attached without restart.
* Five consecutive five-minute rounds executed on real buys; indexer restarted three times
  mid-run.
* **Every settled round was re-derived from the chain** with `scripts/verify-round.ts` using only
  public data (snapshot slots + RPC):

| Round | Period (slots) | Recipients | Eligible fees | Reward |
|---|---|---|---|---|
| #3 | (465813836, 465815234] | ✔ identical (5) | ✔ 918,650,244 | ✔ 688,987,683 |
| #4 | (465815234, 465816524] | ✔ identical (5) | ✔ 260,459,068 | ✔ 195,344,301 |
| #5 | (465816524, 465817959] | ✔ identical (4 qualified) | ✔ 99,775,488 | ✔ 74,831,616 |
| #2 | (465812503, 465813836] | ✔ identical (5) | ✔ 2,823,485,307 from the attach slot | ✔ 2,117,613,980 |

Round #2's first verification showed the engine 9% below the chain for the full period. Root
cause: the pool was switched mid-period with `INDEXER_BACKFILL=none`, so swaps between the
previous snapshot and the attach were not indexed. Verified by re-running from the attach slot
(exact match), then **fixed**: attaching now ingests the whole current reward period (regression
test added). Logs: `docs/evidence/launchlab-*.log`.

### Bugs found by the live run and fixed

1. Snapshot catch-up / reconciliation without an indexer cursor crawled the pool's entire history
   (worker stalled on a rate-limited RPC) → bounded to the reward period; reconciliation waits for
   the cursor.
2. Heartbeat and lease renewal lived in the main loop, so a long sync looked like a dead worker
   and could let the lease lapse → moved to independent timers; sync passes are bounded.
3. Polling re-downloaded transactions already ingested via WebSocket → skipped.
4. Mid-period attach gap (above).
5. FEES terminal line could mix two periods → period-consistent.
6. Countdown seconds could render blank for a frame on mobile → always-present element
   (40/40 sampled frames visible).
7. Public round data exposed the exact execution instant (`executedAt`) → replaced by `settledAt`.

## 4. What is NOT verified / not complete

* **Live mainnet payouts** were not sent (not authorized). The live path is verified by the
  fault-injection suite and on the real Solana runtime (LiteSVM). Devnet airdrops were refused by
  the public RPC (HTTP 410), so no devnet transfer was performed.
* **Auto-claim** transactions are built from the IDLs and tested against the IDL / Raydium SDK, but
  were not executed on-chain (requires the beneficiary's key).
* **Post-migration adapters** (DAMM v2 / Raydium AMM/CPMM) are specified but not implemented —
  required before the token graduates (`docs/PROVIDERS.md`).
* **Forgepad**'s specific DBC configuration could not be verified from public sources; the adapter
  reads everything from chain, so the operator only needs the pool address and the correct
  `FEE_BENEFICIARY_ROLE`.
* Social handle availability for the brand was not verifiable without authenticated APIs.
* The brief's ordering example lists "A, E, D, C, B", but under its own rule A's latest buy (3rd
  transaction) is older than C, D, E, giving "E, D, C, A, B". The selected set — and every payout
  — is identical; the implementation follows the stated rule.
