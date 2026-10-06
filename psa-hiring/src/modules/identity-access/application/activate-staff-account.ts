import "server-only";
import { encode } from "uqr";
import type { PasswordProblem } from "../domain/candidate-registration-policy";
import { maskEmail } from "../domain/candidate-registration-policy";
import {
  decideActivation,
  decideInvitationTransition,
  isLiveInvitation,
} from "../domain/staff-invitation";
import {
  activateEnrolledStaff,
  createInvitedStaffWithCredential,
  deleteAllSessions,
  findAccountByEmail,
  findAccountById,
  lockAccountForUpdate,
  replaceInvitedStaffCredential,
} from "../infrastructure/account-repository";
import {
  claimTotpCode,
  readEnrollment,
  readSessionTimes,
  removeTwoFactorEnrollment,
} from "../infrastructure/better-auth-mfa-adapter";
import { TOTP_ISSUER } from "../infrastructure/auth-options";
import { clientKeyFrom } from "../infrastructure/action-rate-limiter";
import { withSessionIssuance } from "../infrastructure/session-issuance";
import {
  bindInvitationAccount,
  digestInvitationToken,
  findInvitationByDigest,
  findInvitationById,
  findPendingInvitationForAccount,
  isInvitationTokenShape,
  transitionInvitation,
} from "../infrastructure/staff-invitation-repository";
import {
  commandLogger,
  equalizePasswordWork,
  formString,
  newPasswordProblems,
  setCookiesOf,
} from "./candidate-auth-support";
import {
  clearTransientStaffSessions,
  defaultStaffDependencies,
  normalizeTotpCode,
  sessionCookiePair,
  staffAuthHeaders,
  type StaffAuthDependencies,
} from "./staff-auth-support";

// Invitation-bound staff activation (packet M1.3 §9, AC-M1.3-01/04/06/07).
//
//   1. beginStaffActivation   — exchange the invitation capability, create
//      or resume the single INVITED STAFF account (email verified by the
//      invitation proof), set the password, open an enrollment-only session
//      (STAFF_ACTIVATION purpose; never a staff principal), and start TOTP
//      enrollment through Better Auth.
//   2. verifyStaffEnrollment  — verify the first TOTP code (Better Auth),
//      then generate backup codes (Better Auth) to show once.
//   3. completeStaffActivation — after the user confirms the codes were
//      saved: INVITED → ACTIVE, invitation ACCEPTED, enrollment session
//      replaced by a new MFA-complete staff session.
//
// Abandoning at any step leaves the account INVITED and unable to resolve
// a staff principal. The TOTP secret and backup codes are returned only to
// the step that displays them and are never logged or stored by the app.

export type StaffEnrollment = Readonly<{
  /** SVG path data for the QR code (rendered locally; no QR service). */
  qrPath: string;
  qrSize: number;
  /** The base32 secret in groups of four, for manual entry. */
  manualKey: string;
  issuer: string;
  accountLabel: string;
}>;

export type BeginActivationResult =
  | Readonly<{
      kind: "ENROLLMENT_STARTED";
      enrollment: StaffEnrollment;
      setCookies: readonly string[];
    }>
  | Readonly<{ kind: "INVALID_INPUT"; password: readonly PasswordProblem[] }>
  /** Unknown, expired, revoked, superseded, accepted, or ineligible. */
  | Readonly<{ kind: "INVITATION_INVALID" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

function enrollmentFrom(
  totpURI: string,
  email: string,
): StaffEnrollment | null {
  let secret: string | null;
  try {
    secret = new URL(totpURI).searchParams.get("secret");
  } catch {
    return null;
  }
  if (!secret || !/^[A-Z2-7]+=*$/.test(secret)) return null;
  const qr = encode(totpURI, { ecc: "M", border: 2 });
  const path: string[] = [];
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path.push(`M${x} ${y}h1v1h-1z`);
    }),
  );
  return Object.freeze({
    qrPath: path.join(""),
    qrSize: qr.size,
    manualKey: secret
      .replace(/=+$/, "")
      .match(/.{1,4}/g)!
      .join(" "),
    issuer: TOTP_ISSUER,
    accountLabel: maskEmail(email),
  });
}

export async function beginStaffActivation(
  input: Readonly<{
    token: unknown;
    password: unknown;
    passwordConfirmation: unknown;
  }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<BeginActivationResult> {
  const log = commandLogger(deps);
  if (!deps.limiter.consume("staffActivatePerClient", clientKeyFrom(headers))) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  const invalid = (category: "invalid_link" | "not_eligible" | "expired") => {
    deps.events.record({ code: "staff.activation_failed", category });
    return { kind: "INVITATION_INVALID" } as const;
  };
  if (!isInvitationTokenShape(input.token)) return invalid("invalid_link");
  // Validate the password first so a rejected password never consumes or
  // changes anything.
  const problems = await newPasswordProblems(
    deps,
    input.password,
    input.passwordConfirmation,
  );
  if (problems.length > 0) return { kind: "INVALID_INPUT", password: problems };
  const password = input.password as string;

  const now = new Date();
  const found = await findInvitationByDigest(
    deps.db,
    digestInvitationToken(input.token),
  );
  if (!found) {
    await equalizePasswordWork(deps, password);
    return invalid("invalid_link");
  }
  if (found.status === "PENDING" && !isLiveInvitation(found, now)) {
    await deps.db.transaction((tx) =>
      transitionInvitation(tx, found, "EXPIRED", now),
    );
    deps.events.record({
      code: "staff.invitation_expired",
      recordRef: found.id,
    });
    await equalizePasswordWork(deps, password);
    return invalid("expired");
  }
  if (!isLiveInvitation(found, now)) {
    await equalizePasswordWork(deps, password);
    return invalid("invalid_link");
  }

  const passwordHash = await (await deps.auth.$context).password.hash(password);
  const accountId = await deps.db.transaction(async (tx) => {
    const invitation = await findInvitationById(tx, found.id, true);
    if (!invitation || !isLiveInvitation(invitation, now)) return null;
    const existing = await findAccountByEmail(tx, invitation.email);
    const decision = decideActivation(invitation, existing);
    if (decision.kind === "NOT_ELIGIBLE") return null;

    let id: string | null;
    if (decision.kind === "CREATE") {
      id = await createInvitedStaffWithCredential(
        tx,
        {
          email: invitation.email,
          emailDisplay: invitation.emailDisplay,
          passwordHash,
        },
        now,
      );
    } else {
      const locked = await lockAccountForUpdate(tx, decision.accountId);
      if (locked?.accountType !== "STAFF" || locked.status !== "INVITED") {
        return null;
      }
      id = decision.accountId;
      await replaceInvitedStaffCredential(tx, id, passwordHash, now);
      // Restart enrollment: any earlier secret/codes or enrollment session
      // (another browser, an abandoned attempt) stops working.
      await removeTwoFactorEnrollment(tx, id);
      await deleteAllSessions(tx, id);
    }
    if (!id) return null;
    if (
      invitation.accountId === null &&
      !(await bindInvitationAccount(tx, invitation, id, now))
    ) {
      throw new Error("invitation changed concurrently");
    }
    return id;
  });
  if (!accountId) return invalid("not_eligible");

  const email = found.email;

  const issuance = {
    kind: "STAFF_ACTIVATION",
    accountId,
    primaryAuthenticatedAt: now,
  } as const;
  // A concurrent activation of the same invitation may replace this
  // enrollment at any point; the unique enrollment row and the conditional
  // activation update make the loser fail closed with the generic outcome.
  let signInCookies: string[] = [];
  let enableCookies: string[] = [];
  let enrollment: StaffEnrollment | null = null;
  let sessionPair: string | undefined;
  try {
    const signIn = await withSessionIssuance(issuance, () =>
      deps.auth.api.signInEmail({
        body: { email, password, rememberMe: false },
        headers: staffAuthHeaders(deps, headers),
        asResponse: true,
      }),
    );
    signInCookies = signIn.ok ? setCookiesOf(signIn) : [];
    sessionPair = sessionCookiePair(deps, signInCookies);
    if (sessionPair) {
      const enable = await withSessionIssuance(issuance, () =>
        deps.auth.api.enableTwoFactor({
          // Server-fixed method and issuer; the client chooses neither.
          body: { password, method: "totp" },
          headers: staffAuthHeaders(deps, headers, sessionPair),
          asResponse: true,
        }),
      );
      const body = enable.ok
        ? ((await enable.json()) as { totpURI?: unknown })
        : null;
      enableCookies = setCookiesOf(enable);
      enrollment =
        typeof body?.totpURI === "string"
          ? enrollmentFrom(body.totpURI, email)
          : null;
    }
  } catch {
    enrollment = null;
  }
  if (!enrollment) {
    // End only this attempt's enrollment session: a concurrent attempt of
    // the same invitation may legitimately still be in progress.
    if (sessionPair) {
      await deps.auth.api
        .signOut({
          headers: staffAuthHeaders(deps, headers, sessionPair),
          asResponse: true,
        })
        .catch(() => null);
    }
    log.warn("staff.activation_enrollment_failed", {
      resultCode: "enrollment_not_started",
    });
    return invalid("not_eligible");
  }
  deps.events.record({
    code: "staff.activation_started",
    accountRef: accountId,
    recordRef: found.id,
  });
  return {
    kind: "ENROLLMENT_STARTED",
    enrollment,
    setCookies: [...signInCookies, ...enableCookies],
  };
}

type ActivationContext = Readonly<{
  accountId: string;
  sessionId: string;
  invitationId: string;
  primaryAuthenticatedAt: Date;
  mfaAuthenticatedAt: Date | null;
}>;

/**
 * Resolves the current enrollment-only session: an INVITED STAFF account,
 * a STAFF_ACTIVATION session, and a still-live invitation bound to it
 * (revocation, resend, or expiry ends activation immediately).
 */
async function resolveActivationContext(
  headers: Headers,
  deps: StaffAuthDependencies,
): Promise<ActivationContext | null> {
  let current: Awaited<ReturnType<typeof deps.auth.api.getSession>>;
  try {
    current = await deps.auth.api.getSession({
      headers: staffAuthHeaders(deps, headers),
      query: { disableRefresh: true },
    });
  } catch {
    return null;
  }
  if (!current) return null;
  const account = await findAccountById(deps.db, current.user.id);
  if (account?.accountType !== "STAFF" || account.status !== "INVITED") {
    return null;
  }
  const times = await readSessionTimes(deps.db, account.id, current.session.id);
  if (times?.purpose !== "STAFF_ACTIVATION" || !times.primaryAuthenticatedAt) {
    return null;
  }
  const invitation = await findPendingInvitationForAccount(deps.db, account.id);
  if (!invitation || !isLiveInvitation(invitation, new Date())) return null;
  return Object.freeze({
    accountId: account.id,
    sessionId: current.session.id,
    invitationId: invitation.id,
    primaryAuthenticatedAt: times.primaryAuthenticatedAt,
    mfaAuthenticatedAt: times.mfaAuthenticatedAt,
  });
}

export type VerifyEnrollmentResult =
  | Readonly<{
      kind: "BACKUP_CODES";
      /** Shown once; never stored or logged by the application. */
      backupCodes: readonly string[];
      setCookies: readonly string[];
    }>
  | Readonly<{ kind: "INVALID_CODE" }>
  | Readonly<{ kind: "PASSWORD_INVALID" }>
  | Readonly<{ kind: "ACTIVATION_EXPIRED" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

export async function verifyStaffEnrollment(
  input: Readonly<{ code: unknown; password: unknown }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<VerifyEnrollmentResult> {
  const context = await resolveActivationContext(headers, deps);
  if (!context) return { kind: "ACTIVATION_EXPIRED" };
  if (!deps.limiter.consume("staffEnrollPerAccount", context.accountId)) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  const password = formString(input.password, 4096);
  if (!password) return { kind: "PASSWORD_INVALID" };
  const confirm = await deps.auth.api.verifyPassword({
    body: { password },
    headers: staffAuthHeaders(deps, headers),
    asResponse: true,
  });
  if (!confirm.ok) {
    deps.events.record({
      code: "staff.activation_failed",
      category: "invalid_credentials",
      accountRef: context.accountId,
    });
    return { kind: "PASSWORD_INVALID" };
  }

  const code = normalizeTotpCode(input.code);
  if (
    !code ||
    !(await claimTotpCode(
      deps.db,
      deps.env.BETTER_AUTH_SECRET,
      context.accountId,
      code,
    ))
  ) {
    deps.events.record({
      code: "staff.activation_failed",
      category: code ? "replayed" : "invalid_code",
      accountRef: context.accountId,
    });
    return { kind: "INVALID_CODE" };
  }
  const verified = await withSessionIssuance(
    {
      kind: "STAFF_ACTIVATION",
      accountId: context.accountId,
      primaryAuthenticatedAt: context.primaryAuthenticatedAt,
      mfaAuthenticatedAt: new Date(),
    },
    () =>
      deps.auth.api.verifyTOTP({
        body: { code },
        headers: staffAuthHeaders(deps, headers),
        asResponse: true,
      }),
  );
  if (!verified.ok) {
    deps.events.record({
      code: "staff.activation_failed",
      category: "invalid_code",
      accountRef: context.accountId,
    });
    return { kind: "INVALID_CODE" };
  }
  // Verification rotated the enrollment session; continue with the new one.
  const verifyCookies = setCookiesOf(verified);
  const rotated = sessionCookiePair(deps, verifyCookies);
  const generated = await deps.auth.api.generateBackupCodes({
    body: { password },
    headers: staffAuthHeaders(deps, headers, rotated),
    asResponse: true,
  });
  const body = generated.ok
    ? ((await generated.json()) as { backupCodes?: unknown })
    : null;
  const codes = Array.isArray(body?.backupCodes)
    ? body.backupCodes.filter((c): c is string => typeof c === "string")
    : [];
  if (codes.length === 0) return { kind: "ACTIVATION_EXPIRED" };
  deps.events.record({
    code: "staff.mfa_enrolled",
    accountRef: context.accountId,
  });
  return {
    kind: "BACKUP_CODES",
    backupCodes: Object.freeze(codes),
    setCookies: verifyCookies,
  };
}

export type CompleteActivationResult =
  | Readonly<{
      kind: "ACTIVATED";
      destination: "/staff/security";
      setCookies: readonly string[];
    }>
  /** Activated, but a new session could not be issued: sign in normally. */
  | Readonly<{ kind: "ACTIVATED_SIGN_IN_REQUIRED" }>
  | Readonly<{ kind: "CONFIRMATION_REQUIRED" }>
  | Readonly<{ kind: "ACTIVATION_EXPIRED" }>;

export async function completeStaffActivation(
  input: Readonly<{ savedConfirmation: unknown }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<CompleteActivationResult> {
  if (input.savedConfirmation !== "saved") {
    return { kind: "CONFIRMATION_REQUIRED" };
  }
  const context = await resolveActivationContext(headers, deps);
  if (!context?.mfaAuthenticatedAt) return { kind: "ACTIVATION_EXPIRED" };
  const enrollment = await readEnrollment(deps.db, context.accountId);
  if (!enrollment.verified) return { kind: "ACTIVATION_EXPIRED" };

  const now = new Date();
  const activated = await deps.db.transaction(async (tx) => {
    const invitation = await findInvitationById(tx, context.invitationId, true);
    if (!invitation) return false;
    if (
      decideInvitationTransition(invitation, "ACCEPT", now).kind !== "apply"
    ) {
      return false;
    }
    await lockAccountForUpdate(tx, context.accountId);
    if (!(await activateEnrolledStaff(tx, context.accountId, now)))
      return false;
    if (
      !(await transitionInvitation(tx, invitation, "ACCEPTED", now, {
        accountId: context.accountId,
      }))
    ) {
      throw new Error("invitation changed concurrently");
    }
    return true;
  });
  if (!activated) {
    deps.events.record({
      code: "staff.activation_failed",
      category: "not_eligible",
      accountRef: context.accountId,
    });
    return { kind: "ACTIVATION_EXPIRED" };
  }
  deps.events.record({
    code: "staff.invitation_accepted",
    accountRef: context.accountId,
    recordRef: context.invitationId,
  });
  deps.events.record({
    code: "staff.activation_completed",
    accountRef: context.accountId,
  });

  // Replace the enrollment session with a new MFA-complete staff session.
  const rotated = await withSessionIssuance(
    {
      kind: "STAFF_MFA",
      accountId: context.accountId,
      method: "PASSWORD_TOTP",
      primaryAuthenticatedAt: context.primaryAuthenticatedAt,
      mfaAuthenticatedAt: context.mfaAuthenticatedAt,
    },
    () =>
      deps.auth.api
        .rotateStaffSession({
          headers: staffAuthHeaders(deps, headers),
          asResponse: true,
        })
        .catch(() => null),
  );
  await clearTransientStaffSessions(deps, context.accountId);
  if (!rotated?.ok) return { kind: "ACTIVATED_SIGN_IN_REQUIRED" };
  return {
    kind: "ACTIVATED",
    destination: "/staff/security",
    setCookies: setCookiesOf(rotated),
  };
}
