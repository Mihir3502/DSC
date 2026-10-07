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
});
