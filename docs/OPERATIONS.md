# Operations runbook

All actions are available in the admin console (`/admin`) and the CLI (`bun run cli …`). Every
mutation is audited.

| Situation | What you see | Action |
|---|---|---|
| Payout wallet short | round `awaiting_funds`, WARN line, payout `lastError` states the asset, have/need and the amount to add (SOL, SPL token, or SOL for fees/rent) | Fund the wallet. Payouts resume automatically (retry every 5–20 s). Nothing is partially sent. |
| Payout failed after max attempts | round `attention`, ERROR line, admin "Failed payouts" | Inspect `lastError` (`bun run cli round <n>`). Fix the cause, then **Requeue** (safe: all prior attempts are provably dead). |
| Reconciliation halt | health `degraded`, "payouts halted" | Over-attribution detected. Compare `cli reconcile` output with the chain (`scripts/verify-fee-attribution.ts`). Only after explaining the difference: `cli clear-halt "<reason>"`. |
| RPC outage / 429s | indexer/rewards `degraded`, retries in logs | Automatic failover to `SOLANA_RPC_FALLBACK_URLS`. Add/replace endpoints in admin config (no restart). Rounds whose catch-up cannot complete stay `snapshotting` and resume; they never snapshot incomplete data. |
| MongoDB outage | everything `degraded`/`down` | Workers back off and resume; all writes are idempotent/conditional. No action beyond restoring Mongo. |
| Worker crash | heartbeat stale, PM2 restarts it | Nothing. A crashed snapshot resumes from its persisted slot; submitted payouts are rechecked/rebroadcast. |
| Rounds `missed` | WARN "window missed" | The engine was down for a whole final window; its buys and fees flow into the next executed round. Investigate the outage. |
| Pool graduating | WARN "Pool status is migrating/migrated", then "Pool graduated … destination verified" or "NOT verified" | Nothing to switch: a strictly verified DAMM v2 / CPMM destination is attached automatically. If NOT verified or unsupported, check `pools.migration.failed` (admin status) and `bun scripts/resolve-migration.ts`; destination activity is not accounted until verified. |
| `ALLOCATION MISMATCH` warning / round "not eligible for payout" | WARN lines, `rounds.ineligibleFees`, `FEE_EXCLUDED` ledger rows | The on-chain creator allocation differs from the declared `EXPECTED_*`, or an allocation could not be proven. Those fees are recorded but not paid. Confirm the real configuration with Forgepad; fix the declaration only if the chain is right. Historical records are never re-attributed implicitly. |
| Indexer/rewards refuse to attach: "already has fee records attributed under role …" | worker `degraded` | `FEE_BENEFICIARY_ROLE` differs from the role the pool's records were attributed under. Restore the previous role (role changes on a pool with history are not supported). |
| Unrecognised pool activity | WARN "flagged for review" | A program upgrade may have changed events. Check `anomalies` in logs; update the IDL/adapter. Unknown activity is never counted. |
| Emergency stop | — | `cli pause payouts` (stops signing; in-flight transactions still confirm), `cli pause scheduler` (no new snapshots), `cli pause indexer`. Resume with `resume`. Switching `payoutMode` to `dry_run` also stops signing of queued live payouts (they stay `pending` until live mode returns). |
| "Live payouts are queued and not being signed" | WARN line, payouts `pending` with `lastError` | Live mode is set but the rewards worker's own environment forbids signing (mainnet without `ALLOW_MAINNET_PAYOUTS=true`). Fix `.env.rewards` and restart, or switch back to dry-run. |
| Round stuck `snapshotting` with "refusing to snapshot" | `lastError` names a lagging slot or a catch-up backlog | The RPC answered from behind the previous snapshot, or the indexer is too far behind. It retries automatically; check RPC health / indexer lag. |
| Ledger check: "period fees are now X but Y were distributed" | ERROR line | Transactions arrived after a snapshot (or counted ones were dropped). Investigate the RPC/indexer around that round; the difference was not paid. |
| Revenue report shows `awaiting_distribution` / `partial` claims | `bun run cli revenue` lists the claim, its untransferred balance and distributions | A Forge LP claim (or creator-fee collection) was not (fully) distributed to `LAST60_FUNDING_DESTINATIONS`. Nothing was funded for the missing part. Ask Forge to complete the transfer (same transaction or memo `last60:v1:<claim signature>`); it is linked automatically when indexed (`cli revenue-reconcile` re-runs the pass). |
| Unlinked funding inflows | report `unlinked funding inflows > 0` (`report:revenue` exits 2) | A transfer reached a destination but could not be tied to a claim (no memo, different mint, unknown claim). It is never funding. Fix the correlation at the source; do not relabel it by hand. |
| `excess` claims / `exceeds_policy_amount` credits | report discrepancies | More than the policy share was transferred. The excess is recorded and never paid; no action is required beyond confirming the transfer with Forge. |
| CPMM creator-fee basis `unverifiable` (`creator_fee_on` / share rate) | `verify:allocation` migration line, `cpmm_creator_fee_basis_unresolved` in rounds | The pool's `creator_fee_on` byte is not a known mode, the CreatorFeeShare override is invalid, or the spec predates PR #6. CPMM creator fees are recorded, never distributed. They are never Last-60 funding under the phase-aware policy anyway. |
| Enable phase-aware funding | — | Follow REWARD_FUNDING.md §12: Forgepad changes first, verify linking in the report, then set `REWARD_FUNDING_POLICY=forge_phase_aware_v2` + an activation slot at/after the switch-over on both workers. |
| Change reward parameters | — | Admin config. Applies from the next snapshot; each round stores the config it used. |
| Switch provider / pool | — | Admin config (critical: needs confirmation + reason). The indexer re-attaches and ingests the current reward period. |
| Rotate payout key | — | Pause payouts → wait until no payout is `submitted` → swap key file and `PAYOUT_WALLET_PUBLIC_KEY` + admin `expectedPayoutPublicKey` → restart `last60-rewards` → resume. |
| Rotate schedule key | — | Only between rounds' final windows: restart `last60-rewards` with the new key **before** the next window opens (old ciphertexts are only needed for the current round). |

## Routine checks

* Daily: `bun run cli status`, `bun run cli reconcile`, `bun run cli revenue`, spot-check a round
  with `scripts/verify-round.ts`.
* Keep the payout wallet funded for at least a day of rewards plus fees.
* Back up MongoDB; test restores.
