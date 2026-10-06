// Public API of the identity-access module. Other modules and delivery code
// import only from here (ARCHITECTURE §6, §12). Server-only.
export {
  resolveCurrentAccount,
  type Principal,
} from "./application/current-account";
export {
  closeAccount,
  disableAccount,
  lockAccount,
  revokeAllSessions,
  revokeSession,
  type RestrictionResult,
} from "./application/restrict-account";
export {
  registerCandidate,
  type RegisterCandidateResult,
} from "./application/register-candidate";
export {
  resendVerificationCode,
  verifyCandidateEmail,
  type ResendVerificationResult,
  type VerifyCandidateEmailResult,
} from "./application/verify-candidate-email";
export {
  signInCandidate,
  signOutCandidate,
  type SignInCandidateResult,
} from "./application/sign-in-candidate";
export {
  requestCandidateRecovery,
  type RequestRecoveryResult,
} from "./application/request-candidate-recovery";
export {
  resetCandidatePassword,
  type ResetPasswordResult,
} from "./application/reset-candidate-password";
export {
  changeCandidatePassword,
  type ChangePasswordResult,
} from "./application/change-candidate-password";
export {
  getCandidateSecurityOverview,
  resolveCurrentCandidate,
  revokeCandidateSession,
  revokeOtherCandidateSessions,
  signOutCandidateEverywhere,
  type CandidateSecurityOverview,
  type CandidateSessionSummary,
  type SessionCommandResult,
} from "./application/manage-candidate-sessions";
export {
  issueCandidateInvitation,
  issuePublicRegistrationIntent,
} from "./application/registration-intents";
export {
  accountStatuses,
  accountTypes,
  type AccountStatus,
  type AccountType,
} from "./domain/account-types";
export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  resolvePostAuthDestination,
  type PasswordProblem,
} from "./domain/candidate-registration-policy";
export { normalizeLoginEmail } from "./domain/email";
export { OTP_LENGTH } from "./infrastructure/auth";
export { handleAuthRequest } from "./infrastructure/auth-http";
export {
  toCookieWrites,
  type CookieWrite,
} from "./infrastructure/cookie-writes";
