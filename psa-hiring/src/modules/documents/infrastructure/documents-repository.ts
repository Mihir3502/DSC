import "server-only";
import { and, asc, count, desc, eq } from "drizzle-orm";
import type { CandidateExecutor as Executor } from "@/modules/candidates";
import { document, documentVersion } from "./documents-schema";

// Persistence for application attachments. Callers have already authorized
// the candidacy; rows never leave the module's own services.

export type DocumentRow = typeof document.$inferSelect;
export type DocumentVersionRow = typeof documentVersion.$inferSelect;

export async function findDocumentByPublicId(
  db: Executor,
  publicId: string,
  candidacyId: string,
): Promise<DocumentRow | null> {
  const [row] = await db
    .select()
    .from(document)
    .where(
      and(
        eq(document.publicId, publicId),
        eq(document.candidacyId, candidacyId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function lockDocument(
  db: Executor,
  id: string,
): Promise<DocumentRow | null> {
  const [row] = await db
    .select()
    .from(document)
    .where(eq(document.id, id))
    .for("update")
    .limit(1);
  return row ?? null;
}

export async function countActiveDocuments(
  db: Executor,
  candidacyId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(document)
    .where(
      and(eq(document.candidacyId, candidacyId), eq(document.status, "ACTIVE")),
    );
  return row?.n ?? 0;
}

export async function insertDocument(
  db: Executor,
  values: Readonly<{
    publicId: string;
    candidacyId: string;
    categoryCode: string;
    createdByAccountId: string;
    now: Date;
  }>,
): Promise<DocumentRow> {
  const [row] = await db
    .insert(document)
    .values({
      publicId: values.publicId,
      candidacyId: values.candidacyId,
      categoryCode: values.categoryCode,
      dataClassification: "CONFIDENTIAL_PERSONNEL",
      retentionClassCode: "APPLICATION_ATTACHMENT_UNSET",
      createdByAccountId: values.createdByAccountId,
      createdAt: values.now,
      updatedAt: values.now,
    })
    .returning();
  return row!;
}

export async function latestVersion(
  db: Executor,
  documentId: string,
): Promise<DocumentVersionRow | null> {
  const [row] = await db
    .select()
    .from(documentVersion)
    .where(eq(documentVersion.documentId, documentId))
    .orderBy(desc(documentVersion.versionNumber))
    .limit(1);
  return row ?? null;
}

export async function findVersion(
  db: Executor,
  id: string,
): Promise<DocumentVersionRow | null> {
  const [row] = await db
    .select()
    .from(documentVersion)
    .where(eq(documentVersion.id, id))
    .limit(1);
  return row ?? null;
}

export async function lockVersion(
  db: Executor,
  id: string,
): Promise<DocumentVersionRow | null> {
  const [row] = await db
    .select()
    .from(documentVersion)
    .where(eq(documentVersion.id, id))
    .for("update")
    .limit(1);
  return row ?? null;
}

export async function insertVersion(
  db: Executor,
  values: typeof documentVersion.$inferInsert,
): Promise<DocumentVersionRow> {
  const [row] = await db.insert(documentVersion).values(values).returning();
  return row!;
}

export async function finishVersion(
  db: Executor,
  id: string,
  status: "CLEAN" | "REJECTED" | "FAILED",
  scannerCode: string,
  now: Date,
): Promise<void> {
  await db
    .update(documentVersion)
    .set({ scanStatus: status, scannerCode, finalizedAt: now })
    .where(eq(documentVersion.id, id));
}

/** Compare-and-set on the document version; null means it was stale. */
export async function updateDocument(
  db: Executor,
  id: string,
  expectedVersion: number,
  changes: Partial<Pick<DocumentRow, "currentVersionId" | "status">>,
  now: Date,
): Promise<DocumentRow | null> {
  const [row] = await db
    .update(document)
    .set({ ...changes, version: expectedVersion + 1, updatedAt: now })
    .where(and(eq(document.id, id), eq(document.version, expectedVersion)))
    .returning();
  return row ?? null;
}

/** Active documents with their versions, oldest first; bounded. */
export async function listCandidacyDocuments(
  db: Executor,
  candidacyId: string,
): Promise<DocumentRow[]> {
  return db
    .select()
    .from(document)
    .where(
      and(eq(document.candidacyId, candidacyId), eq(document.status, "ACTIVE")),
    )
    .orderBy(asc(document.createdAt), asc(document.id))
    .limit(20);
}
