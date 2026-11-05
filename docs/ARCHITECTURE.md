# LAST60 — System Architecture

> Status: living document. Every claim about Meteora DBC and Raydium LaunchLab in this file
> was verified against the programs' source code / official IDLs and against real mainnet
> transactions (see `packages/engine/test/fixtures/`), not against marketing material.

## 1. What the system does

Every five minutes (a *round*), the engine pays 75% of the trading fees that the project is
entitled to (the *eligible fees*) to the five most recent unique wallets that bought at least
0.05 SOL. The moment the snapshot is taken is chosen by a CSPRNG somewhere inside the last 60
seconds of the round and is kept secret until it happens. Randomness decides **when**, never
**who**: winners are a deterministic function of on-chain purchase history at the snapshot slot.

## 2. Process topology

```
                        ┌─────────────────────────────┐
  Solana RPC / WS  ◄────┤  indexer  (apps/worker)     │  leader-leased, stateless restart
  (Helius etc.)         │  • logsSubscribe(pool)      │
                        │  • getSignaturesForAddress  │  backstop poll + backfill
                        │  • decode provider events   │
                        └──────────────┬──────────────┘
                                       │ idempotent upserts
                        ┌──────────────▼──────────────┐
                        │  MongoDB (replica set)      │  single source of truth
                        └──────▲───────────────▲──────┘
                               │               │
   ┌───────────────────────────┴───┐     ┌─────┴──────────────────────┐
   │  rewards  (apps/worker)       │     │  api  (apps/api, Hono/Bun) │
   │  • clock-anchored scheduler   │     │  • public REST + SSE       │
   │  • snapshot + allocation      │     │  • admin REST (wallet auth)│
   │  • payout executor (signer)   │     └─────────────▲──────────────┘
   │  • fee collector / reconciler │                   │ HTTP + SSE
   └───────────────────────────────┘     ┌─────────────┴──────────────┐
         holds PAYOUT key + schedule key │  web  (apps/web, Next 16)  │
                                         └────────────────────────────┘
```

* `indexer`, `rewards`, `api`, `web` are separate PM2 processes. Only `rewards` ever loads a
  private key or the schedule encryption key. `api` and `web` can be down without affecting
  rounds or payouts (acceptance criterion 15).
* Code lives in two packages: `packages/shared` (browser-safe types/formatters) and
  `packages/engine` (server-only domain logic). Apps are thin entrypoints.

```
packages/engine/src/
  config/      env schema (zod) + runtime settings overlay + audit
  db/          mongoose connection, models, Decimal128 <-> bigint helpers
  chain/       JSON-RPC client (failover, retry), WS client, tx normalizer, signer, payout tx builder
  providers/   LaunchProvider interface, meteora/, raydium/, mock/
  indexer/     ingestion, cursoring, finality tracking, backfill
  rewards/     round math, scheduler, selection, allocation, payout executor, fee collector,
               reconciliation
  terminal/    public activity log writer (whitelisted, never private state)
  util/        logger, backoff, leases, crypto
```

## 3. Launch-provider abstraction

`LAUNCH_PROVIDER=meteora_dbc | raydium_launchlab` selects an adapter implementing
`LaunchProvider` (`packages/engine/src/providers/LaunchProvider.ts`). The rewards engine,
database schema, API and frontend only see provider-neutral types (`NormalizedSwap`,
`NormalizedFeeClaim`, `PoolInfo`, `FeeState`).

| Concern | Meteora DBC (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) | Raydium LaunchLab (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`) |
|---|---|---|
| Pool account | `VirtualPool` (zero-copy, 416 B) | `PoolState` |
| Pool ↔ mint | `pool.base_mint`, quote via `config.quote_mint` | `pool.base_mint` / `pool.quote_mint` |
| Swap event | `EvtSwap3` via self-CPI (`emit_cpi!`); `EvtSwap`/`EvtSwap2` also emitted for compatibility | `TradeEvent` via self-CPI |
| Buy/sell | `trade_direction`: 0 = BaseToQuote (**sell**), 1 = QuoteToBase (**buy**) | `trade_direction` enum: `Buy` / `Sell` |
| Trader | swap ix account #9 `payer` (event has no trader) | buy/sell ix account #0 `payer` (event has no trader) |
| Gross quote spent on buy | `included_transfer_fee_amount_in` | `amount_in` (includes protocol+platform+creator+share fees — verified against reserve deltas) |
| Fee split | `trading_fee` (LP part) → creator = ⌊trading_fee·`creator_trading_fee_percentage`/100⌋, partner = rest; `protocol_fee` separate | explicit `protocol_fee`, `platform_fee`, `creator_fee`, `share_fee` |
| Fee denomination | quote, **or base** when `collect_fee_mode = OutputToken` and the trade is a buy (`fee_on_base_token`) | always quote |
| Where unclaimed fees live | per-pool counters `creator_quote_fee` / `creator_base_fee` / `partner_*` on the pool account | creator: token vault PDA `[creator, quote_mint]` — **shared by every pool that creator launched**; platform: `[platform_config, quote_mint]` |
| Claim | `claim_creator_trading_fee(max_base, max_quote)` signed by `pool.creator`; emits `EvtClaimCreatorTradingFee`; partner: `claim_trading_fee` signed by `config.fee_claimer` | `claim_creator_fee()` signed by creator; sweeps the whole vault to the creator's quote ATA; no event |
| Graduation | `is_migrated` / `migration_progress`; trading moves to DAMM v1/v2 | `status`: Fund → Migrate → Trade; trading moves to AMM v4 / CPMM |

### Buyer attribution
Neither program puts the trader in its event. Each adapter walks the transaction's instruction
tree (top-level + inner instructions, ordered by `stackHeight`) and links every event CPI to
its parent swap instruction. The buyer is that instruction's `payer` **if it signed the
transaction** (covers direct buys and aggregator routes that pass the user through). If the
payer is a program PDA (shared-account routes), the adapter falls back to the signer whose
base-mint balance increased, then to the fee payer, and records `buyerSource` for audit.

### Transaction versions
Mainnet now carries **version 1** transactions in addition to legacy/v0. The indexer uses its
own JSON-RPC reader with `maxSupportedTransactionVersion` (default `1`, configurable) and a
version-agnostic normalizer; it automatically retries with a higher version when the RPC
reports `-32015`. `@solana/web3.js` v1 is only used to build and sign our own (legacy) payout
transactions.

### What is deliberately *not* assumed
* Fees are not inferred from wallet transfers. They come from decoded program events whose
  semantics were checked against the program source (`apply_swap_result`,
  `split_partner_and_creator_fee`) and reconciled against on-chain counters/vaults.
* Forgepad's exact DBC config could not be verified from public sources. Nothing is hard-coded:
  the adapter reads `pool → config` on start and derives creator percentage, collect-fee mode,
  quote mint, fee claimer and creator from chain state. `FEE_BENEFICIARY_ROLE` declares whose
  share the project receives (`creator` | `partner` for DBC, `creator` | `platform` for
  LaunchLab).

### Known integration limits (documented, not papered over)
1. **Graduated pools.** After migration, trading (and fees) move to a different program (DAMM
   v1/v2, Raydium AMM/CPMM) with position-based fee claiming. The adapters detect migration,
   raise a `WARN` + degraded health, and stop attributing new fees. A post-migration adapter is
   required before the token graduates (see `docs/PROVIDERS.md` §Post-migration).
2. **LaunchLab shared creator vault.** Reconciliation is exact only if the creator wallet
   launched a single pool for the quote mint; otherwise the vault surplus is reported as
   "other sources" and per-event attribution is authoritative.
3. **Non-SOL quote assets.** v1 supports SOL-quoted pools for SOL payouts, and SPL payouts only
   when `PAYOUT_ASSET` equals the pool's quote mint. No price conversion is ever performed;
   misconfiguration fails validation at startup.

## 4. Rounds and timing

* Round index `k = floor((t − ROUND_ANCHOR_EPOCH) / ROUND_DURATION)`; with the default anchor
  (Unix epoch) rounds start at :00, :05, :10… regardless of worker execution time (no drift).
  Public round number = `k − k_genesis + 1`, where genesis is persisted on first boot.
* At `start + RANDOM_WINDOW_START_SECONDS` the scheduler draws
  `delayMs = crypto.randomInt(windowMs)` (uniform over the *remaining* window if the worker
  came up late) and persists it **encrypted** (AES-256-GCM, `SCHEDULE_ENCRYPTION_KEY`) with a
  compare-and-set so a restart reuses, never regenerates, the draw. The API process does not
  hold the key; the field is `select: false`; no log line, terminal event, or admin endpoint
  contains it.
* At the execution instant the worker reads the cluster's **confirmed slot** — the
  *snapshot slot*. Each round's reward period is the half-open slot range
  `(previous snapshot slot, this snapshot slot]`. Consecutive periods therefore tile the chain
  with no gaps and no overlap: every buy and every fee lamport belongs to exactly one round.
* If the worker is down at the execution instant but back before round end (+grace), the round
  executes immediately. If the whole window was missed, the round is recorded as `missed`;
  its buys and fees flow into the next executed round (nothing is lost or double counted).

### Round state machine
```
open ──(window start)──► scheduled ──(executeAt)──► snapshotting ──► paying ──► completed
  │                         │                            │              │
  └──────(round end + grace, no snapshot)──► missed      ├──► rolled_over (no buyers / dust)
                                                         │              └─► awaiting_funds ⇄ paying
                                                         └────────────────► (failed payouts → manual retry)
```
All transitions are `findOneAndUpdate` compare-and-set on `state` (+ fencing token). A
leader lease (`worker_leases`) keeps a single active scheduler; CAS makes even overlapping
leaders safe.

## 5. Snapshot → allocation

1. CAS `scheduled → snapshotting`; persist `snapshotSlot` immediately (re-runs reuse it).
2. Terminal: `SYSTEM: Reward processing initiated.`
3. Catch-up: ingest every pool signature up to the snapshot slot (same idempotent code path as
   the indexer), after a short settle delay so the RPC has the confirmed slot indexed.
4. Select buyers (Mongo aggregation): buys in the period, `status=active`,
   `quoteAmount ≥ MIN_BUY`, trader not excluded → sort by `(slot desc, intra-slot order desc)`
   → first row per wallet → top `BUYER_COUNT`.
5. Eligible fees = Σ `eligibleFee` of all swaps (buys **and** sells) in the period whose fee
   asset equals the payout asset. Fees in other assets are recorded, not converted.
6. Allocation (pure integer function, `rewards/allocation.ts`):
   * `reward = ⌊fees · REWARD_BPS / 10000⌋ + rolloverIn`, `retained = fees − ⌊…⌋`
   * `per = ⌊reward / n⌋`, `dust = reward − per·n` (recorded as retained dust)
   * `n = 0` or `per < MIN_PAYOUT_LAMPORTS` → no payouts, `reward` carried forward
     (`SKIPPED_ROUND_POLICY=rollover`, default) or retained (`retain`).
7. One MongoDB transaction writes: round result, one `payouts` row per recipient (unique
   `(round, recipient)`), and the ledger entries. Commit ⇒ state `paying`.

## 6. Payout execution and idempotency

One transaction per recipient: `ComputeBudget` + `SystemProgram.transfer` (SOL) or
`createAssociatedTokenAccountIdempotent` + `transferChecked` (SPL / Token-2022) + memo
`last60:r<round>:<payoutId>`.

```
pending ─CAS(lock+fence)─► signing ─persist sig+blockhash+raw tx─► submitted ─► confirmed
   ▲                                     (only then broadcast)        │
   └────────── blockhash expired (finalized height > lastValid) ──────┤
                and signature status still null                       └─► failed (max attempts; admin retry)
```
* The signature, blockhash, `lastValidBlockHeight` and serialized bytes are persisted *before*
  the first broadcast. Any worker can rebroadcast the identical bytes (Solana dedups by
  signature).
* A new transaction for the same payout is created **only** after the previous one provably
  cannot land: finalized block height has passed its `lastValidBlockHeight` and the
  signature is unknown, or it landed with an error at `finalized`.
* `confirmed` is written only after the signature reaches `PAYOUT_COMMITMENT`
  (default `finalized`).
* Balance check before signing: `balance − reserve − in-flight ≥ amount`, otherwise the round
  becomes `awaiting_funds` and is retried with exponential backoff.
* `PAYOUT_MODE=dry_run` (the default) records `simulated` payouts and never signs. `live` on
  mainnet additionally requires `ALLOW_MAINNET_PAYOUTS=true`.

## 7. Fee accounting

See `docs/FEE_ACCOUNTING.md` for the full ledger specification. Summary:

* **Accrual (attribution):** each decoded swap stores `eligibleFee` computed with the exact
  integer formula the program uses for the configured beneficiary role.
* **Collection:** optional `FEE_COLLECTION_MODE=auto_claim` claims the beneficiary's fees after
  each snapshot and unwraps WSOL into the payout wallet in the same transaction; `manual`
  leaves claiming to operators.
* **Reconciliation:** periodically compares `Σ attributed − Σ claimed (+ baseline)` with the
  on-chain unclaimed counter (DBC) or vault balance (LaunchLab) at a common slot, checks
  per-round ledger invariants, and checks the payout wallet covers pending payouts.
  Over-attribution (engine believes more fees exist than the chain holds) halts payouts.

## 8. Privacy of scheduling information

| Surface | Contains executeAt / delay? |
|---|---|
| MongoDB | only as AES-GCM ciphertext |
| `api` process | no (no key, field projected out, DTO whitelist, tests assert) |
| Terminal events | no (writer accepts typed public events only) |
| Logs | no (scheduler logs "execution scheduled" without time) |
| Admin API | no (insiders must not be able to front-run) |
| Chain | payout tx timestamps are public once they happen — unavoidable and fine |

## 9. Failure handling summary

| Failure | Behaviour |
|---|---|
| RPC down / 429 | endpoint failover, jittered exponential backoff; indexer cursor never skips |
| WS drops | auto-reconnect; polling backstop guarantees completeness |
| Duplicate notifications | unique `(signature, eventIndex)` upserts |
| Fork / dropped tx | finality tracker marks `dropped` and excludes from selection |
| Worker crash mid-snapshot | lock expiry → re-run with persisted `snapshotSlot` (deterministic) |
| Crash mid-payout | persisted attempt → status check → rebroadcast or wait for expiry |
| Mongo interruption | loops back off; all writes are CAS/idempotent; no partial allocations (txn) |
| Insufficient balance | `awaiting_funds`, retried; never partially signs |
| Two workers | lease + CAS + fencing tokens + unique indexes |
