import { createHash } from "node:crypto";

// Per-process fixed-window limiter for candidate (packet M1.2 §11.1, §12.1,
// AC-M1.2-11) and staff (M1.3) authentication actions. Better Auth's own limiter guards
// only HTTP routes, and these flows run as server actions, so the
// application limits them here. Keys are SHA-256 digests: no email or
// client address is kept in memory in clear text, and nothing is logged.
// Production-like startup is already refused until a distributed store is
// approved (ADR-0002).

export type RateLimitPolicy = Readonly<{ limit: number; windowMs: number }>;

export const candidateRateLimits = Object.freeze({
  register: { limit: 10, windowMs: 60 * 60_000 },
  signInPerClientEmail: { limit: 10, windowMs: 15 * 60_000 },
  signInPerClient: { limit: 50, windowMs: 15 * 60_000 },
  verifyPerClientEmail: { limit: 10, windowMs: 15 * 60_000 },
  /** Silent caps: the response stays generic, only sending stops. */
  verificationSendPerEmail: { limit: 5, windowMs: 60 * 60_000 },
  recoverySendPerEmail: { limit: 5, windowMs: 60 * 60_000 },
  sendPerClient: { limit: 20, windowMs: 60 * 60_000 },
  resetPerClient: { limit: 20, windowMs: 15 * 60_000 },
  changePasswordPerAccount: { limit: 10, windowMs: 15 * 60_000 },
  // M1.3 staff authentication (ADR-0004). The MFA challenge itself is also
  // bounded per challenge and per account by Better Auth's lockout.
  staffSignInPerClient: { limit: 50, windowMs: 15 * 60_000 },
  staffSignInPerClientEmail: { limit: 10, windowMs: 15 * 60_000 },
  staffMfaPerClient: { limit: 30, windowMs: 15 * 60_000 },
  staffActivatePerClient: { limit: 20, windowMs: 15 * 60_000 },
  staffEnrollPerAccount: { limit: 10, windowMs: 15 * 60_000 },
  /** Reauth has no library lockout (session path); this is its lockout. */
  staffReauthPerAccount: { limit: 5, windowMs: 15 * 60_000 },
  staffChangePasswordPerAccount: { limit: 10, windowMs: 15 * 60_000 },
  staffRecoveryPerClient: { limit: 10, windowMs: 60 * 60_000 },
  /** Silent cap: the public response stays generic. */
  staffRecoveryPerEmail: { limit: 3, windowMs: 24 * 60 * 60_000 },
} satisfies Record<string, RateLimitPolicy>);

export type RateLimitBucket = keyof typeof candidateRateLimits;

export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 50_000,
  ) {}

  /** Records one attempt; returns false when the bucket is exhausted. */
  consume(bucket: RateLimitBucket, ...keyParts: string[]): boolean {
    const policy = candidateRateLimits[bucket];
    const key = createHash("sha256")
      .update(`${bucket}\u0000${keyParts.join("\u0000")}`)
      .digest("base64url");
    const now = this.now();
    const current = this.#windows.get(key);
    if (!current || now - current.start >= policy.windowMs) {
      if (this.#windows.size >= this.maxEntries) this.#prune(now);
      this.#windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= policy.limit;
  }

  #prune(now: number) {
    const longest = Math.max(
      ...Object.values(candidateRateLimits).map((p) => p.windowMs),
    );
    for (const [key, window] of this.#windows) {
      if (now - window.start >= longest) this.#windows.delete(key);
    }
    // Still full: drop the oldest entries rather than grow without bound.
    for (const key of this.#windows.keys()) {
      if (this.#windows.size < this.maxEntries) break;
      this.#windows.delete(key);
    }
  }
}

/**
 * Coarse client key for rate limiting only. Uses the first forwarded hop
 * when a proxy supplies one, otherwise a constant. Never logged or stored.
 */
export function clientKeyFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && forwarded.length <= 64 ? forwarded : "direct";
}
