// Public API of the applications module (packet M2.4; ARCHITECTURE §6).
// Delivery code imports only from here. Server-only.
export {
  assistSaveApplicationSection,
  beginApplicationDraft,
  saveApplicationSection,
  type ApplicationCommandResult,
} from "./application/application-commands";
export {
  queryApplicationOverview,
  queryApplicationReceipt,
  queryApplicationReview,
  queryApplicationSection,
  queryStaffApplicationReview,
  type ApplicationQueryResult,
} from "./application/application-queries";
export { applicationProjectionNames } from "./presentation/application-views";
export { submitApplication } from "./application/application-submission";
export { dispatchApplicationEmails } from "./application/application-outbox";
export { returnApplication } from "./application/application-return";
