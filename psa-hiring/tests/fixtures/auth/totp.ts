import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";

// Test-only authenticator (packet M1.3 §17.8): computes codes with the same
// maintained OTP library Better Auth verifies with, from the manual key the
// enrollment screen shows. No TOTP is implemented here. Secrets and codes
// are synthetic, live only in memory, and are never logged or committed.

const PERIOD_MS = 30_000;

/** The raw shared secret encoded by a manual-entry key ("ABCD EFGH …"). */
export function secretFromManualKey(manualKey: string): string {
  const bytes = base32.decode(manualKey.replace(/\s+/g, "").toUpperCase());
  return new TextDecoder().decode(bytes);
}

/**
 * The code for the time step `stepOffset` away from `now`. Better Auth
 * accepts the current step and one step either side, so offsets -1, 0, and
 * 1 give three distinct valid codes without waiting (the app's replay guard
 * rejects any code presented twice).
 */
export async function totpCode(
  secret: string,
  stepOffset = 0,
  now = Date.now(),
): Promise<string> {
  const counter = Math.floor(now / PERIOD_MS) + stepOffset;
  return createOTP(secret).hotp(counter);
}

/** A code that is wrong for this secret at any nearby step. */
export async function wrongTotpCode(secret: string, now = Date.now()) {
  const valid = new Set(
    await Promise.all([-1, 0, 1].map((o) => totpCode(secret, o, now))),
  );
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
}

/** `count` distinct codes, none valid for this secret at a nearby step. */
export async function wrongTotpCodes(
  secret: string,
  count: number,
  now = Date.now(),
): Promise<string[]> {
  const valid = new Set(
    await Promise.all([-1, 0, 1].map((o) => totpCode(secret, o, now))),
  );
  const codes: string[] = [];
  for (let n = 0; codes.length < count; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) codes.push(candidate);
  }
  return codes;
}
