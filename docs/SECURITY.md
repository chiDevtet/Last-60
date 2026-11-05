# Security model

## Keys

| Secret | Held by | Never in |
|---|---|---|
| Payout wallet key (`PAYOUT_WALLET_KEYPAIR_PATH` preferred, chmod 600 enforced; or `PAYOUT_WALLET_PRIVATE_KEY`) | `last60-rewards` only | API, web, logs, DB, admin UI |
| Fee claim authority key (optional) | `last60-rewards` only | same |
| `SCHEDULE_ENCRYPTION_KEY` | `last60-rewards` only (the API warns if it is set there) | API, web, logs |
| `ADMIN_SESSION_SECRET` | `last60-api` | web |
| `MONGODB_URI`, RPC API keys | servers | web (`NEXT_PUBLIC_*` values are scanned for secret values and secret-looking names at startup and refused) |

* Keys are loaded once, the loaded public key must equal `PAYOUT_WALLET_PUBLIC_KEY`, and the
  executor refuses to sign if the admin-configured `expectedPayoutPublicKey` differs.
* Secrets are deleted from `process.env` after loading; logger redaction covers key, schedule and
  serialized-transaction fields.
* Use a **dedicated** payout wallet funded only with what rounds need. If the payout wallet is also
  the fee beneficiary (auto-claim), its compromise also exposes claim rights — keep a separate
  claim authority when possible. A KMS/HSM signer can replace `Keypair` behind the same interface.

## Money movement invariants

1. One payout row per `(round, recipient)` — unique index.
2. A transaction is broadcast only after its signature, blockhash, `lastValidBlockHeight` and
   bytes are persisted under a fencing token; a worker that lost its lock cannot send.
3. A new transaction for the same payout is created only when the previous one provably cannot
   land (finalized height past its `lastValidBlockHeight` and signature unknown, or failed at
   `finalized`). Rebroadcasts reuse identical bytes.
4. "Paid" is written only at `PAYOUT_COMMITMENT` (default `finalized`).
5. Funds are checked before signing, *after* the payout is reserved (`signing`), counting every other
   reserved or in-flight live payout, so concurrent workers cannot rely on the same balance. SPL
   payouts also check the token balance and SOL for fees + recipient token-account rent.
6. A round's allocation, payouts and ledger entries commit in one MongoDB transaction; a round
   executes once (CAS on state + lease + fencing).
7. Reconciliation halts new payouts on over-attribution.
8. Default `PAYOUT_MODE=dry_run`; mainnet live requires a second explicit switch, re-checked by the
   signing process against its own environment before every signature (`liveSigningBlockReason`).
9. Snapshot slots strictly increase; a lagging RPC slot is refused instead of re-opening a paid period.
10. "Expired" requires the signature to be unknown to nodes at or past the finalized slot that proves
    expiry (`getEpochInfo` + status context slot), so a lagging backend cannot trigger a re-sign.
11. Confirmation, its ledger entry and buyer statistics commit atomically; legacy rows are repaired
    idempotently.
12. Only payout-eligible, creator-allocated fees are distributed. Unproven or mismatching allocations
    (vs. the operator's declaration), unverified migrations and unsupported destinations are recorded
    but never paid.
13. Fee collection stays `manual` until the real claim signer, authority, beneficiary and claim
    permissions are verified; auto-claim is gated by the same signer-side live checks as payouts.

Tests: `test/rewards.test.ts` (fault-injected chain), `test/payouts-runtime.test.ts` (real Solana
runtime via LiteSVM).

## Schedule privacy

The execution instant is drawn with `crypto.randomInt` at the start of the final window, sealed
with AES-256-GCM (associated data = round number), stored `select: false`, and decrypted only in
the rewards worker. It is absent from every public response, terminal line, log line and admin
endpoint — so administrators cannot front-run it either. Payout transactions become public
on-chain the moment they happen; that is inherent and acceptable.

Residual risks: anyone with **both** database access and the schedule key could read upcoming
instants — keep the key only on the rewards host. An operator controlling the rewards worker could
in principle trigger early; the persisted, sealed draw and the immutable `scheduleGeneratedAt`
make such tampering detectable in an audit.

## Fairness

Randomness chooses *when*; recipients are a deterministic function of on-chain buys at the
snapshot slot, re-derivable by anyone with `scripts/verify-round.ts`. The pool creator, fee
beneficiary and payout wallet are excluded automatically; `EXCLUDED_WALLETS` adds more.
Off-curve (program) addresses are never paid.

## Admin

Sign-In With Solana: single-use, expiring nonces in a SIWS (CAIP-122) message bound to
`PUBLIC_SITE_URL`'s host — required in production, never derived from `Host`; wallets implementing
`solana:signIn` (and SIWS-aware `signMessage`) refuse or warn when the requesting page is not that
domain, and `/auth/verify` rejects altered SIWS fields and browser requests from another origin
(phishing relay). ed25519 verification, HMAC session tokens re-checked against the current
allow-list, per-IP rate limits, version-checked and audited configuration changes, confirmation +
reason for critical keys, no secret editable or readable. The API sends `nosniff`, `no-referrer`,
`DENY` framing; CORS allows only `CORS_ORIGINS` (required in production; development without it
allows loopback origins only — arbitrary origins are never reflected). SSE connections are capped
per client address and in total with a maximum lifetime; the Bun server has a finite idle timeout.
The web app sends a strict CSP and `frame-ancestors 'none'`.

## Reporting

Treat the rewards host as the crown jewel: minimal inbound access, OS-level secrets handling,
disk encryption, and alerting on `ERROR`/`WARN` terminal events and degraded health.
