// Public API of the documents module (packet M2.5; ARCHITECTURE §6). Delivery
// code imports only from here. Server-only.
export {
  removeApplicationAttachment,
  uploadApplicationAttachment,
} from "./application/attachment-commands";
export {
  openApplicationAttachment,
  queryApplicationAttachments,
} from "./application/attachment-queries";
export { documentProjectionNames } from "./presentation/document-views";
export {
  attachmentCategories,
  MAX_ATTACHMENT_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
} from "./domain/attachment-policy";
export {
  listSubmittableAttachments,
  listSubmittedAttachments,
  type SubmittableAttachments,
} from "./application/attachment-queries";
