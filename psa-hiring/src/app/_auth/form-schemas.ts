import "server-only";
import { defineFormSchema } from "@/shared/validation/form-input";

// Reviewed exact input schemas for every current Server Action (packet
// M1.5 §13). Field names match the rendered forms exactly; any other
// field rejects the submission (see shared/validation/form-input.ts).
// Bounds are generous upper limits; each command still applies its own
// domain validation (password policy, code format, email syntax).

const email = { maxLength: 320 };
const password = { maxLength: 4096 };
const code = { maxLength: 64 };
const capability = { maxLength: 2048 };
const key = { maxLength: 64 };
// M2.1 configuration (packet M2.1 §15, §23): references and versions are
// re-validated by each command; status, ancestry, actor, worker-path
// classification, and time-of-action fields do not exist here at all.
const ref = { maxLength: 64 };
const version = { maxLength: 10 };
const shortText = { maxLength: 400 };
const summary = { maxLength: 1200 };
const body = { maxLength: 20000 };
const localTime = { maxLength: 32 };

export const formSchemas = Object.freeze({
  // Public candidate authentication.
  register: defineFormSchema({
    intentToken: capability,
    email,
    password,
    passwordConfirmation: password,
  }),
  signIn: defineFormSchema({ email, password, next: key }),
  verifyEmail: defineFormSchema({ email, code }),
  // "Send a new code" shares the verification form, so the code field is
  // submitted too; the resend command reads only the email.
  resendCode: defineFormSchema({ email, code }),
  recover: defineFormSchema({ email }),
  resetPassword: defineFormSchema({
    token: capability,
    password,
    passwordConfirmation: password,
  }),
  // Public staff authentication.
  beginActivation: defineFormSchema({
    invite: capability,
    password,
    passwordConfirmation: password,
  }),
  verifyEnrollment: defineFormSchema({ code, password }),
  completeActivation: defineFormSchema({ saved: key }),
  staffSignIn: defineFormSchema({ email, password }),
  staffMfa: defineFormSchema({ method: key, code }),
  staffRecovery: defineFormSchema({ email, reason: key }),
  // Authenticated self-service (candidate and staff).
  changePassword: defineFormSchema({
    currentPassword: password,
    password,
    passwordConfirmation: password,
  }),
  revokeSession: defineFormSchema({ session: key }),
  noFields: defineFormSchema({}),
  regenerateBackupCodes: defineFormSchema({ password, code }),
  reauthenticate: defineFormSchema({ password, code, purpose: key }),
  // M2.1 staff position administration.
  organizationUpdate: defineFormSchema({
    commandKey: ref,
    organizationId: ref,
    expectedVersion: version,
    code: key,
    legalName: shortText,
    displayName: shortText,
    timezone: key,
  }),
  branchCreate: defineFormSchema({
    commandKey: ref,
    organizationId: ref,
    code: key,
    name: shortText,
    publicLocationLabel: shortText,
    timezone: key,
  }),
  branchUpdate: defineFormSchema({
    commandKey: ref,
    branchId: ref,
    expectedVersion: version,
    code: key,
    name: shortText,
    publicLocationLabel: shortText,
    timezone: key,
  }),
  teamCreate: defineFormSchema({
    commandKey: ref,
    branchId: ref,
    code: key,
    name: shortText,
  }),
  teamUpdate: defineFormSchema({
    commandKey: ref,
    teamId: ref,
    expectedVersion: version,
    code: key,
    name: shortText,
  }),
  configurationStatus: defineFormSchema({
    commandKey: ref,
    targetId: ref,
    expectedVersion: version,
    reasonCode: key,
  }),
  positionCreate: defineFormSchema({
    commandKey: ref,
    organizationId: ref,
    code: key,
    internalTitle: shortText,
    publicTitle: shortText,
    workerPathsAllowed: key,
  }),
  positionUpdate: defineFormSchema({
    commandKey: ref,
    positionId: ref,
    expectedVersion: version,
    code: key,
    internalTitle: shortText,
    publicTitle: shortText,
    workerPathsAllowed: key,
  }),
  descriptionCreate: defineFormSchema({
    commandKey: ref,
    positionId: ref,
    publicTitle: shortText,
    summary,
    body,
  }),
  descriptionUpdate: defineFormSchema({
    commandKey: ref,
    positionId: ref,
    descriptionId: ref,
    expectedVersion: version,
    publicTitle: shortText,
    summary,
    body,
  }),
  cycleCreate: defineFormSchema({
    commandKey: ref,
    positionId: ref,
    placement: { maxLength: 80 },
    code: key,
    internalLabel: shortText,
    publicLabel: shortText,
    opensAt: localTime,
    closesAt: localTime,
    openEnded: key,
  }),
  cycleUpdate: defineFormSchema({
    commandKey: ref,
    positionId: ref,
    cycleId: ref,
    expectedVersion: version,
    code: key,
    internalLabel: shortText,
    publicLabel: shortText,
    opensAt: localTime,
    closesAt: localTime,
    openEnded: key,
  }),
  // M2.1 public start-application handoff: only the public reference.
  startApplication: defineFormSchema({ reference: key }),
});
