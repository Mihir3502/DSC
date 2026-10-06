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
  accountStatuses,
  accountTypes,
  type AccountStatus,
  type AccountType,
} from "./domain/account-types";
export { normalizeLoginEmail } from "./domain/email";
export { handleAuthRequest } from "./infrastructure/auth-http";
