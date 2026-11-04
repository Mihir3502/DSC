import "server-only";
import { sql } from "drizzle-orm";
import {
  authorize,
  authorizeDocumentAccess,
  project,
  resolveCurrentCandidate,
  type DocumentPermissionRegistry,
} from "@/modules/identity-access";
import {
  findCandidacyByPublicId,
  isCandidacyPublicId,
  type CandidateExecutor,
} from "@/modules/candidates";
import { withAuditedTransaction } from "@/modules/audit";
import {
  attachmentCategories,
  MAX_ACTIVE_ATTACHMENTS,
  scanStatusLabels,
  sizeLabel,
  type AttachmentCategory,
  type AttachmentMediaType,
  type ScanStatus,
} from "../domain/attachment-policy";
import {
  attachmentsLockedByCorrection,
  findDocumentByPublicId,
  findVersion,
  latestVersion,
  listCandidacyDocuments,
} from "../infrastructure/documents-repository";
import {
  applicationAttachmentsContract,
  type ApplicationAttachmentsView,
} from "../presentation/document-views";
import {
  documentDependencies,
  type DocumentDependencies,
} from "./attachment-commands";

// Candidate attachment reads (packet M2.5 §7–§8). The list is an exact
// projection. A download passes the M1.5 document gate on every request, then
// commits its audit event before any byte is read, so an unaudited download
// can't happen. Staff have no mapping in this registry and no route: review
// screens arrive with M3.

const CATEGORY = "APPLICATION_ATTACHMENT";

/** Only the candidate's own read permission reaches application attachments. */
export const applicationAttachmentPermissions: DocumentPermissionRegistry =
  Object.freeze({
    [CATEGORY]: Object.freeze({
      DOWNLOAD: {
        permission: "candidate.candidacy.read_own",
        operation: "READ" as const,
      },
    }),
  });

const db = (deps: DocumentDependencies) =>
  deps.db as unknown as CandidateExecutor;

export type AttachmentListResult =
  | Readonly<{ kind: "OK"; view: ApplicationAttachmentsView }>
  | Readonly<{ kind: "UNAUTHENTICATED" | "NOT_FOUND" }>;

/** The candidate's own attachments, with the state of each latest upload. */
export async function queryApplicationAttachments(
  headers: Headers,
  candidacyId: unknown,
  deps: DocumentDependencies = documentDependencies(),
): Promise<AttachmentListResult> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (!isCandidacyPublicId(candidacyId)) return { kind: "NOT_FOUND" };
  const row = await findCandidacyByPublicId(db(deps), candidacyId, null);
  if (!row) return { kind: "NOT_FOUND" };
  const decision = await authorize(
    {
      principal: {
        accountId: principal.accountId,
        accountType: principal.accountType,
        sessionId: principal.sessionId,
      },
      permission: "candidate.candidacy.read_own",
      operation: "READ",
      resource: {
        kind: "RECORD",
        id: row.id,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
    },
    deps,
  );
  if (decision.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const documents = await listCandidacyDocuments(db(deps), row.id);
  const attachments = [];
  for (const document of documents) {
    const latest = await latestVersion(db(deps), document.id);
    if (!latest) continue;
    const status = latest.scanStatus as ScanStatus;
    attachments.push({
      documentId: document.publicId,
      version: document.version,
      category:
        attachmentCategories[document.categoryCode as AttachmentCategory],
      name: latest.displayName,
      size: sizeLabel(latest.sizeBytes),
      status: scanStatusLabels[status],
      problem:
        status === "REJECTED"
          ? ("NOT_ACCEPTED" as const)
          : status === "FAILED"
            ? ("NOT_CHECKED" as const)
            : null,
      downloadable: document.currentVersionId !== null,
    });
  }
  const projected = project(
    applicationAttachmentsContract,
    {
      candidacyId: row.publicId,
      editable:
        row.status === "ACTIVE" &&
        row.currentStage === "APPLICATION_INCOMPLETE" &&
        !(await attachmentsLockedByCorrection(db(deps), row.id)),
      atLimit: documents.length >= MAX_ACTIVE_ATTACHMENTS,
      attachments,
    },
    {
      audience: applicationAttachmentsContract.audience,
      purpose: applicationAttachmentsContract.purpose,
      allowed: new Set(["candidate.candidacy.read_own"]),
    },
  );
  if (projected.kind !== "PROJECTED") {
    deps.logger.error("authz.projection_refused", {
      module: "documents",
      action: applicationAttachmentsContract.name,
      reasonCode: projected.reason,
    });
    return { kind: "NOT_FOUND" };
  }
  return { kind: "OK", view: projected.value };
}

export type DownloadResult =
  | Readonly<{
      kind: "OK";
      bytes: Uint8Array;
      name: string;
      mediaType: AttachmentMediaType;
    }>
  | Readonly<{
      kind: "UNAUTHENTICATED" | "NOT_FOUND" | "UNAVAILABLE" | "RATE_LIMITED";
    }>;

/** Authorizes, audits, then reads: a download never precedes its audit. */
export async function openApplicationAttachment(
  headers: Headers,
  candidacyId: unknown,
  documentId: unknown,
  correlationId: string | undefined,
  deps: DocumentDependencies = documentDependencies(),
): Promise<DownloadResult> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (!isCandidacyPublicId(candidacyId) || !isCandidacyPublicId(documentId)) {
    return { kind: "NOT_FOUND" };
  }
  if (
    !deps.limiter.consume("documentDownloadPerAccount", principal.accountId)
  ) {
    return { kind: "RATE_LIMITED" };
  }
  const candidacy = await findCandidacyByPublicId(db(deps), candidacyId, null);
  const found = candidacy
    ? await findDocumentByPublicId(db(deps), documentId, candidacy.id)
    : null;
  if (!candidacy || !found) return { kind: "NOT_FOUND" };
  const current = found.currentVersionId
    ? await findVersion(db(deps), found.currentVersionId)
    : null;
  const gate = await authorizeDocumentAccess(
    {
      principal: {
        accountId: principal.accountId,
        accountType: principal.accountType,
        sessionId: principal.sessionId,
      },
      documentId: found.id,
      action: "DOWNLOAD",
      ...(correlationId ? { correlationId } : {}),
    },
    {
      source: {
        loadDocumentEnvelope: async (id) =>
          id === found.id
            ? {
                id,
                category: CATEGORY,
                parentRecordId: found.candidacyId,
                sensitivity: "CONFIDENTIAL_PERSONNEL",
                audience: "CANDIDATE_VISIBLE",
                scanState:
                  current?.scanStatus === "CLEAN" ? "CLEAN" : "PENDING",
                hidden: found.status !== "ACTIVE",
              }
            : null,
      },
      registry: applicationAttachmentPermissions,
      authorize: (request) => authorize(request, deps),
      events: deps.events,
      clock: deps.clock,
    },
  );
  if (gate.kind === "UNAUTHENTICATED") return { kind: "UNAUTHENTICATED" };
  if (gate.kind === "UNAVAILABLE") return { kind: "UNAVAILABLE" };
  if (gate.kind !== "AUTHORIZED" || !current) return { kind: "NOT_FOUND" };
  await withAuditedTransaction(deps, async (_tx, audit) => {
    await audit.append({
      code: "document.downloaded",
      actorRef: principal.accountId,
      recordRef: found.id,
      candidacyRef: found.candidacyId,
      organizationRef: candidacy.organizationId,
      newVersion: current.versionNumber,
      changeCodes: [found.categoryCode],
    });
  });
  return {
    kind: "OK",
    bytes: await deps.storage.readApproved(current.storageObjectKey),
    name: current.displayName,
    mediaType: current.mediaType as AttachmentMediaType,
  };
}

export type SubmittableAttachments = Readonly<{
  included: readonly Readonly<{
    versionId: string;
    category: string;
    name: string;
    size: string;
  }>[];
  /** Files with no clean version, which a submission leaves out. */
  excluded: readonly Readonly<{ name: string; status: string }>[];
}>;

/**
 * What a submission would freeze: each active document's current clean version.
 * The caller has already authorized the candidacy.
 */
export async function listSubmittableAttachments(
  executor: CandidateExecutor,
  candidacyId: string,
): Promise<SubmittableAttachments> {
  const included = [];
  const excluded = [];
  for (const row of await listCandidacyDocuments(executor, candidacyId)) {
    const current = row.currentVersionId
      ? await findVersion(executor, row.currentVersionId)
      : null;
    if (current) {
      included.push({
        versionId: current.id,
        category: attachmentCategories[row.categoryCode as AttachmentCategory],
        name: current.displayName,
        size: sizeLabel(current.sizeBytes),
      });
    } else {
      const latest = await latestVersion(executor, row.id);
      if (latest) {
        excluded.push({
          name: latest.displayName,
          status: scanStatusLabels[latest.scanStatus as ScanStatus],
        });
      }
    }
  }
  return { included, excluded };
}

/** Names of the files a submission froze. No key, hash, or bytes. */
export async function listSubmittedAttachments(
  executor: CandidateExecutor,
  submissionId: string,
) {
  const result = await executor.execute(sql`
    SELECT d.category_code AS category, v.display_name AS name, v.size_bytes AS size
      FROM app.application_submission_attachment a
      JOIN app.document_version v ON v.id = a.document_version_id
      JOIN app.document d ON d.id = v.document_id
     WHERE a.submission_id = ${submissionId}
     ORDER BY v.display_name, v.id
     LIMIT 20
  `);
  return (
    result as unknown as {
      rows: { category: string; name: string; size: string | number }[];
    }
  ).rows.map((row) => ({
    category: attachmentCategories[row.category as AttachmentCategory],
    name: row.name,
    size: sizeLabel(Number(row.size)),
  }));
}
