# Database

MongoDB **replica set** (Atlas, or `mongod --replSet rs0`; `bun run dev:mongo` starts one
locally). Multi-document transactions are required for round allocation. Models:
`packages/engine/src/db/models.ts`. Amounts are `Decimal128` integers of base units.

| Collection | Purpose | Key indexes / constraints |
|---|---|---|
| `system_state` | genesis round index + schedule params, `payout_halt` | `_id` |
| `settings` | admin runtime overrides, optimistic `version` | `_id: "active"` |
| `config_audit` | every settings change / operator action: actor wallet, diff, reason, IP | `at` |
| `pools` | provider pool metadata, fee params, vaults, status, allocation basis + verification, reconciliation `baseline`, `migration` (status, checks, failed checks, destination spec) | `key` unique |
| `swaps` | every decoded trade (buys and sells) on the bonding pool and the verified destination; attribution fields `feePhase`, `excludedFee`, `excludedReason`, `feeStatus`, `payoutEligible`, `basisId` + `basis`, `beneficiary`, `sourcePool`, `evidence`; `orderInSlot` is the event index (NOT the block position; `txIndex` holds it when resolved) | **`(signature, eventIndex)` unique**; `(pool, side, status, slot, orderInSlot)`; `(pool, status, slot)`; `(trader, slot)`; `(commitment, status, slot)` |
| `fee_claims` | on-chain claims of the beneficiary's fees (bonding curve, DAMM v2 positions) | **`(signature, index)` unique** — several claims per transaction |
| `fee_attributions` | non-swap fee facts: LP-position checkpoints, CPMM creator-fee and locked-LP collections, other pools' shared-vault inflows, unresolved observations — each with gross / creator / excluded amounts, reason, evidence, status, payout eligibility, basis | **`key` unique**; `(pool, slot)`; `(checkpointKey, slot)` |
| `buyer_activity` | per-wallet totals: buys, qualifying buys, spent, rewards, rounds paid | `wallet` unique |
| `rounds` | one per round: schedule, sealed execute time, snapshot, config snapshot, allocation, totals, state, lock | **`roundNumber` unique**, **`roundIndex` unique**, `(state, roundNumber)` |
| `payouts` | one per (round, recipient): amount, state machine, attempts with signatures/blockhashes | **`(roundNumber, recipient)` unique**, **`confirmedSignature` unique (partial)**, `(state, nextAttemptAt)` |
| `ledger_entries` | append-only economic facts | **`key` unique** (idempotency) |
| `terminal_events` | public activity log | **`seq` unique**, `dedupeKey` unique (partial), TTL on `expiresAt` |
| `counters` | monotonically increasing terminal `seq` | `_id` |
| `worker_leases` | leader leases with fencing tokens | `_id` |
| `worker_state` | heartbeats, metrics, indexer cursors (`cursor:<provider>:<pool>:<address>`) | `_id` |
| `reconciliation_reports` | fee-source / ledger / payout-wallet checks | `(kind, at)` |
| `admin_nonces` | single-use sign-in challenges | `nonce` unique, TTL |

## Private fields

`rounds.executeAtCipher` and `rounds.scheduleGeneratedAt` are `select: false` and the former is
AES-256-GCM ciphertext bound to its round number (associated data). Only the rewards worker holds
`SCHEDULE_ENCRYPTION_KEY`. `payouts.current.serializedTx` is `select: false`.

## State machines

`rounds.state`: `open → scheduled → snapshotting → paying ⇄ awaiting_funds → completed`, or
`→ rolled_over`, `→ attention` (failed payouts), `→ missed`.
`payouts.state`: `pending → signing → submitted → confirmed`, `→ failed` (requeue → `pending`),
or `simulated` (dry-run). All transitions are conditional updates on the current state (+ lock
token where relevant).

## Historical reconstruction

Every round can be rebuilt from the database alone:
`rounds` (period slots, config snapshot, totals) + `swaps` in `(prevSnapshotSlot, snapshotSlot]`
(the exact input of selection and fee sums) + `payouts` (attempts, signatures, confirmation slot)
+ `ledger_entries` (`roundNumber`). `bun run cli round <n>` prints all of it. And from the chain
alone, using `scripts/verify-round.ts`.

## Operations

* Back up with `mongodump` or Atlas snapshots; `swaps` can be rebuilt from chain, the rest cannot.
* `terminal_events` expire after `TERMINAL_RETENTION_DAYS`. Nothing else is deleted.
* Indexes are synchronised at process start (`syncIndexes`).

## Migrations for existing deployments

No manual data migration is required; indexes are synchronised at process start (`syncIndexes`):
* `fee_claims`: the unique index changes from `signature` to `(signature, index)` (existing rows get
  `index` 0 implicitly; single-claim transactions keep index 0, so rows are not duplicated).
* New collection `fee_attributions` and new swap / payout / round fields default safely: legacy swap
  rows without `payoutEligible` count as eligible (same program formula), legacy confirmed payouts
  without `ledgerApplied` are repaired once by the reconciler.
* Legacy swap rows have no stored `basis`: a beneficiary-role change on such a pool is refused.
