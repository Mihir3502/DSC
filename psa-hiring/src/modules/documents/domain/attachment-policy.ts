import { hasForbiddenCharacters } from "@/modules/candidates/domain/normalization";

// Application attachment rules (packet M2.5; SECURITY_AND_PRIVACY §11). Pure.
// The approved types and limits are an owner decision (2026-11-03): PDF, JPEG,
// and PNG, up to 10 MB each and 10 per application. The stored media type comes
// from the file's signature, never from what the client declared, and a
// rejection never echoes the file name or contents.

export const attachmentCategories = {
  RESUME: "Resume",
  CREDENTIAL: "License or certification",
} as const;
export type AttachmentCategory = keyof typeof attachmentCategories;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ACTIVE_ATTACHMENTS = 10;
/** Multipart overhead allowed on top of one file. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;

export type AttachmentMediaType =
  "application/pdf" | "image/jpeg" | "image/png";

const types: readonly Readonly<{
  mediaType: AttachmentMediaType;
  extensions: readonly string[];
  signature: readonly number[];
}>[] = [
  {
    mediaType: "application/pdf",
    extensions: ["pdf"],
    signature: [0x25, 0x50, 0x44, 0x46, 0x2d],
  },
  {
    mediaType: "image/jpeg",
    extensions: ["jpg", "jpeg"],
    signature: [0xff, 0xd8, 0xff],
  },
  {
    mediaType: "image/png",
    extensions: ["png"],
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
];

export type AttachmentRejection =
  "EMPTY" | "TOO_LARGE" | "TYPE_NOT_ALLOWED" | "CONTENT_MISMATCH";

export const isAttachmentCategory = (
  value: unknown,
): value is AttachmentCategory =>
  typeof value === "string" && Object.hasOwn(attachmentCategories, value);

/** A display name with no path or unsafe character; never a storage path. */
export function displayName(raw: string, mediaType: AttachmentMediaType) {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base.normalize("NFC")]
    .filter((c) => !hasForbiddenCharacters(c))
    .join("")
    .trim()
    .replace(/^\.+/, "")
    .slice(-120);
  const fallback = types.find((t) => t.mediaType === mediaType)!.extensions[0];
  return cleaned.length > 0 ? cleaned : `attachment.${fallback}`;
}

function matchesSignature(bytes: Uint8Array, signature: readonly number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

export type AttachmentCheck =
  | Readonly<{ ok: true; mediaType: AttachmentMediaType; name: string }>
  | Readonly<{ ok: false; reason: AttachmentRejection }>;

/** Size, then extension, then declared type, then the bytes themselves. */
export function checkAttachment(
  name: string,
  declaredType: string,
  bytes: Uint8Array,
): AttachmentCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "EMPTY" };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: "TOO_LARGE" };
  }
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase();
  const type = types.find((t) => t.extensions.includes(extension ?? ""));
  if (!type) return { ok: false, reason: "TYPE_NOT_ALLOWED" };
  if (declaredType !== "" && declaredType !== type.mediaType) {
    return { ok: false, reason: "CONTENT_MISMATCH" };
  }
  if (!matchesSignature(bytes, type.signature)) {
    return { ok: false, reason: "CONTENT_MISMATCH" };
  }
  return {
    ok: true,
    mediaType: type.mediaType,
    name: displayName(name, type.mediaType),
  };
}

export const scanStatusLabels = {
  PENDING: "Checking this file",
  CLEAN: "Ready",
  REJECTED: "Not accepted",
  FAILED: "Could not be checked",
} as const;
export type ScanStatus = keyof typeof scanStatusLabels;

export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
