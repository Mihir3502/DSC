// Public API of the candidates module (packet M2.2; ARCHITECTURE §6).
// Delivery code imports only from here. Server-only.
export {
  authorizeCandidateCommand,
  candidateActorFrom,
  candidateDependencies,
  fingerprint,
  newCandidateCommandKey,
  refuse,
  runCandidateCommand,
  staffActorFrom,
  type CandidateActor,
  type CandidateDependencies,
  type CandidateOutcome,
  type CommandContext,
} from "./application/candidate-runtime";
export {
  findCandidacyByPublicId,
  type CandidacyRow,
  type Executor as CandidateExecutor,
} from "./infrastructure/candidates-repository";
export {
  assignCandidacyOwnerToSelf,
  closeProspect,
  createStaffProspect,
  mergePeople,
  reviewDuplicateMatch,
  startApplicationFromProspect,
  startOwnCandidacy,
  type CandidateResult,
} from "./application/candidate-commands";
export {
  queryCandidacyPath,
  queryCandidateStart,
  queryDuplicateQueue,
  queryDuplicateReview,
  queryProspectDetail,
  queryProspectForm,
} from "./application/candidate-queries";
export { candidateProjectionNames } from "./presentation/candidate-views";
export {
  queryCandidateHelp,
  queryCandidateHome,
  queryCandidateShell,
  queryCandidateTasks,
} from "./application/candidate-portal-queries";
export {
  candidateStatusCode,
  candidateStatusWording,
  taskFilters,
  type TaskFilter,
} from "./domain/candidate-portal";
export {
  candidateVisibleStatus,
  isCandidacyPublicId,
  mergeReasons,
  prospectCloseReasons,
  reviewReasons,
  type CandidacyStage,
  type CandidacyStatus,
} from "./domain/candidacy-policy";
