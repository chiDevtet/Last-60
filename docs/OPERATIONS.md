# Operations runbook

All actions are available in the admin console (`/admin`) and the CLI (`bun run cli …`). Every
mutation is audited.

| Situation | What you see | Action |
|---|---|---|
| Payout wallet short | round `awaiting_funds`, WARN line, `Waiting to be paid` grows | Fund the wallet. Payouts resume automatically (retry every ~15 s). Nothing is partially sent. |
| Payout failed after max attempts | round `attention`, ERROR line, admin "Failed payouts" | Inspect `lastError` (`bun run cli round <n>`). Fix the cause, then **Requeue** (safe: all prior attempts are provably dead). |
| Reconciliation halt | health `degraded`, "payouts halted" | Over-attribution detected. Compare `cli reconcile` output with the chain (`scripts/verify-fee-attribution.ts`). Only after explaining the difference: `cli clear-halt "<reason>"`. |
| RPC outage / 429s | indexer/rewards `degraded`, retries in logs | Automatic failover to `SOLANA_RPC_FALLBACK_URLS`. Add/replace endpoints in admin config (no restart). Rounds whose catch-up cannot complete stay `snapshotting` and resume; they never snapshot incomplete data. |
| MongoDB outage | everything `degraded`/`down` | Workers back off and resume; all writes are idempotent/conditional. No action beyond restoring Mongo. |
| Worker crash | heartbeat stale, PM2 restarts it | Nothing. A crashed snapshot resumes from its persisted slot; submitted payouts are rechecked/rebroadcast. |
| Rounds `missed` | WARN "window missed" | The engine was down for a whole final window; its buys and fees flow into the next executed round. Investigate the outage. |
| Pool graduating | WARN "Pool status is migrating/migrated", UI banner | Switch to the post-migration adapter (see `PROVIDERS.md`). Until then new fees are not attributed. |
| Unrecognised pool activity | WARN "flagged for review" | A program upgrade may have changed events. Check `anomalies` in logs; update the IDL/adapter. Unknown activity is never counted. |
| Emergency stop | — | `cli pause payouts` (stops signing; in-flight transactions still confirm), `cli pause scheduler` (no new snapshots), `cli pause indexer`. Resume with `resume`. |
| Change reward parameters | — | Admin config. Applies from the next snapshot; each round stores the config it used. |
| Switch provider / pool | — | Admin config (critical: needs confirmation + reason). The indexer re-attaches and ingests the current reward period. |
| Rotate payout key | — | Pause payouts → wait until no payout is `submitted` → swap key file and `PAYOUT_WALLET_PUBLIC_KEY` + admin `expectedPayoutPublicKey` → restart `last60-rewards` → resume. |
| Rotate schedule key | — | Only between rounds' final windows: restart `last60-rewards` with the new key **before** the next window opens (old ciphertexts are only needed for the current round). |

## Routine checks

* Daily: `bun run cli status`, `bun run cli reconcile`, spot-check a round with
  `scripts/verify-round.ts`.
* Keep the payout wallet funded for at least a day of rewards plus fees.
* Back up MongoDB; test restores.
