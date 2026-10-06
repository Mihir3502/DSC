import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";

// Converts Better Auth Set-Cookie values into name/value/options writes for
// the Next.js cookie store used by server actions. Values are the opaque
// session cookie; they are never logged or returned to browser JavaScript
// (the cookie stays HttpOnly).

export type CookieWrite = Readonly<{
  name: string;
  value: string;
  options: ReturnType<typeof toCookieOptions>;
}>;

export function toCookieWrites(setCookies: readonly string[]): CookieWrite[] {
  const writes: CookieWrite[] = [];
  for (const header of setCookies) {
    for (const [name, attributes] of parseSetCookieHeader(header)) {
      if (!name) continue;
      writes.push({
        name,
        value: attributes.value,
        options: toCookieOptions(attributes),
      });
    }
  }
  return writes;
}
