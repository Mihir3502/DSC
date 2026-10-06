// Minimal deterministic synthetic fixtures for the M0 foundation. Every value
// is obviously fake: reserved domains (RFC 2606/6761), loopback hosts, and
// TEST-prefixed labels. Builders return fresh objects and accept narrow
// overrides. Domain builders (candidates, screening, ...) arrive with their
// modules; do not add speculative ones here.

/** Synthetic runtime configuration input, as `process.env` would supply it. */
export function buildServerEnvInput(
  overrides: Partial<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    APP_ENV: "local",
    DATABASE_URL:
      "postgresql://psa_app:TEST_app_password_not_secret@127.0.0.1:5432/psa_test_fixture",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1025",
    SMTP_FROM: "test-sender@example.test",
    DOCUMENT_STORAGE_ROOT: "./.local/documents",
    PROVIDER_MODE: "fake",
    ...overrides,
  };
}

/** A production-shaped (but synthetic) configuration that validation accepts. */
export function buildProductionEnvInput(
  overrides: Partial<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return buildServerEnvInput({
    APP_ENV: "production",
    DATABASE_URL: "postgresql://psa_app@db.internal.example.com:5432/psa",
    SMTP_HOST: "smtp.internal.example.com",
    SMTP_PORT: "587",
    SMTP_FROM: "no-reply@agency.example.com",
    DOCUMENT_STORAGE_ROOT: "/srv/psa/documents",
    PROVIDER_MODE: "production",
    ...overrides,
  });
}

export type SystemMetadataFixture = {
  key: string;
  value: Record<string, unknown>;
};

/** A non-secret technical metadata row with a deterministic TEST key. */
export function buildSystemMetadataRecord(
  overrides: Partial<SystemMetadataFixture> = {},
  sequence = 1,
): SystemMetadataFixture {
  return {
    key: `test.fixture.${sequence}`,
    value: { label: `TEST metadata ${sequence}`, synthetic: true },
    ...overrides,
  };
}
