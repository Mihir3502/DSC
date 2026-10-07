import { z } from "zod";
import type { AuthenticationMethod } from "../domain/authentication-assurance";
import {
  describeDevice,
  maskEmail,
} from "../domain/candidate-registration-policy";
import {
  defineProjection,
  projectAll,
  type ProjectionResult,
} from "./authorized-projector";
import type { FieldPolicyContext, FieldRule } from "./field-policy";

// Current M1 account-security response contracts (packet M1.5 §12.4,
// ADR-0011). Candidate and staff representations are different contracts
// bound to their audience and the SECURITY purpose. Each is projected
// field by field from a minimal server-side source and validated against
// an exact schema. They carry display data only: a masked email, status
// values, and masked session summaries (an HMAC-derived opaque reference
// and a coarse device label). Raw session IDs, tokens, user agents, IPs,
// account IDs, TOTP secrets, and backup codes have no field here at all.

/** Minimal server-side source rows (never ORM/auth-library objects). */
export type SessionSource = Readonly<{
  /** Opaque, owner-bound HMAC reference computed on the server. */
  ref: string;
  current: boolean;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}>;

export type CandidateSecuritySource = Readonly<{
  email: string | null;
  emailVerified: boolean;
  sessions: readonly SessionSource[];
}>;

export type StaffSecuritySource = Readonly<{
  email: string | null;
  signedInWith: AuthenticationMethod | null;
  recent: boolean;
  strong: boolean;
  recentAt: Date | null;
  windowSeconds: number;
  sessions: readonly SessionSource[];
}>;

// Own-account display data: no permission upgrades these fields; the
// self-service policy decision is the resource-level gate.
const opaque: FieldRule = { sensitivity: "INTERNAL", otherwise: "INCLUDE" };
const ownStatus: FieldRule = {
  sensitivity: "INTERNAL",
  otherwise: "STATUS_ONLY",
};
const ownMasked: FieldRule = {
  sensitivity: "CONFIDENTIAL_PERSONNEL",
  otherwise: "MASK",
};

const sessionSchema = z.strictObject({
  ref: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  current: z.boolean(),
  deviceLabel: z.string().max(64),
  createdAt: z.date(),
  lastActiveAt: z.date(),
  expiresAt: z.date(),
});
export type SessionSummaryView = z.infer<typeof sessionSchema>;

function sessionContract(audience: "CANDIDATE" | "STAFF", name: string) {
  return defineProjection<SessionSource, SessionSummaryView>({
    name,
    audience,
    purpose: "SECURITY",
    fields: {
      ref: { rule: opaque, value: (s) => s.ref },
      current: { rule: opaque, value: (s) => s.current },
      // A coarse browser/OS family only; never the user-agent string.
      deviceLabel: {
        rule: ownMasked,
        mask: (s) => describeDevice(s.userAgent),
      },
      createdAt: { rule: opaque, value: (s) => s.createdAt },
      lastActiveAt: { rule: opaque, value: (s) => s.updatedAt },
      expiresAt: { rule: opaque, value: (s) => s.expiresAt },
    },
    schema: sessionSchema,
  });
}

const candidateSession = sessionContract(
  "CANDIDATE",
  "candidate.session_summary.v1",
);
const staffSession = sessionContract("STAFF", "staff.session_summary.v1");

function sessionsOf(
  contract: typeof candidateSession,
  sources: readonly SessionSource[],
  context: FieldPolicyContext,
): SessionSummaryView[] {
  const result = projectAll(contract, sources, context);
  // A refused row refuses the parent (its schema then rejects the value).
  return result.kind === "PROJECTED" ? result.value : (null as never);
}

const maskedEmail = (email: string | null) =>
  email ? maskEmail(email) : "•••";

const candidateSecuritySchema = z.strictObject({
  maskedEmail: z.string().max(330),
  emailVerified: z.boolean(),
  sessions: z.array(sessionSchema).max(100),
});
export type CandidateSecurityView = z.infer<typeof candidateSecuritySchema>;

export const candidateSecurityContract = defineProjection<
  CandidateSecuritySource,
  CandidateSecurityView
>({
  name: "candidate.account_security.v1",
  audience: "CANDIDATE",
  purpose: "SECURITY",
  fields: {
    maskedEmail: { rule: ownMasked, mask: (s) => maskedEmail(s.email) },
    emailVerified: { rule: ownStatus, status: (s) => s.emailVerified },
    sessions: {
      rule: opaque,
      value: (s) =>
        sessionsOf(candidateSession, s.sessions, {
          audience: "CANDIDATE",
          purpose: "SECURITY",
          allowed: new Set(),
        }),
    },
  },
  schema: candidateSecuritySchema,
});

const methods = ["PASSWORD", "PASSWORD_TOTP", "PASSWORD_BACKUP_CODE"] as const;

const staffSecuritySchema = z.strictObject({
  maskedEmail: z.string().max(330),
  mfaMethod: z.literal("TOTP"),
  signedInWith: z.enum(methods).nullable(),
  recentAuthentication: z.strictObject({
    recent: z.boolean(),
    strong: z.boolean(),
    at: z.date().nullable(),
    windowSeconds: z.number().int().positive(),
  }),
  sessions: z.array(sessionSchema).max(100),
});
export type StaffSecurityView = z.infer<typeof staffSecuritySchema>;

export const staffSecurityContract = defineProjection<
  StaffSecuritySource,
  StaffSecurityView
>({
  name: "staff.account_security.v1",
  audience: "STAFF",
  purpose: "SECURITY",
  fields: {
    maskedEmail: { rule: ownMasked, mask: (s) => maskedEmail(s.email) },
    // TOTP is mandatory for staff; the seed itself has no field anywhere.
    mfaMethod: { rule: ownStatus, status: () => "TOTP" as const },
    signedInWith: { rule: ownStatus, status: (s) => s.signedInWith },
    recentAuthentication: {
      rule: ownStatus,
      status: (s) => ({
        recent: s.recent,
        strong: s.strong,
        at: s.recent ? s.recentAt : null,
        windowSeconds: s.windowSeconds,
      }),
    },
    sessions: {
      rule: opaque,
      value: (s) =>
        sessionsOf(staffSession, s.sessions, {
          audience: "STAFF",
          purpose: "SECURITY",
          allowed: new Set(),
        }),
    },
  },
  schema: staffSecuritySchema,
});

/** Reviewed contract names, cross-checked by the route manifest test. */
export const securityProjectionNames = Object.freeze([
  candidateSecurityContract.name,
  staffSecurityContract.name,
]);

export type SecurityProjection<O> = ProjectionResult<O>;
