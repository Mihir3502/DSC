// Compromised-password port (packet M1.2 §7). No external provider is
// approved, so the only adapter is a deterministic local denylist of
// synthetic, well-known weak passphrases. It never sends a password
// anywhere. Production-like startup fails closed in auth-env until a
// privacy-preserving provider is approved (ADR-0003 open decision).

export interface CompromisedPasswordPort {
  readonly kind: "local-denylist";
  isCompromised(password: string): Promise<boolean>;
}

/**
 * Synthetic local fixture: common weak passphrases that satisfy the length
 * rule, plus one clearly-marked test value. Exact match, no transformation.
 */
export const localPasswordDenylist: readonly string[] = Object.freeze([
  "password1234",
  "password12345",
  "passwordpassword",
  "123456789012",
  "1234567890123",
  "qwertyuiop12",
  "qwerty123456",
  "iloveyou1234",
  "letmein12345",
  "welcome12345",
  "changeme1234",
  "administrator",
  "TEST compromised passphrase 0001",
]);

export class LocalDenylistCompromisedPassword implements CompromisedPasswordPort {
  readonly kind = "local-denylist" as const;
  readonly #entries: ReadonlySet<string>;

  constructor(entries: readonly string[] = localPasswordDenylist) {
    this.#entries = new Set(entries);
  }

  async isCompromised(password: string): Promise<boolean> {
    return this.#entries.has(password);
  }
}
