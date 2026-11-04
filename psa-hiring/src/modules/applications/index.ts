// Public API of the applications module (packet M2.4; ARCHITECTURE §6).
// Delivery code imports only from here. Server-only.
export {
  assistSaveApplicationSection,
  beginApplicationDraft,
  candidacyWorkflow,
  saveApplicationSection,
  type ApplicationCommandResult,
} from "./application/application-commands";
export {
  queryApplicationOverview,
  queryApplicationSection,
  type ApplicationQueryResult,
} from "./application/application-queries";
export { applicationProjectionNames } from "./presentation/application-views";
