// Central redaction rules applied by the Pino adapter before serialization.
// This is defense in depth behind the field allowlist (log-context.ts): it
// does not permit callers to pass broad objects to the logger.

/** The single constant replacement for any redacted value. */
export const REDACT_MARKER = "[REDACTED]";

/** Sensitive key names (exact, lowercase/camelCase/snake_case variants). */
export const sensitiveKeys = [
  // credentials and sessions
  "password",
  "passcode",
  "passwd",
  "credential",
  "credentials",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "api_key",
  "cookie",
  "cookies",
  "set-cookie",
  "session",
  "sessionId",
  "authorization",
  "auth",
  "mfa",
  "mfaCode",
  "otp",
  "totp",
  // identity and financial
  "ssn",
  "tin",
  "taxId",
  "bankAccount",
  "accountNumber",
  "routingNumber",
  "iban",
  "card",
  "cardNumber",
  "payment",
  "identityDocument",
  "documentNumber",
  "passportNumber",
  "driversLicense",
  "dob",
  "dateOfBirth",
  "birthDate",
  "address",
  "homeAddress",
  // application, medical, and screening content
  "answers",
  "applicationAnswers",
  "medical",
  "tb",
  "tbResult",
  "drugScreen",
  "backgroundReport",
  "screening",
  "screeningDetail",
  "diagnosis",
  // documents, URLs, crypto, SQL, providers, raw HTTP
  "documentContent",
  "content",
  "signedUrl",
  "url",
  "encryptionKey",
  "privateKey",
  "sql",
  "bindings",
  "params",
  "providerPayload",
  "payload",
  "headers",
  "body",
  "query",
] as const;

/**
 * Pino `redact.paths`: each sensitive key at the top level and at nested
 * depths (fast-redact wildcard syntax).
 */
export const redactionPaths: string[] = sensitiveKeys.flatMap((key) => {
  const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const join = (prefix: string) =>
    segment.startsWith("[") ? `${prefix}${segment}` : `${prefix}.${segment}`;
  return [segment, join("*"), join("*.*"), join("*.*.*")];
});
