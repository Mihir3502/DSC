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
  queryCandidateSecurity,
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
// M1.3 staff invitation, activation, MFA, security, recent authentication,
// and recovery. Invitation issuance/revocation and recovery-case steps are
// exported for the local/test harness only; they require an explicit actor
// and the staff administration gate, which refuses in the application.
export {
  beginStaffActivation,
  completeStaffActivation,
  verifyStaffEnrollment,
  type BeginActivationResult,
  type CompleteActivationResult,
  type StaffEnrollment,
  type VerifyEnrollmentResult,
} from "./application/activate-staff-account";
export {
  completeStaffMfa,
  hasStaffChallenge,
  signInStaff,
  signOutStaff,
  type StaffMfaResult,
  type StaffSignInResult,
} from "./application/sign-in-staff";
export {
  changeStaffPassword,
  getStaffSecurityOverview,
  queryStaffSecurity,
  regenerateStaffBackupCodes,
  revokeOtherStaffSessions,
  revokeStaffSession,
  signOutStaffEverywhere,
  type StaffSecurityOverview,
  type StaffSessionSummary,
} from "./application/manage-staff-security";
export {
  evaluateStaffAssurance,
  queryStaffReauthentication,
  reauthenticateStaff,
  resolveCurrentStaff,
  type ReauthenticateResult,
} from "./application/reauthenticate-staff";
export {
  advanceStaffRecovery,
  requestStaffRecovery,
} from "./application/recover-staff-account";
export {
  issueStaffInvitation,
  revokeStaffInvitation,
} from "./application/issue-staff-invitation";
export {
  assurancePolicies,
  evaluateAssurance,
  isInlineReauthenticationPurpose,
  isReauthenticationPurpose,
  type AssuranceDecision,
  type AssuranceEvidence,
  type AssurancePolicy,
  type ReauthenticationPurpose,
} from "./domain/authentication-assurance";
// M1.4 central authorization (ADR-0005). Assignment administration is not
// exported: no production surface may manage roles before M1.5/M1.6.
export {
  authorize,
  authorizeInTransaction,
  type AuthorizationDependencies,
} from "./application/authorize";
export { authorizationDependencies } from "./application/authorization-support";
// M1.5 route/object/field authorization (ADR-0011).
export {
  authorizeAccountSelfService,
  refusalOf,
  type SelfServiceRefusal,
} from "./application/authorize-self-service";
export { navigationHint } from "./application/navigation-guard";
export {
  selfServicePolicies,
  type SelfServiceDecision,
  type SelfServicePolicyCode,
} from "./domain/self-service-policy";
export type {
  AuthorizationDecision,
  AuthorizationRequest,
} from "./domain/authorization-decision";
export {
  isRecoveryReasonCode,
  recoveryReasonCodes,
} from "./domain/staff-recovery";
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
// M1.6 (ADR-0012): the audit query authorizer adapter. Internal service
// wiring only; no route, page, or Server Action exposes audit queries.
export {
  auditQueryAuthorizer,
  auditQueryDependencies,
} from "./application/audit-query-authorizer";
