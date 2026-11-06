# Phase-aware revenue attribution and Last-60 reward funding (PR #6)

This document describes how LAST60 attributes Forge's revenue across the two launch phases, which
streams may fund Last-60 buyer rewards, what evidence is required, and what Forgepad must change
before the model can fund rewards in production. Code: `packages/engine/src/accounting/revenueStreams.ts`
(pure model), `src/revenue/decode.ts` (transaction decoding), `src/revenue/ingest.ts` (persistence,
correlation, reconciliation), `src/revenue/report.ts` (reporting), `src/rewards/scheduler.ts` (rounds).

## 1. The business model in one page

**A fee rate is not an allocation.** A *rate* says how much each trade is charged. An *allocation*
percentage is applied afterwards to the fees **actually collected**. Neither one proves that anything
was collected or transferred.

| Phase | What is charged | Who collects | Allocation of what was collected | Last-60 funding? |
|---|---|---|---|---|
| Bonding curve | creator fee **0.50 % of trade volume** (LaunchLab `creator_fee_rate` 5 000 / 10⁶) | the creator (`claim_creator_fee`) | **25 %** creator retains · **75 %** to Last-60 | yes — the 75 %, **once the transfer is observed** |
| After migration | CPMM creator fee **0.05 % of trade volume** (AmmConfig `creator_fee_rate` 500 / 10⁶), minus the protocol's creator-fee share at collection | the CPMM `pool_creator` (`collect_creator_fee`) | 100 % creator (direct revenue) | **never** |
| After migration | LP trading fees of the **platform-owned** Fee Key (100 % of the post-upgrade locked LP) | Forge's platform wallet (`collect_cp_fees` on the LP-lock program) | **50 %** to Last-60 · **50 %** Forge retains | yes — the 50 %, **once the transfer is observed** |

Example (illustration only; accounting uses observed integer amounts): 1 000 SOL of bonding volume
× 0.50 % = 5 SOL of creator fees. If the creator collects 5 SOL, 3.75 SOL (75 % of 5 SOL — not 75 % of
volume) is the expected Last-60 contribution and 1.25 SOL stays with the creator. Last-60 counts the
3.75 SOL only when it observes a transfer of it into a configured Last-60 funding destination.

The Forge LP 50 % is a **Forge-funded contribution**. The Fee Key is platform-owned; the creator does
not own it because they launched the token, and `creator_scale` is never evidence of a creator LP
entitlement (see `docs/FEE_ACCOUNTING.md` §2).

## 2. Streams

Every event carries an explicit stream; streams are never summed into one "creator fee".

| Stream | Phase | Kind | Beneficiary | Reward-eligible |
|---|---|---|---|---|
| `bonding_curve_creator_fee` | bonding_curve | collection (gross) | creator | no |
| `bonding_curve_creator_retained` | bonding_curve | derived (gross − contribution) | creator | no |
| `bonding_curve_last60_reward_contribution` | bonding_curve | observed transfer | Last-60 | **yes** |
| `cpmm_creator_trading_fee` | post_migration | collection (net transfer) | creator | no |
| `forge_platform_lp_fee_collection` | post_migration | collection (gross) | Forge | no |
| `forge_platform_lp_last60_contribution` | post_migration | observed transfer | Last-60 | **yes** |
| `forge_platform_lp_retained` | post_migration | derived (gross − contribution) | Forge | no |

Storage (all with unique keys, `$setOnInsert` writes and model-level immutability guards):

| Collection | One row per | Immutable | Notes |
|---|---|---|---|
| `revenue_events` | collection or funding inflow — `(stream, signature, instruction ordinal, mint)`, also unique on `(signature, ordinal, stream, feeMint)` | everything | cluster, chain, token mint, pool / source pool, provider, launch phase, signature, top-level + inner instruction index, ordinal, slot, block time, fee mint, accounting asset, decimals, gross / net amount, source / destination account and owner, beneficiary, evidence status, v1 snapshot (stream, phase, provider, pools, fee mint, beneficiaries, **policy snapshot**, effective fee configuration, verification, problems) |
| `reward_funding` | funding inflow linked to a collection (key = the inflow) | amounts, eligibility, policy, snapshot | `roundNumber` / `consumedAt` written once, conditionally, inside the round transaction |
| `revenue_reconciliations` | collection (key = correlation id = collection key) | derived, recomputed idempotently | expected / actual / creditable / excess / untransferred / implied retained, status, discrepancies, linked distributions |

Evidence statuses are the existing ones: collections are `collected` when verified, else `unresolved`;
inflows are `observed`; credits are `reconciled` (payable) or `unresolved`. Raw events are never payable.

## 3. Evidence: what is observed and how it is verified

All amounts are **instruction-scoped token transfers** of the transaction (never whole-transaction
balance deltas), in integer base units of the fee mint.

* **Bonding-curve creator-fee collection.** The provider's creator-fee claim (LaunchLab
  `claim_creator_fee` out of the creator fee vault; DBC `claim_creator_trading_fee` out of the pool
  vaults), only for `FEE_BENEFICIARY_ROLE=creator`. Verified when the recipient owner is the pool
  `creator`, the bonding allocation basis is **verified** against the operator declarations, and —
  LaunchLab — no other pool deposited into the shared creator vault since the previous claim
  (`shared_creator_vault_mixed_with_other_pools` otherwise: the claim cannot be apportioned).
* **Forge platform LP collection.** `collect_cp_fees` on the Raydium LP-lock program for the
  destination pool, on a lock whose Fee Key the **verified migration transaction** minted to the
  PlatformConfig `platform_nft_wallet`. Verified when `FORGE_PLATFORM_LP_BENEFICIARY` is declared and
  equals `platform_nft_wallet`, the fee-key holder signed, and the collected fees were paid to it.
  Locks minted to the creator at a historical (pre-2026-08-17) migration are the creator's own LP
  revenue and are never a Forge collection. A spec written before this PR (no platform-lock facts) is
  recorded only when the declared Forge wallet collected, and stays `unresolved`.
* **CPMM creator-fee collection.** The `collect_creator_fee(_permissionless)` transfers to the
  `pool_creator`. Only the **net** amount is observable (the accrued amount and the protocol share are
  not in the transaction). Recorded with the effective fee configuration (§6); never shared.
* **Funding inflow.** A System Program `Transfer` (native SOL) or SPL Token / Token-2022 `Transfer` /
  `TransferChecked` into a configured `LAST60_FUNDING_DESTINATIONS` wallet (SPL: a token account whose
  owner — from the transaction's token-balance metadata — is that wallet; a `TransferChecked` mint must
  match), from a wallet that can be a collection recipient of this launch (creator, declared Forge
  beneficiary, platform NFT wallet). Transfers to anyone else are not inflows (incorrect recipient).

**Assets.** Native SOL and wrapped SOL are one accounting asset (the SPL native mint is redeemable
1:1 by closing the account). Nothing else is merged: a USD1 → SOL swap (what Forgepad's claimer does
for USD1-quoted pools) is a market conversion and never satisfies a USD1 claim.

## 4. Correlation: claim ↔ distribution

A funding inflow is linked to at most one collection (unique credit key) and **never by amount alone**:

1. **same_transaction** (Case A) — a collection earlier in the same transaction, same asset, whose
   recipient is the inflow's source.
2. **memo** (Case B) — the distribution transaction carries an SPL Memo `last60:v1:<claim signature>`
   naming a collection with the same recipient and asset, not later than the transfer.
3. **exclusive_window** (opt-in, `FUNDING_CORRELATION_MODE=exclusive_window`) — exactly one candidate:
   the latest collection from that source and asset before the transfer, still under-funded, and the
   transfer does not exceed its remaining expected amount. Any second open claim, same-slot tie or
   over-amount leaves the transfer unlinked.

Otherwise the inflow stays **unlinked** (reported) and is retried on every reconciliation pass, so a
transfer indexed before its claim is linked once the claim arrives.

## 5. Reconciliation and credits

Per collection, with the collection's own immutable policy snapshot:

```
expected_last60 = ⌊(gross − pre_activation_accrual) × bps / 10 000⌋     (bonding 7 500 · Forge LP 5 000)
expected_retained = gross − expected_last60                              (rounding residual stays with creator / Forge)
credit(transfer)  = min(observed, expected_last60 − already credited)    (first observed wins; never above the policy)
```

Statuses: `awaiting_distribution` (nothing transferred; full untransferred balance), `partial`,
`reconciled`, `excess` (the excess is recorded, never payable), `unresolved` (collection not verified),
`not_applicable` (CPMM creator fees). "Forge retained" / "creator retained" are **implied**
(gross − observed contribution); they are never presented as independently observed.

A credit is payable only if **all** hold: the collection is verified (source, beneficiary, final
status); the policy is `forge_phase_aware_v1`; both the collection and the transfer are after the
activation slot; the inflow itself is clean; and there is a supported (≤ expected) amount. Otherwise
it is stored with `payoutEligible=false` and the reason.

**Pre-activation accruals.** Bonding-curve creator fees that accrued at or before the activation slot
were already distributed under the legacy policy. The first collections after activation absorb that
unclaimed balance (Σ creator-allocated swap fees ≤ activation − Σ claims ≤ activation) before any
contribution becomes creditable — so the same fee is never funded twice.

## 6. CPMM verification completed in this PR (PR #5 follow-ups)

**`creator_fee_on`** (`PoolState` byte 389; raydium-cp-swap `CreatorFeeOn::from_u8`, bundled IDL):
`0 both_tokens` (fee on the swap's input token), `1 only_token_0`, `2 only_token_1`; any other value is
rejected by the program. The verified mode is persisted on the verified migration
(`cpmmCreatorFeeOn`, raw byte too), the destination spec (`cpmm.creatorFeeOn`), the CPMM creator-fee
basis params and therefore every immutable v1 snapshot, `verify:allocation` / `resolve-migration`
output and the revenue events. An unknown byte → basis `unverifiable`; never inferred from
`enable_creator_fee`. Bases stored before this PR (no mode) are treated as unresolved
(`cpmm_creator_fee_basis_unresolved`) by `basisDistributable` and by the round's per-record rule.

**`CreatorFeeShare`** (raydium-cp-swap `states/creator_fee_share.rs`, verified on mainnet):

| Fact | Value |
|---|---|
| PDA | `["creator_fee_share", pool_creator, amm_config]`, CPMM program — reproduces account #15 of the real `collect_creator_fee_permissionless` fixture |
| Layout | 8-byte discriminator `account:CreatorFeeShare` · bump u8 · creator · amm_config · `share_rate` u64 · padding [u64; 8] = 145 bytes |
| Ownership / existence | created / closed by the CPMM admin (or a designated owner); optional — both collect instructions always pass the PDA |
| Precedence | account empty **or** not CPMM-owned → `AmmConfig.creator_fee_share_rate`; else the override's `share_rate` (discriminator checked) |
| Creator net | `accrued − ⌊accrued × share_rate / 10⁶⌋` |
| Mainnet (slot 466 191 556) | 22 accounts, all PDAs verify, all `share_rate = 0`, all for one creator (`qrLKab…`); one on Forgepad's AmmConfig `C7Cx2p…` |

Reported separately: AmmConfig default, override (`absent` / rate / `invalid`), effective rate, PDA
and the slot read. An invalid override or unreadable default → effective rate unresolved → basis
`unverifiable`. Because the admin can create / close an override at any time, the **observed net
collection transfer** remains the accounting authority; the effective rate is the validation basis.
`EXPECTED_CPMM_CREATOR_FEE_RATE` (Forgepad: 500) makes a different AmmConfig rate a `mismatch`.

## 7. Historical vs upgraded LaunchLab migrations

| Migration | Fee Keys | Treatment |
|---|---|---|
| Pre-2026-08-17 (historical) | separate platform and creator Fee Keys (`platform_scale` / `creator_scale`) | creator lock: creator's own LP revenue, only when proven by the migration's lock records (`classifyLaunchLabLocks`); platform lock: Forge platform LP stream |
| Post-upgrade | ONE Fee Key minted to `platform_nft_wallet` | Forge platform LP stream; no creator LP entitlement |

Ownership is always read from the actual migration transaction's lock records — never from
`creator_scale`, a configured percentage or a date. Ambiguous cases stay unresolved.

## 8. Rounds (reward engine)

`REWARD_FUNDING_POLICY` selects a versioned policy; every round stores its snapshot (`fundingPolicy`).

| | `legacy_creator_fee_v1` (default) | `forge_phase_aware_v1` (snapshot slot > activation slot) |
|---|---|---|
| Creator-allocated fees | `REWARD_PERCENTAGE` of the period's verified fees (unchanged) | counted only up to the activation slot (the round's `legacyFeeSlotCap`); later ones are recorded and reported (`creatorFeesRecordedNotDistributed`), never distributed |
| Contributions | recorded, reported, never consumed | payable credits in the payout asset, not yet consumed, **finalized** transaction → 100 % to the reward pool (`REWARD_PERCENTAGE` is not applied: they already are the reward share) |

`pool = ⌊fees × REWARD_BPS / 10 000⌋ + funding + rolloverIn`. Credits are consumed inside the round's
MongoDB transaction with a conditional update (`roundNumber: null`); a concurrent or repeated execution
aborts and retries, so a credit funds exactly one round. Ledger: `FUNDING_CREDITED:r<n>:<stream>`. The
reconciler checks `fees + funding + rolloverIn = retained + dust + rolloverOut + payouts`, that consumed
credits and `FUNDING_CREDITED` equal the round's funding, and re-checks capped legacy fees.

Unchanged: unique-buyer selection, the buyer snapshot, the round cadence and payout safety checks.
Forge's ~60-second claim cadence and Last-60's buyer window are separate mechanisms; nothing here
changes the buyer window. Balances are per mint; only the payout asset funds rounds.

## 9. Configuration

| Variable | Meaning |
|---|---|
| `REWARD_FUNDING_POLICY` | `legacy_creator_fee_v1` (default) or `forge_phase_aware_v1` |
| `REWARD_FUNDING_POLICY_ACTIVATION_SLOT` | required for phase-aware; set it to a slot **at or after** the deployment that enables it (credits recorded before activation are permanently ineligible — fail closed) |
| `LAST60_FUNDING_DESTINATIONS` | Last-60 funding wallets (comma separated); required for phase-aware; also watched by the indexer |
| `FORGE_PLATFORM_LP_BENEFICIARY` | expected platform Fee Key owner; must equal PlatformConfig `platform_nft_wallet` (Forgepad `8KXqQwtr…`); unset → Forge LP contributions unresolved |
| `BONDING_CREATOR_FEE_LAST60_PERCENTAGE` | default 75 (of collected bonding creator fees) |
| `FORGE_PLATFORM_LP_LAST60_PERCENTAGE` | default 50 (of collected platform LP fees) |
| `FUNDING_CORRELATION_MODE` | `strict` (default: same tx or memo) or `exclusive_window` |
| `EXPECTED_CPMM_CREATOR_FEE_RATE` | AmmConfig `creator_fee_rate` the migrated pool must use (Forgepad 500) |
| `EXPECTED_LAUNCHLAB_PLATFORM_CONFIG` | existing; required (with the rate) for a verified bonding basis |

No addresses, keys or percentages are hard-coded in code paths that decide eligibility; Forgepad
values appear only in documentation, tests and the operator report's `--forgepad` hints.

## 10. What Forgepad actually does today (inspected: chiDevtet/Forgepad-Newest @ 93a2cff, 2026-11-06)

| Script | What it does | Deployed? |
|---|---|---|
| `scripts/forgeRaydiumPlatformFeeClaimer.js` | LaunchLab **bonding-curve platform-fee** vault sweep (`claimVaultPlatformFee`), every **5 min** (`RAYDIUM_FEE_CLAIM_INTERVAL_MS` 300 000); exact per-token attribution from indexed vault deltas; non-SOL quotes swapped to SOL (Jupiter); pays **50 % of the SOL basis** to each launch's `rewards_distributor_publickey` in a **separate** atomic transaction (≤ 8 targets), no memo; writes `total_postmigration_rewards_distributed` (mislabelled: this is bonding platform fee) | yes — the only app in `ecosystem.config.js`; dry-run unless `RAYDIUM_FEE_DRY_RUN=false` |
| `scripts/Raypostmigration.js` | **post-migration locked-LP** harvest (`raydium.cpmm.harvestLockLp` via `fetchCpmmLockBalances` on the platform wallet), default every **1 h** (`POSTMIG_INTERVAL_MS`); pays `POSTMIG_REWARDS_PERCENT` (0.5) of the **quote leg only** in a **separate** `SystemProgram.transfer`, no memo; USD1 legs swapped to SOL first; token leg retained; header still describes the pre-upgrade 50 / 50 scales and states zero migrations at build time | **no** (not in `ecosystem.config.js`; dry-run by default) |
| `scripts/forgeFeeClaimer.js` | Meteora DBC **partner**-fee claim + 50 % (charity 70 %) to the distributor **in the same transaction**; DAMM v2 position claims; **60-second** cycle | not in this repo's PM2 config; `OLD_PRIV_KEY = ""` would not start as committed |
| live Meteora claimers (`feeCap.js`, `forgeFeeClaimer2.js`, `poolsDBC.js`) | referenced by `feeSplit.claimerDrift.test.ts` (`FORGE_CLAIMER_DIR=/home/claimer`) | **not in the repository** — could not be inspected |
| `pages/api/raydium/claim-creator-fees-tx.ts` | builds the creator's own `claimCreatorFee` transaction, paid to the creator | used by the app; **no 25 / 75 split** |

Findings that matter for this model:

1. **No 25 % / 75 % bonding creator-fee split exists in Forgepad.** The creator claims to their own
   wallet; nothing forwards 75 % to Last-60. LAST60 therefore records the collection and an
   `awaiting_distribution` reconciliation with the full untransferred 75 % — and funds nothing.
2. **No post-migration LP claimer runs on a ~60-second cadence.** The LP harvester is undeployed and
   hourly; the 60-second worker is the Meteora DBC claimer. The deployed 5-minute Raydium worker claims
   *bonding-curve platform fees* — a stream outside this model (never Last-60 funding here).
3. **Distributions go to per-token `rewards_distributors` wallets** chosen from Forgepad's MongoDB,
   in separate transactions without a correlation memo. Those wallets are not Last-60 funding
   destinations unless configured as such.
4. Multiple fee mints: the LP harvester handles both legs but pays from the quote leg only and swaps
   USD1 → SOL; LAST60 keeps each mint separate and never accepts a converted amount.
5. Retries / duplicates: Forgepad's scripts log to Mongo but do not use on-chain idempotency for
   payouts; LAST60's own idempotency does not depend on them.

## 11. Required Forgepad-side changes (not part of this repository)

To make contributions fundable under `forge_phase_aware_v1`:

1. **Destination.** Send Last-60 contributions to the wallet(s) configured in
   `LAST60_FUNDING_DESTINATIONS` (e.g. the Last-60 payout wallet), not to per-token distributors.
2. **Correlation.** Either distribute in the **same transaction** as the claim (preferred: the claim's
   recipient transfers to the destination after the claim instruction), or add an SPL Memo
   `last60:v1:<claim transaction signature>` to the separate distribution transaction.
3. **Exact amount.** Contribution = ⌊collected × bps / 10 000⌋ of the **actual** claimed amount in the
   **same mint** (50 % of each LP claim leg; 75 % of each collected bonding creator fee). Do not swap
   before contributing if the contribution should be fundable; a converted amount stays unresolved.
4. **Bonding creator split.** A mechanism for the 75 % must be built and agreed with creators (e.g. a
   Forge-built claim transaction that claims the creator fee and transfers 75 % to the destination in
   the same transaction, signed by the creator). LAST60 never transfers creator fees itself.
5. **Post-migration claimer.** Deploy an LP-fee claimer for the platform Fee Key (and fix its scale
   comments for the post-upgrade single Fee Key); the cadence is Forge's choice and does not affect
   Last-60's buyer window.
6. **Platform wallet.** Keep `platform_nft_wallet` = `FORGE_PLATFORM_LP_BENEFICIARY`; a change must be
   declared before it is used.

## 12. Operator runbook

```bash
bun run cli revenue               # every stream, per mint; discrepancies and unlinked inflows
bun run cli revenue --json
bun run cli revenue-reconcile     # re-run correlation + reconciliation (idempotent)
bun run report:revenue [--pool P] [--json]   # same report; exit 2 when discrepancies / unlinked inflows exist
bun run verify:allocation         # now also prints creator_fee_on and the CreatorFeeShare resolution
bun run fixtures:cpmm-fee-share   # refresh the CreatorFeeShare mainnet evidence (read-only)
```

Rollout:

1. Deploy with the default legacy policy; set `LAST60_FUNDING_DESTINATIONS`,
   `FORGE_PLATFORM_LP_BENEFICIARY`, `EXPECTED_CPMM_CREATOR_FEE_RATE`. Revenue events, reconciliations
   and (ineligible) links are recorded; rounds are unchanged.
2. Ship the Forgepad changes (§11). Confirm with `bun run cli revenue` that collections reconcile and
   inflows link (`same_transaction` / `memo`), with no `excess` or `unresolved` rows.
3. Choose an activation slot at or after the switch-over and set `REWARD_FUNDING_POLICY=forge_phase_aware_v1`
   with `REWARD_FUNDING_POLICY_ACTIVATION_SLOT` on **both** workers (and the CLI). Rounds whose
   snapshot is after it are funded by verified contributions only.
4. Watch the reconciler (`FUNDING_CREDITED` vs consumed credits) and the revenue report.

## 13. Known limitations

* No Forgepad LaunchLab launch has graduated yet: Forge LP claim and distribution transactions are
  tested on synthetic transactions over the real migration fixture, not on a real Forge claim.
* The `exclusive_window` scan looks at the latest 200 collections of a source; older open claims beyond
  that window are not considered (use memo or same-transaction correlation in production).
* Bonding-curve creator-fee claims are parsed only for `FEE_BENEFICIARY_ROLE=creator`.
* The CPMM accrued (pre-share) amount is not observable from a collection transaction; only the net is
  reported.
* `closeAccount`-based lamport inflows into a destination are not recognised as contributions.
* Funding destinations are indexed like pool addresses (cursor per address, `INDEXER_BACKFILL` applies).
  Prefer a **dedicated** funding wallet: using a wallet with a long unrelated history makes the first
  backfill read that history (outflows and unrelated inflows are ignored, but still fetched).
* Reconciliation passes are per launch and scan that launch's unlinked inflows / unreconciled claims
  (bounded to 500 per pass); at very high claim counts consider archiving fully reconciled claims.
