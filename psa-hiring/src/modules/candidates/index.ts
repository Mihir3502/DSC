// Public API of the candidates module (packet M2.2; ARCHITECTURE §6).
// Delivery code imports only from here. Server-only.
export {
  candidateActorFrom,
  candidateDependencies,
  newCandidateCommandKey,
  staffActorFrom,
  type CandidateActor,
  type CandidateDependencies,
} from "./application/candidate-runtime";
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
  mergeReasons,
  prospectCloseReasons,
  reviewReasons,
} from "./domain/candidacy-policy";
