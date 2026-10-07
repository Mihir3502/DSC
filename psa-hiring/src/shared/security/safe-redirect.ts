// Reviewed redirect destinations (packet M1.5 §17.2, ADR-0011). Pure and
// framework-neutral.
//
// Every server redirect goes to a destination that is an exact member of
// this registry. Browsers never submit a URL: at most a closed key (such as
// a continuation key or reauthentication purpose) that server code resolves
// to one of these strings. Anything else (absolute, scheme-relative,
// encoded, nested, backslash, control-character, dot-segment, or simply
// unknown) resolves to the safe default. Registered destinations carry no
// token, email, identifier, permission, scope, or denial reason.

/** Strict same-origin relative URL shape for registry entries. */
const strictPathPattern =
  /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?(?:\?[a-z]+=[A-Za-z0-9_-]+)?(?:#[a-z-]+)?$/;

/** Structural check used for every registry entry (and in tests). */
export function isStrictRelativeDestination(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    strictPathPattern.test(value) &&
    !value
      .split(/[?#]/)[0]
      .split("/")
      .some((s) => s === "." || s === "..")
  );
}

const withNotices = (path: string, notices: readonly string[]) => [
  path,
  ...notices.map((n) => `${path}?notice=${n}`),
];

export const SAFE_DEFAULT_DESTINATION = "/";

/** The complete reviewed set of redirect targets. */
export const registeredDestinations: readonly string[] = Object.freeze([
  SAFE_DEFAULT_DESTINATION,
  // Candidate authentication and self-service.
  "/sign-in",
  ...withNotices("/candidate/security", [
    "revoked",
    "others-revoked",
    "not-found",
  ]),
  // Staff authentication and self-service.
  ...withNotices("/staff/sign-in", [
    "password-changed",
    "signed-out",
    "activated",
    "expired",
  ]),
  "/staff/mfa",
  ...withNotices("/staff/security", ["revoked", "others-revoked", "not-found"]),
  "/staff/security#password",
  "/staff/reauthenticate?purpose=CHANGE_PASSWORD",
]);

const registered = new Set(registeredDestinations);

for (const destination of registeredDestinations) {
  if (!isStrictRelativeDestination(destination)) {
    throw new Error("an unsafe redirect destination is registered");
  }
}

export function isRegisteredDestination(value: unknown): value is string {
  return typeof value === "string" && registered.has(value);
}

/**
 * The redirect target for a server-computed destination: the value itself
 * when it is exactly registered, otherwise the given registered fallback
 * (or the site root).
 */
export function safeDestination(
  value: unknown,
  fallback: string = SAFE_DEFAULT_DESTINATION,
): string {
  if (isRegisteredDestination(value)) return value;
  return isRegisteredDestination(fallback)
    ? fallback
    : SAFE_DEFAULT_DESTINATION;
}
