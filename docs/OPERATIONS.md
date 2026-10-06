# Operational Logging, Errors, and Correlation

This document describes the M0.5 foundation in `psa-hiring/src/shared/logging`, `src/shared/errors`, `src/shared/http`, `src/proxy.ts`, `src/instrumentation.ts`, and the App Router error boundaries.

## 1. Operational logs are not the audit trail

| Concern | Purpose | Where it lives |
|---|---|---|
| Operational log | Diagnose runtime behavior with safe, bounded context | JSON lines on stdout |
| Correlation ID | Connect one request's logs to the reference a user sees | Request lifetime, `x-correlation-id` header, logs |
| Internal error | Trusted classification for control flow | In memory only |
| Public error | Minimal stable response or UI | Response body or error page |
| Business audit record | Immutable evidence of sensitive business actions | **Not implemented yet (M1+)** |

Never use operational logs as a substitute for business audit records. A future audit write failure must fail the command; it must not be reduced to a log line.

## 2. Logger

Business code depends on the `AppLogger` contract (`src/shared/logging/logger.ts`), never on Pino directly.

```ts
import { getLogger } from "@/shared/logging";

const log = getLogger().child({ module: "readiness", correlationId });
log.info("gate.evaluated", { resultCode: "blocked", recordRef: "rr_8f2k" });
```

- The first argument is a stable event code (`^[a-z][a-z0-9_.-]{0,63}$`). Invalid codes are logged as `invalid.event_code`. Never interpolate data into it.
- The second argument is a typed allowlisted `LogContext`. TypeScript rejects `Error`, `Request`, `Headers`, and arbitrary keys.
- There is no way to log an error object. Log its normalized code: `log.error("request.failed", { errorCode: normalizeError(e).code })`.

### Allowed fields

| Field | Rule |
|---|---|
| `service`, `environment` | Set by the adapter (`psa-hiring`; `APP_ENV` or `unknown`) |
| `time`, `level`, `msg` | ISO-8601 timestamp, level label, event code |
| `module`, `action`, `eventCode`, `resultCode` | Lowercase token, 64 characters max |
| `errorCode` | Closed internal or public error code |
| `errorDigest` | Next.js digest (alphanumeric, 64 characters max), logged next to `correlationId` |
| `correlationId` | Valid UUID only |
| `routeTemplate` | Static template or label (`/candidate`, `/api/(other)`), never a raw URL or query |
| `method` | Allowlisted HTTP method |
| `statusCode` | Integer 100–599 |
| `durationMs` | Integer 0–3,600,000, measured, never estimated |
| `actorRef`, `recordRef` | Opaque internal reference `[A-Za-z0-9_-]{1,64}`, never an email, name, or SSN |

Every record passes `toSafeLogFields()` before serialization. Unknown keys, nested objects, and invalid values are **omitted**, not truncated or hashed.

### Forbidden data (never logged)

Request or response bodies; full URLs and query strings; headers; cookies; sessions; authorization data; passwords, tokens, and MFA material; personal application answers; SSN/TIN; bank, routing, or card values; identity-document numbers; dates of birth; full addresses; medical, TB, drug-screen, background, or screening details; document contents; signed URLs; encryption keys; SQL text or bindings; provider payloads; environment variables; error messages, stacks, and causes.

### Redaction

Pino `redact` paths (`src/shared/logging/redaction.ts`) replace sensitive keys at any depth up to four levels with the constant `[REDACTED]`. No prefixes, suffixes, lengths, or hashes are kept. This is defense in depth behind the allowlist; it does not permit passing broad objects.

### Destinations

Output is structured JSON in every environment. There is no pretty printer. The root logger writes to stdout and is created lazily. Stacks are never emitted.

### Capturing logs in tests

Create a logger with an in-memory destination instead of patching `console`:

```ts
import { createLogger } from "@/shared/logging";
import { createMemoryDestination, findCanaryCategories } from "tests/fixtures/canaries";

const destination = createMemoryDestination();
const logger = createLogger({ destination });
// ... exercise code ...
expect(findCanaryCategories(destination.raw())).toEqual([]); // reports category names only
```

Use the synthetic canaries in `tests/fixtures/canaries.ts`. Assert with category lists or booleans so a failing test never prints a canary value.

## 3. Correlation ID contract

- **Header:** `x-correlation-id` (request and response).
- **Accepted format:** a 36-character UUID (`8-4-4-4-12` hex, version 1–8, RFC variant), case-insensitive, normalized to lowercase. Anything else, whether missing, oversized, containing whitespace or control characters, or injection-shaped, is discarded.
- **Generation:** `crypto.randomUUID()`.
- **Trust boundary:** `src/proxy.ts` (Next.js 16 proxy, Node.js runtime) runs for every page and API request except `_next/static`, `_next/image`, and paths with a file extension. It resolves the ID, overwrites the forwarded request header so downstream code receives only a validated ID, sets the response header, and logs `request.received` (method, route label, correlationId; no status or duration, because the proxy runs before rendering).
- **Route handlers:** wrap them with `withRouteHandler({ routeTemplate }, handler)` (`src/shared/http/route-handler.ts`). It re-validates the header, runs the handler inside `AsyncLocalStorage` (`runWithRequestContext`), logs exactly one `request.completed` (actual status, measured duration) or `request.failed` record, and sets the header on every response.
- **Rendering:** the root layout reads the forwarded header with `headers()` and provides it to the error boundary as the request reference. This makes every route dynamically rendered.
- **Server render errors:** `src/instrumentation.ts` `onRequestError` (via `logRequestError` in `src/shared/logging/request-error.ts`) logs `request.error` with correlationId, route path, method, `errorCode: INTERNAL.UNEXPECTED`, and the Next.js `errorDigest`. That makes the digest shown by `global-error.tsx` traceable.
- **Future tracing:** `traceparent` is not trusted or propagated in M0.5. A future OpenTelemetry adapter can carry the W3C trace ID in its own field next to `correlationId`; the application correlation ID stays the user-facing reference.

## 4. Error contract

Internal classes (`src/shared/errors`, framework-neutral) carry only a stable code and an internal `cause`. Their `message` is the code.

| Internal class | Internal code | Public code | Status |
|---|---|---|---|
| `ValidationError` | `VALIDATION.INVALID_INPUT` | `VALIDATION_FAILED` | 400 |
| `AuthenticationRequiredError`* | `AUTH.REQUIRED` | `UNAUTHENTICATED` | 401 |
| `NotFoundError` | `RESOURCE.NOT_FOUND` | `NOT_FOUND` | 404 |
| `AccessDeniedError`* | `ACCESS.DENIED` | `NOT_FOUND` (non-enumerating) | 404 |
| `ConflictError` | `STATE.CONFLICT` | `CONFLICT` | 409 |
| `DomainRuleError` | `DOMAIN.RULE_VIOLATED` | `CONFLICT` | 409 |
| `DependencyError` | `DEPENDENCY.UNAVAILABLE` | `SERVICE_UNAVAILABLE` | 503 |
| anything else | `INTERNAL.UNEXPECTED` | `INTERNAL_ERROR` | 500 |

\* Mapping contract only; authentication and authorization arrive in M1.

`normalizeError()` trusts only real `ApplicationError` instances. Strings, plain objects, and database- or provider-shaped errors become `INTERNAL.UNEXPECTED`. Nothing is classified by inspecting messages or properties.

Public problem responses (`toPublicError` + `problemResponse`) use `application/problem+json`, `cache-control: no-store`, and the correlation header:

```json
{
  "type": "about:blank",
  "title": "Unable to complete the request",
  "status": 500,
  "code": "INTERNAL_ERROR",
  "correlationId": "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b"
}
```

Titles come only from the registry in `error-codes.ts`. Messages, stacks, causes, SQL, paths, and provider data are never returned.

```ts
export const GET = withRouteHandler({ routeTemplate: "/api/example" }, async () => {
  throw new NotFoundError(); // → 404 problem response + one request.failed log
});
```

### Error UI

- `src/app/error.tsx` handles errors in any page under the root layout. It shows "Something went wrong", generic guidance in a single `role="alert"`, the **request reference** (the correlation ID), and a "Try again" button that calls `retry()`. The heading receives focus once.
- `src/app/global-error.tsx` handles root-layout failures. It renders its own document and shows the Next.js digest as an **error reference**, which maps to the correlation ID through `request.error` logs.
- Neither renders `error.message`, stacks, or other technical detail. No debug, throw, echo, or log-viewing route exists.

## 5. Authentication events (M1.1)

| Event code | Meaning (no emails, tokens, cookies, or messages are logged) |
|---|---|
| `auth.session_created` | A session was created (`recordRef` = session ID) |
| `auth.session_refused` | Session creation refused for a non-active or service account |
| `auth.principal_rejected` | A request's session did not resolve to a principal (`resultCode`) |
| `auth.account_create_refused` | Account creation refused for invalid type/status |
| `auth.library_event` | Better Auth emitted a log message (level only; message dropped) |
| `account.session_revoke`, `account.sessions_revoke_all`, `account.restricted` | Restriction primitives (`recordRef` = account ID, `resultCode`) |

Auth route errors use the same closed problem codes (plus `RATE_LIMITED`, 429). Library messages are never returned, and session tokens are stripped from JSON bodies.

## 6. Known limitations

- Page requests log `request.received` only. Next.js 16 does not expose page status or duration to the proxy, and the project does not wrap the framework server.
- On client-side navigation the root layout is not re-rendered, so the request reference shown by `error.tsx` is the one from the initial document request.
- Next.js itself still prints its own error output for server render errors to stderr. That framework output is outside this logger and must be handled by the log pipeline chosen at deployment.
