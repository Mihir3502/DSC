import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  authorizeCandidateCommand,
  candidateDependencies,
  findCandidacy,
  findCandidacyByPublicId,
  fingerprint,
  isCandidacyPublicId,
  newPublicId,
  refuse,
  runCandidateCommand,
  type CandidacyRow,
  type CandidateActor,
  type CandidateDependencies,
  type CandidateExecutor,
  type CommandContext,
} from "@/modules/candidates";
import { candidacyWorkflow } from "@/modules/applications";
import { withAuditedTransaction } from "@/modules/audit";
import {
  checkAttachment,
  isAttachmentCategory,
  MAX_ACTIVE_ATTACHMENTS,
  type AttachmentRejection,
} from "../domain/attachment-policy";
import { documentProviders } from "../infrastructure/document-providers";
import {
  countActiveDocuments,
  lockDocument,
  findDocumentByPublicId,
  findVersion,
  finishVersion,
  insertDocument,
  insertVersion,
  latestVersion,
  lockVersion,
  updateDocument,
} from "../infrastructure/documents-repository";
import type { DocumentStorage, MalwareScanner } from "./ports";

// Named attachment commands (packet M2.5; SECURITY_AND_PRIVACY §11). Bytes are
// quarantined under a generated key first, then the receipt commits with its
// audit event, then the scan decides whether the file is promoted to private
// storage. A file becomes the document's current version only once clean, so a
// failed replacement never hides what it replaces. Audit carries codes and
// versions, never a file name, hash, or contents.

export type DocumentDependencies = CandidateDependencies &
  Readonly<{ storage: DocumentStorage; scanner: MalwareScanner }>;

export function documentDependencies(
  overrides: Partial<DocumentDependencies> = {},
): DocumentDependencies {
  return Object.freeze({
    ...candidateDependencies(),
    ...documentProviders(),
    ...overrides,
  });
}

const recordOf = (row: CandidacyRow) =>
  ({
    kind: "RECORD",
    id: row.id,
    sensitivity: "CONFIDENTIAL_PERSONNEL",
  }) as const;

const accountOf = (actor: CandidateActor) =>
  actor.kind === "BOOTSTRAP" ? actor.accountId : actor.principal.accountId;

async function lockCandidacy(ctx: CommandContext, publicId: string) {
  return (
    (await findCandidacyByPublicId(ctx.tx, publicId, "update")) ??
    refuse("NOT_FOUND")
  );
}

function requireEditable(row: CandidacyRow) {
  if (
    row.status !== "ACTIVE" ||
    row.currentStage !== "APPLICATION_INCOMPLETE"
  ) {
    refuse("INVALID_TRANSITION");
  }
}

export type UploadInput = Readonly<{
  commandKey?: string;
  candidacyId?: string;
  category?: string;
  /** The document this file replaces, when replacing. */
  documentId?: string;
  fileName: string;
  declaredType: string;
  bytes: Uint8Array;
}>;

export type UploadResult =
  | Readonly<{
      kind: "RECEIVED";
      status: "CLEAN" | "REJECTED" | "FAILED" | "PENDING";
    }>
  | Readonly<{ kind: "INVALID_FILE"; reason: AttachmentRejection }>
  | Readonly<{
      kind: "REFUSED";
      reason:
        | "UNAUTHENTICATED"
        | "NOT_AUTHORIZED"
        | "NOT_FOUND"
        | "INVALID_INPUT"
        | "INVALID_TRANSITION"
        | "COMMAND_KEY_CONFLICT"
        | "LIMIT_REACHED"
        | "RATE_LIMITED"
        | "UNAVAILABLE"
        | "STALE_VERSION";
    }>;

/**
 * upload_application_attachment: the candidate's own file, resume or
 * credential. A refused or rejected file leaves no stored bytes.
 */
export async function uploadApplicationAttachment(
  input: UploadInput,
  actor: CandidateActor,
  deps: DocumentDependencies = documentDependencies(),
): Promise<UploadResult> {
  if (actor.kind === "STAFF") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  }
  if (!isCandidacyPublicId(input.candidacyId)) {
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  }
  if (
    !isAttachmentCategory(input.category) ||
    (input.documentId !== undefined && !isCandidacyPublicId(input.documentId))
  ) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  if (!deps.limiter.consume("documentUploadPerAccount", accountOf(actor))) {
    return { kind: "REFUSED", reason: "RATE_LIMITED" };
  }
  const candidacyId = input.candidacyId!;
  const category = input.category;
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const request = fingerprint({
    candidacy: candidacyId,
    category,
    document: input.documentId ?? null,
    name: input.fileName,
    hash,
  });

  const checked = checkAttachment(
    input.fileName,
    input.declaredType,
    input.bytes,
  );
  if (!checked.ok) {
    const rejected = await runCandidateCommand(
      deps,
      actor,
      {
        name: "reject_application_attachment",
        commandKey: input.commandKey,
        fingerprint: request,
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, candidacyId);
        await authorizeCandidateCommand(
          ctx,
          deps,
          "application.own.edit",
          "EDIT",
          recordOf(row),
          undefined,
          candidacyWorkflow(row),
        );
        requireEditable(row);
        ctx.events.push({
          code: "document.upload_rejected",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          newVersion: row.version,
          changeCodes: [category, checked.reason],
        });
        return { outcome: "REJECTED", targetId: row.id, version: row.version };
      },
    );
    return rejected.kind === "DONE"
      ? { kind: "INVALID_FILE", reason: checked.reason }
      : refusal(rejected);
  }

  const key = randomUUID();
  try {
    await deps.storage.putQuarantine(key, input.bytes);
  } catch {
    deps.logger.error("documents.storage_unavailable", {
      module: "documents",
      resultCode: "storage_unavailable",
    });
    return { kind: "REFUSED", reason: "UNAVAILABLE" };
  }
  const received = await runCandidateCommand(
    deps,
    actor,
    {
      name: "upload_application_attachment",
      commandKey: input.commandKey,
      fingerprint: request,
    },
    async (ctx) => {
      const row = await lockCandidacy(ctx, candidacyId);
      await authorizeCandidateCommand(
        ctx,
        deps,
        "application.own.edit",
        "EDIT",
        recordOf(row),
        undefined,
        candidacyWorkflow(row),
      );
      requireEditable(row);
      let documentRow = input.documentId
        ? await findDocumentByPublicId(ctx.tx, input.documentId, row.id)
        : null;
      if (input.documentId && documentRow?.status !== "ACTIVE") {
        return refuse("NOT_FOUND");
      }
      if (!documentRow) {
        const active = await countActiveDocuments(ctx.tx, row.id);
        if (active >= MAX_ACTIVE_ATTACHMENTS) throw new LimitReached();
        documentRow = await insertDocument(ctx.tx, {
          publicId: newPublicId(),
          candidacyId: row.id,
          categoryCode: category,
          createdByAccountId: ctx.actorId,
          now: ctx.now,
        });
      }
      const previous = await latestVersion(ctx.tx, documentRow.id);
      const version = await insertVersion(ctx.tx, {
        documentId: documentRow.id,
        versionNumber: (previous?.versionNumber ?? 0) + 1,
        storageProviderCode: deps.storage.providerCode,
        storageObjectKey: key,
        displayName: checked.name,
        mediaType: checked.mediaType,
        sizeBytes: input.bytes.byteLength,
        contentHash: hash,
        supersedesId: previous?.id ?? null,
        uploadedByAccountId: ctx.actorId,
        uploadedAt: ctx.now,
      });
      ctx.events.push({
        code: "document.received",
        recordRef: documentRow.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        newVersion: version.versionNumber,
        changeCodes: [documentRow.categoryCode],
      });
      return {
        outcome: "RECEIVED",
        targetId: version.id,
        version: version.versionNumber,
      };
    },
  ).catch(async (error: unknown) => {
    await deps.storage.discardQuarantine(key);
    if (error instanceof LimitReached) {
      return { kind: "LIMIT_REACHED" } as const;
    }
    throw error;
  });
  if (received.kind === "LIMIT_REACHED") {
    return { kind: "REFUSED", reason: "LIMIT_REACHED" };
  }
  if (received.kind !== "DONE") {
    await deps.storage.discardQuarantine(key);
    return refusal(received);
  }
  if (received.replayed) {
    await deps.storage.discardQuarantine(key);
    const existing = await findVersion(
      deps.db as unknown as CandidateExecutor,
      received.targetId,
    );
    return {
      kind: "RECEIVED",
      status: (existing?.scanStatus ?? "PENDING") as "PENDING",
    };
  }
  return {
    kind: "RECEIVED",
    status: await scanVersion(received.targetId, deps),
  };
}

class LimitReached extends Error {}

function refusal(
  outcome: Readonly<{ kind: string; reason?: string }>,
): UploadResult {
  const reason = outcome.reason;
  switch (reason) {
    case "UNAUTHENTICATED":
    case "NOT_AUTHORIZED":
    case "NOT_FOUND":
    case "INVALID_INPUT":
    case "INVALID_TRANSITION":
    case "COMMAND_KEY_CONFLICT":
    case "RATE_LIMITED":
    case "STALE_VERSION":
      return { kind: "REFUSED", reason };
    default:
      return { kind: "REFUSED", reason: "INVALID_TRANSITION" };
  }
}

/**
 * The scan step. A clean file moves to private storage and becomes current; a
 * malicious file's bytes are discarded; a scanner failure leaves the bytes in
 * quarantine and the document unchanged. Repeating it for a finished version
 * changes nothing.
 */
export async function scanVersion(
  versionId: string,
  deps: DocumentDependencies,
): Promise<"CLEAN" | "REJECTED" | "FAILED" | "PENDING"> {
  const db = deps.db as unknown as CandidateExecutor;
  const pending = await findVersion(db, versionId);
  if (!pending) return "FAILED";
  if (pending.scanStatus !== "PENDING") {
    return pending.scanStatus as "CLEAN" | "REJECTED" | "FAILED";
  }
  let verdict: "CLEAN" | "MALICIOUS" | "ERROR";
  try {
    verdict = await deps.scanner.scan(
      await deps.storage.readQuarantine(pending.storageObjectKey),
    );
  } catch {
    verdict = "ERROR";
    deps.logger.error("documents.scan_unavailable", {
      module: "documents",
      resultCode: "scan_unavailable",
    });
  }
  const status =
    verdict === "CLEAN"
      ? "CLEAN"
      : verdict === "MALICIOUS"
        ? "REJECTED"
        : "FAILED";
  if (status === "CLEAN") await deps.storage.promote(pending.storageObjectKey);
  await withAuditedTransaction(deps, async (tx, audit) => {
    const executor = tx as unknown as CandidateExecutor;
    const version = await lockVersion(executor, versionId);
    if (version?.scanStatus !== "PENDING") return;
    const owner = (await lockDocument(executor, version.documentId))!;
    const now = deps.clock();
    await finishVersion(
      executor,
      version.id,
      status,
      deps.scanner.scannerCode,
      now,
    );
    if (status === "CLEAN") {
      await updateDocument(
        executor,
        owner.id,
        owner.version,
        { currentVersionId: version.id },
        now,
      );
    }
    const candidacy = (await findOwningCandidacy(executor, owner.candidacyId))!;
    await audit.append({
      code: "document.scanned",
      systemActor: "SYSTEM_PROCESS",
      recordRef: owner.id,
      candidacyRef: owner.candidacyId,
      organizationRef: candidacy.organizationId,
      newVersion: version.versionNumber,
      changeCodes: [status],
    });
  });
  if (status === "REJECTED") {
    await deps.storage.discardQuarantine(pending.storageObjectKey);
  }
  return status;
}

export type RemoveInput = Readonly<{
  commandKey?: string;
  candidacyId?: string;
  documentId?: string;
  expectedVersion?: string;
}>;

/**
 * remove_application_attachment: hides the document from the application. The
 * record, its versions, and its stored bytes stay as history.
 */
export async function removeApplicationAttachment(
  input: RemoveInput,
  actor: CandidateActor,
  deps: DocumentDependencies = documentDependencies(),
) {
  if (actor.kind === "STAFF") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" } as const;
  }
  if (
    !isCandidacyPublicId(input.candidacyId) ||
    !isCandidacyPublicId(input.documentId)
  ) {
    return { kind: "REFUSED", reason: "NOT_FOUND" } as const;
  }
  const expected =
    typeof input.expectedVersion === "string" &&
    /^[1-9][0-9]{0,8}$/.test(input.expectedVersion)
      ? Number(input.expectedVersion)
      : null;
  if (expected === null) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" } as const;
  }
  return runCandidateCommand(
    deps,
    actor,
    {
      name: "remove_application_attachment",
      commandKey: input.commandKey,
      fingerprint: fingerprint({
        candidacy: input.candidacyId,
        document: input.documentId,
        expected,
      }),
    },
    async (ctx) => {
      const row = await lockCandidacy(ctx, input.candidacyId!);
      await authorizeCandidateCommand(
        ctx,
        deps,
        "application.own.edit",
        "EDIT",
        recordOf(row),
        undefined,
        candidacyWorkflow(row),
      );
      requireEditable(row);
      const found = await findDocumentByPublicId(
        ctx.tx,
        input.documentId!,
        row.id,
      );
      if (found?.status !== "ACTIVE") return refuse("NOT_FOUND");
      if (found.version !== expected) return refuse("STALE_VERSION");
      const updated =
        (await updateDocument(
          ctx.tx,
          found.id,
          expected,
          { status: "REMOVED" },
          ctx.now,
        )) ?? refuse("STALE_VERSION");
      ctx.events.push({
        code: "document.removed",
        recordRef: found.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        previousVersion: expected,
        newVersion: updated.version,
        changeCodes: [found.categoryCode],
      });
      return {
        outcome: "REMOVED",
        targetId: found.id,
        version: updated.version,
      };
    },
  );
}

async function findOwningCandidacy(db: CandidateExecutor, candidacyId: string) {
  return findCandidacy(db, candidacyId, null);
}
