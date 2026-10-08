// Public API of the organization module (packet M2.1, ARCHITECTURE §6).
// Delivery code imports only from here. Server-only.
export {
  configurationDependencies,
  newCommandKey,
  staffActor,
  type ConfigurationActor,
  type ConfigurationDependencies,
} from "./application/configuration-runtime";
export {
  changeBranchStatus,
  changeOrganizationStatus,
  changeTeamStatus,
  createBranch,
  createOrganization,
  createTeam,
  updateBranchDetails,
  updateOrganizationDetails,
  updateTeamDetails,
} from "./application/commands/hierarchy-commands";
export {
  changePositionStatus,
  createDescriptionDraft,
  createPosition,
  publishDescription,
  updateDescriptionDraftContent,
  updatePositionDetails,
} from "./application/commands/position-commands";
export {
  createHiringCycle,
  transitionHiringCycle,
  updateHiringCycleDraft,
} from "./application/commands/hiring-cycle-commands";
export type { ConfigurationResult } from "./application/commands/result";
export {
  queryCycleDetail,
  queryCycleForm,
  queryDescriptionDetail,
  queryHierarchy,
  queryPositionDetail,
  queryPositionForm,
  queryPositionList,
} from "./application/staff-queries";
export {
  beginApplicationHandoff,
  confirmApplicationHandoff,
  queryHandoffOpening,
  queryPublicPosition,
  queryPublicPositions,
} from "./application/public-positions";
export { organizationProjectionNames } from "./presentation/staff-views";
export {
  classificationDisclaimer,
  workerPathFilterLabels,
} from "./presentation/public-position-view";
export { cancelReasons, changeReasons, closeReasons } from "./domain/lifecycle";
export { workerPaths, type WorkerPaths } from "./domain/values";
