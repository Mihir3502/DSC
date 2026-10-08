# ADR-0003 — Candidate Registration and Recovery

- **Status:** Accepted, pending recorded project approval (see Approvals)
- **Date:** 2026-10-06
- **Work item:** M1.2 (`docs/tasks/M1.2_CANDIDATE_REGISTRATION_RECOVERY.md`)
- **Depends on:** ADR-0001, ADR-0002. This ADR supersedes ADR-0002's accepted risk for email verification (stateless, replayable verification links).

## Context

Candidates need controlled self-registration, verified email before any session, sign-in and sign-out, account recovery, password change, and management of their own sessions (`PRODUCT_REQUIREMENTS.md` PRD-AUTH-001/002/005/006, `SECURITY_AND_PRIVACY.md` §7–9). No M2 business records may be created. Staff authentication is M1.3.

## Decisions

### Candidate-only registration

- Registration is an application command (`registerCandidate`), not Better Auth sign-up. Generic sign-up stays disabled.
- The browser submits only an intent token, email, password, and confirmation.
- The server creates the `auth.user` row and its credential in one transaction, with fixed values: `CANDIDATE`, `INVITED`, `email_verified=false`. The password hash comes from Better Auth's own hasher.
- A concurrent duplicate is absorbed by `ON CONFLICT (email) DO NOTHING`.
- Duplicate, staff, and service emails get the same public outcome and the same password-hashing work. They are never converted or disclosed.
- An existing invited, unverified candidate is offered a fresh code.
- **Approved state transition (project owner, 2026-10-06):** `INVITED → ACTIVE` when the email is verified.
  - It runs as a single conditional `UPDATE … WHERE status='INVITED' AND account_type='CANDIDATE' AND email_verified`, so it can never overwrite a concurrent restriction.
  - It runs from Better Auth's `afterEmailVerification` hook.
  - It is repaired idempotently at sign-in if the hook was interrupted.
- The session-creation hook also requires `email_verified` for candidates.

### Registration intents (no M2 records)

| Source | Form | Persistence |
|---|---|---|
| `PUBLIC_POSITION` | HMAC-SHA256 signed state (auth secret, purpose `registration-intent.v1`, issued/expiry, closed continuation key), issued fresh on each `/register` render | None. It grants nothing, so it is not single-use. |
| `CANDIDATE_INVITATION` | Random 256-bit capability in a `/register#intent=…` link | `auth.verification`, identifier namespace `registration-intent:` (stored hashed), value `{source, boundEmail, continuationKey}`, expiry, consumed atomically and once |

- The namespace cannot collide with `reset-password:` or the email-OTP identifiers.
- No new table and no migration.
- Invitations are issued only server-side. For now the only callers are tests and the local/test-only `pnpm auth:intent:local`, which allows reserved domains only.
- Staff-facing issuance waits for M1.4/M1.5 authorization.

**M2.1 start-application handoff.** This reuses the same HMAC-SHA256 construction and secret under a distinct purpose, `application-handoff.v1`. The payload is `{v, purpose, ref, iat, exp, n}`. `ref` is the hiring cycle's public reference, never an internal ID; the lifetime is 30 minutes.

- **Carrier:** an `HttpOnly`, `SameSite=Lax` cookie (`__Secure-` when cookies are secure). It never appears in a URL.
- **No business record:** it creates no person, candidacy, or application.
- **Not single-use:** like the public intent, it grants nothing.
- **Revalidation:** the cycle's availability is checked again at issue time, after authentication, and again by M2.2 when it creates the candidacy.
- **Continuation:** the new continuation key `APPLICATION_START` resolves to `/candidate/applications/new`.
- **Failure:** a tampered, expired, wrong-purpose, or closed handoff fails with one generic result.

### Email verification: Better Auth email-OTP plugin

Decided by the project owner on 2026-10-06, replacing the stateless verification links.

- **Code:** 8 digits, 3 attempts, `AUTH_OTP_EXPIRES_IN_SECONDS` (default 600). Stored hashed (`storeOTP: "hashed"`), with the identifier hashed by `verification.storeIdentifier: "hashed"`. Verification is atomic and single-use.
- **Resend:** `resendStrategy: "rotate"`, so only one code is active.
- **Unused plugin features:** OTP sign-in, OTP password reset, and email change are not used.
  - The `sendVerificationOTP` hook emails only `email-verification` codes, and only to invited, unverified candidates.
  - All plugin HTTP paths are disabled.
- **No session on verification:** `autoSignInAfterVerification` is off, so the candidate signs in afterwards.
- **Accepted trade-off:** an 8-digit code with 3 attempts per issued code, combined with send rate limits. The code travels in the email body, not a URL.

### Password recovery and reset

- Better Auth's maintained flow: a 24-character token, single-use, consumed atomically with `consumeVerificationValue`, identifier stored hashed, lifetime `AUTH_RESET_EXPIRES_IN_SECONDS` (default 1800), and `revokeSessionsOnPasswordReset: true`.
- The `sendResetPassword` hook emails only active, verified candidates. The link is built from `BETTER_AUTH_URL` as `/reset-password#token=…`.
  - The token is in the fragment, so it never reaches a server, access log, or Referer header.
  - The page reads it, calls `history.replaceState` before rendering the form, keeps it in memory, and posts it.
  - Better Auth's `GET /reset-password/:token` redirect, which would put the token in a query string, is never linked and isn't reachable.
- `resetCandidatePassword` validates the password first, so a rejected password doesn't burn the link. It then checks that the token's account is an eligible candidate before Better Auth consumes it.
- Reset never changes type, status, or verification. It sends a password-changed notice, and the candidate must sign in again.

### Closed HTTP surface

- Every candidate flow is a same-origin Next.js server action calling `auth.api.*`. Next.js rejects cross-origin actions.
- The `/api/auth/[...all]` route forwards only `GET /get-session`. Everything else gets a closed 404.
- Better Auth `disabledPaths` additionally lists sign-up, every email-OTP path, reset, change-password, update-user, and session-management paths.
- Candidate sign-in refuses staff and service accounts before Better Auth is called, with equalized work and the same response.

### Sessions and pages

- `/candidate/security` resolves the current candidate on the server. It shows a masked email, verification status, password change, and the candidate's own sessions under HMAC-derived opaque references. It never shows tokens, session IDs, IPs, or full user agents; the device label is coarse.
- Revoking one session, all other sessions, or every session ("sign out everywhere") rechecks ownership at command time and is idempotent.
- Password change uses Better Auth `changePassword` with `revokeOtherSessions: true` and rotates the current cookie.
- `Referrer-Policy: no-referrer` is set on every response. `Cache-Control: no-store` is set on auth and candidate pages.
- Post-authentication destinations come from a closed key registry (`CANDIDATE_SECURITY → /candidate/security`).

### Ports

- **`AuthEmailPort`:** typed templates (`EMAIL_VERIFICATION_CODE`, `PASSWORD_RESET`, `PASSWORD_CHANGED`) with escaped, minimal content, no remote assets, and origin from configuration.
  - An asynchronous in-process dispatcher keeps response timing independent of whether email was sent.
  - Transports: `smtp-local` (Mailpit via nodemailer 10.0.15, loopback only), `capture-file` (test only), and `refuse` (the default).
  - Staging and production refuse `smtp-local` and `capture-file`.
- **`CompromisedPasswordPort`:** exact match against a deterministic local denylist; no network. Production-like startup fails closed.
- **`SecurityEventPort`:** allowlisted event codes and an opaque account reference, written through the M0.5 logger. Marked for replacement by M1.6. PRD-AUTH-007 isn't satisfied until then. *Superseded for events by ADR-0012 (M1.6): the port now persists durably; registration is atomic with its event, and verification and reset are provider-committed.*
- **Action rate limiter:** per-process, fixed window, SHA-256-keyed. Recovery and resend use silent per-email caps, so nobody can lock out a target or enumerate accounts.

## Open decisions

- Production email provider and delivery worker (`pg-boss` not added).
- Approved compromised-password provider (privacy-preserving).
- Distributed rate-limit store (staging/production startup already refused, ADR-0002).
- Session timeout policy (local defaults only).
- Optional duplicate-registration security notification (not approved; not sent).
- Candidate notices/terms text (none approved; no acceptance step).
- Recent-authentication step-up and MFA (M1.3): staff only, see ADR-0004. Candidate MFA and candidate step-up are not in scope.

## Consequences

**Positive:**
- Verification and reset capabilities are single-use, short-lived, purpose-bound, and hashed at rest.
- No capability reaches server logs or browser history.
- Candidate-only enforcement happens server-side in three layers: the command, the session hook, and the closed HTTP surface.
- No schema migration.

**Negative:**
- Verification codes depend on the email body.
- The in-process dispatcher and in-memory rate limiter are local seams, not production designs.
- Activation is a follow-up statement after Better Auth's verify update, covered by the idempotent sign-in repair.

## Approvals

| Role | Name | Date |
|---|---|---|
| Project owner | _pending_ | |
| Technical lead | _pending_ | |
| Security reviewer | _pending_ | |
