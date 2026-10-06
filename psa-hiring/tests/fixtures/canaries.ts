// Synthetic leakage canaries. Every value is unmistakably fake (TESTCANARY
// prefix, synthetic SSN range 900-xx-xxxx) and cannot work as a credential.
// Use findCanaryCategories() in assertions so a failing test reports only the
// category name, never the canary value itself.

const tag = (category: string) => `TESTCANARY-${category}-${"9f3c2a"}`;

export const canaries = {
  password: tag("password"),
  token: tag("token"),
  session: tag("session"),
  authorization: `Bearer ${tag("authorization")}`,
  cookie: `sid=${tag("cookie")}`,
  ssn: "900-11-0001",
  bank: tag("bank-account"),
  routing: tag("routing"),
  identity: tag("identity-document"),
  medical: tag("medical-tb"),
  screening: tag("screening-detail"),
  document: tag("document-content"),
  signedUrl: `https://storage.example.test/doc?sig=${tag("signed-url")}`,
  sql: `SELECT * FROM app.secret WHERE note = '${tag("sql")}'`,
  sqlBinding: tag("sql-binding"),
  provider: tag("provider-payload"),
  body: tag("request-body"),
  query: tag("query-string"),
  errorMessage: tag("error-message"),
  errorStack: tag("error-stack"),
  errorCause: tag("error-cause"),
} as const;

export type CanaryCategory = keyof typeof canaries;

/** Distinctive substrings searched for (the bare value or its unique tag). */
const needles: Record<CanaryCategory, string> = Object.fromEntries(
  Object.entries(canaries).map(([category, value]) => [
    category,
    value.match(/TESTCANARY-[a-z-]+-9f3c2a/)?.[0] ?? value,
  ]),
) as Record<CanaryCategory, string>;

/** Returns the categories whose canary occurs anywhere in `output`. */
export function findCanaryCategories(output: string): CanaryCategory[] {
  return (Object.keys(needles) as CanaryCategory[]).filter((category) =>
    output.includes(needles[category]),
  );
}

/** A request-like object carrying canaries in body, headers, cookies, query. */
export function buildCanaryRequestLike() {
  return {
    method: "POST",
    url: `https://app.example.test/candidate?q=${canaries.query}`,
    headers: {
      authorization: canaries.authorization,
      cookie: canaries.cookie,
      "x-session": canaries.session,
    },
    cookies: { sid: canaries.cookie },
    query: { q: canaries.query },
    body: {
      password: canaries.password,
      ssn: canaries.ssn,
      bankAccount: canaries.bank,
      answers: { medical: canaries.medical },
      note: canaries.body,
    },
  };
}

/** A nested object with every sensitive category under sensitive keys. */
export function buildCanarySensitiveObject() {
  return {
    password: canaries.password,
    auth: { token: canaries.token, session: canaries.session },
    headers: { authorization: canaries.authorization, cookie: canaries.cookie },
    candidate: {
      ssn: canaries.ssn,
      bankAccount: canaries.bank,
      routingNumber: canaries.routing,
      identityDocument: canaries.identity,
      medical: canaries.medical,
      screening: canaries.screening,
    },
    document: {
      documentContent: canaries.document,
      signedUrl: canaries.signedUrl,
    },
    db: { sql: canaries.sql, bindings: [canaries.sqlBinding] },
    provider: { providerPayload: { raw: canaries.provider } },
    body: canaries.body,
  };
}

/** An error whose message, stack, and cause all carry canaries. */
export function buildCanaryError(): Error {
  const error = new Error(canaries.errorMessage, {
    cause: new Error(canaries.errorCause),
  });
  error.stack = `Error: ${canaries.errorMessage}\n    at ${canaries.errorStack} (/srv/app/secret.ts:1:1)`;
  return error;
}

/** An in-memory log destination that keeps raw bytes for whole-output search. */
export function createMemoryDestination() {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
    },
    raw: () => chunks.join(""),
    records: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
