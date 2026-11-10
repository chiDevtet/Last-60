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
| `revenue_events` | phase-aware revenue facts (PR #6; `route` on funding inflows since PR #8: `last60_destination` / `forge_creator_distribution`, null = legacy destination route): fee collections (`bonding_curve_creator_fee`, `cpmm_creator_trading_fee`, `forge_platform_lp_fee_collection`) and `last60_funding_inflow` transfers — cluster, token mint, pool / source pool, provider, launch phase, signature, top-level + inner instruction index, ordinal, slot, block time, fee mint, asset, decimals, gross / net, source / destination account and owner, beneficiary, status, v1 `snapshot` (stream, phase, beneficiaries, policy, effective fee config, verification, problems). Immutable | **`key` unique**; **`(signature, ordinal, stream, feeMint)` unique**; `(sourcePool, kind, slot)`; `(kind, sourceOwner, asset, slot)`; `(sourcePool, stream, slot)`; `(sourcePool, route, slot)` |
| `reward_funding` | one credit per funding inflow linked to a claim: stream, correlation method (`same_transaction` / `memo` / `exclusive_window` / `forge_distribution_sequence`), `route`, immutable `attribution` evidence (Forge creator route), observed / creditable / excess amounts, payout eligibility + reason, policy and snapshot; `roundNumber` / `consumedAt` set once by the consuming round | **`key` unique** (= inflow); `(collectionKey, slot)`; `(payoutEligible, roundNumber, fundingMint, slot)` |
| `funding_attributions` | PR #8: one row per Forge creator-distribution leg — bounded attribution queue and audit trail: `status` (`pending` → `linked` / `unresolved`, decided once), reasons, candidate harvests, collection, method, evidence, evaluations. Derived; the economic facts stay on `revenue_events` / `reward_funding` | **`key` unique** (= inflow); `(sourcePool, status, slot)`; `signature` |
| `custody_transfers` | PR #10: physical custody of a credited contribution — one sweep request bound to at most one verified on-chain transfer into the dedicated payout wallet: original contribution (`fundingKey`), launch, creator, source / destination wallet, mint, expected / observed / credited / excess amounts, network fee, signature, slot, `confirmationStatus`, `status`, `reconciliation`, `finalizedSlot`, append-only `history`. Request facts immutable | **`custodyId` unique**; **`transferKey` unique (partial)**; **one open request per contribution** (`fundingKey` unique where `status: requested`); `(fundingKey, status)`; `(status, updatedAt)` |
| `transfer_uses` | PR #10: one row per on-chain transfer (`signature:ordinal`) Asteroid Protocol has used, as `reward_funding` or as `custody_transfer` — the two uses are mutually exclusive. Append-only | **`key` unique**; `signature` |
| `attribution_recoveries` | PR #10: append-only audit of operator recovery requests: request id, attribution key, operator, times, note, original decision, evaluated evidence (algorithm, coverage, finality), outcome, reasons, linked harvest, reward-funding key, transactions, failure reason | **`requestId` unique**; `(attributionKey, requestedAt)` |
| `revenue_reconciliations` | derived per-claim reconciliation (recomputed idempotently): gross, expected / actual / creditable Asteroid Protocol, expected / implied retained, excess, untransferred, status, discrepancies, distributions | **`key` unique** (= claim / correlation id); `(sourcePool, stream, collectionSlot)`; `status` |
| `buyer_activity` | per-wallet totals: buys, qualifying buys, spent, rewards, rounds paid | `wallet` unique |
| `rounds` | one per round: schedule, sealed execute time, snapshot, config snapshot, allocation, totals (`recipientCount`, of which `holderRecipientCount` from the holder draw), `holderDraw` (seed, eligible count, winners; written once), state, lock; `fundingPolicy` snapshot (+ `legacyFeeSlotCap`), `funding`, `fundingBreakdown` | **`roundNumber` unique**, **`roundIndex` unique**, `(state, roundNumber)` |
| `payouts` | one per (round, recipient): `kind` (`buyer` \| `holder`), amount, state machine, attempts with signatures/blockhashes | **`(roundNumber, recipient)` unique**, **`confirmedSignature` unique (partial)**, `(state, nextAttemptAt)` |
| `ledger_entries` | append-only economic facts (incl. `FUNDING_CREDITED:r<n>:<stream>`) | **`key` unique** (idempotency) |
| `terminal_events` | public activity log | **`seq` unique**, `dedupeKey` unique (partial), TTL on `expiresAt` |
| `counters` | monotonically increasing terminal `seq` | `_id` |
| `worker_leases` | leader leases with fencing tokens | `_id` |
| `worker_state` | heartbeats, metrics, indexer cursors (`cursor:<provider>:<pool>:<address>`) | `_id` |
| `reconciliation_reports` | fee-source / ledger / payout-wallet / custody (liquidity) checks | `(kind, at)` |
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

**Payout wallet, custody and recovery (PR #10).** New collections `custody_transfers`, `transfer_uses`,
`attribution_recoveries` and the field `funding_attributions.recovery` (default null) are created by the
usual index sync; no data migration. Existing credits keep their records; credits written before
`transfer_uses` existed are still protected (a custody binding refuses any transfer already recorded as a
`reward_funding` credit). Existing unresolved attributions are untouched until an operator explicitly
requests a recovery. Note for upgrades: under `forge_phase_aware_v2` an unconsumed credit now funds a
round only once its SOL is verified in the payout wallet (direct, or custody) — Forge creator-route
credits wait for custody transfers.

**Indexing coverage (PR #8).** `worker_state` signature-cursor rows carry `syncedThroughSlot`: every
transaction of the address at or below it is ingested (recorded by a complete poll pass whose signature
reads were anchored with `minContextSlot`). The Forge creator-distribution attribution requires it (or
the cursor itself) to cover a payout's slot for the destination pool and Forge's launch-token account.
No data migration: new fields default to null, the new collection and indexes are created by the usual
index sync.
