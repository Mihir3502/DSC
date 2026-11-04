import "server-only";
import { and, asc, count, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { CandidateExecutor as Executor } from "@/modules/candidates";
import {
  applicationCertificationVersion,
  applicationDraftSection,
  applicationSubmission,
  applicationSubmissionAttachment,
  applicationTemplate,
  applicationTemplateVersion,
  applicationVersion,
} from "./applications-schema";

// Persistence for application templates and drafts (packet M2.4). Callers
// have already authorized the candidacy; these functions never decide
// authority and return rows only to the module's own services.

export type ApplicationVersionRow = typeof applicationVersion.$inferSelect;
export type DraftSectionRow = typeof applicationDraftSection.$inferSelect;
export type TemplateVersionRow = typeof applicationTemplateVersion.$inferSelect;

export const CURRENT_TEMPLATE_CODE = "CANDIDATE_APPLICATION";

/** The newest version of the application template effective at `at`. */
export async function findEffectiveTemplateVersion(
  db: Executor,
  at: Date,
): Promise<TemplateVersionRow | null> {
  const [row] = await db
    .select({ version: applicationTemplateVersion })
    .from(applicationTemplateVersion)
    .innerJoin(
      applicationTemplate,
      eq(
        applicationTemplate.id,
        applicationTemplateVersion.applicationTemplateId,
      ),
    )
    .where(
      and(
        eq(applicationTemplate.code, CURRENT_TEMPLATE_CODE),
        lte(applicationTemplateVersion.effectiveFrom, at),
        or(
          isNull(applicationTemplateVersion.effectiveTo),
          gt(applicationTemplateVersion.effectiveTo, at),
        ),
      ),
    )
    .orderBy(desc(applicationTemplateVersion.versionNumber))
    .limit(1);
  return row?.version ?? null;
}

export async function findTemplateVersion(
  db: Executor,
  id: string,
): Promise<TemplateVersionRow | null> {
  const [row] = await db
    .select()
    .from(applicationTemplateVersion)
    .where(eq(applicationTemplateVersion.id, id))
    .limit(1);
  return row ?? null;
}

export async function findDraft(
  db: Executor,
  candidacyId: string,
): Promise<ApplicationVersionRow | null> {
  const [row] = await db
    .select()
    .from(applicationVersion)
    .where(
      and(
        eq(applicationVersion.candidacyId, candidacyId),
        eq(applicationVersion.status, "DRAFT"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertDraft(
  db: Executor,
  values: Readonly<{
    candidacyId: string;
    templateVersionId: string;
    createdByAccountId: string;
    createdAt: Date;
  }>,
): Promise<ApplicationVersionRow> {
  const [row] = await db
    .insert(applicationVersion)
    .values({ ...values, versionNumber: 1, status: "DRAFT" })
    .returning();
  return row!;
}

export async function listDraftSections(
  db: Executor,
  applicationVersionId: string,
): Promise<DraftSectionRow[]> {
  return db
    .select()
    .from(applicationDraftSection)
    .where(
      eq(applicationDraftSection.applicationVersionId, applicationVersionId),
    )
    .orderBy(asc(applicationDraftSection.sectionCode));
}

export async function findDraftSection(
  db: Executor,
  applicationVersionId: string,
  sectionCode: string,
): Promise<DraftSectionRow | null> {
  const [row] = await db
    .select()
    .from(applicationDraftSection)
    .where(
      and(
        eq(applicationDraftSection.applicationVersionId, applicationVersionId),
        eq(applicationDraftSection.sectionCode, sectionCode),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type SectionWrite = Readonly<{
  answers: unknown;
  completionStatus: string;
  savedByAccountId: string;
  savedByKind: "CANDIDATE" | "STAFF_ASSIST";
  assistReasonCode: string | null;
  savedAt: Date;
}>;

export async function insertDraftSection(
  db: Executor,
  applicationVersionId: string,
  sectionCode: string,
  write: SectionWrite,
): Promise<DraftSectionRow> {
  const [row] = await db
    .insert(applicationDraftSection)
    .values({
      applicationVersionId,
      sectionCode,
      ...write,
      version: 1,
      createdAt: write.savedAt,
    })
    .returning();
  return row!;
}

/** Compare-and-set on the section version; null means it was stale. */
export async function updateDraftSection(
  db: Executor,
  id: string,
  expectedVersion: number,
  write: SectionWrite,
): Promise<DraftSectionRow | null> {
  const [row] = await db
    .update(applicationDraftSection)
    .set({ ...write, version: expectedVersion + 1 })
    .where(
      and(
        eq(applicationDraftSection.id, id),
        eq(applicationDraftSection.version, expectedVersion),
      ),
    )
    .returning();
  return row ?? null;
}

/** The newest certification statement effective at `at`. */
export async function findEffectiveCertification(db: Executor, at: Date) {
  const [row] = await db
    .select()
    .from(applicationCertificationVersion)
    .where(lte(applicationCertificationVersion.effectiveFrom, at))
    .orderBy(desc(applicationCertificationVersion.versionNumber))
    .limit(1);
  return row ?? null;
}

/** The candidacy's newest application version, in any status. */
export async function findLatestVersion(
  db: Executor,
  candidacyId: string,
): Promise<ApplicationVersionRow | null> {
  const [row] = await db
    .select()
    .from(applicationVersion)
    .where(eq(applicationVersion.candidacyId, candidacyId))
    .orderBy(desc(applicationVersion.versionNumber))
    .limit(1);
  return row ?? null;
}

export async function findLatestSubmission(db: Executor, candidacyId: string) {
  const [row] = await db
    .select({
      submission: applicationSubmission,
      certificationVersion: applicationCertificationVersion.versionNumber,
    })
    .from(applicationSubmission)
    .innerJoin(
      applicationCertificationVersion,
      eq(
        applicationCertificationVersion.id,
        applicationSubmission.certificationVersionId,
      ),
    )
    .where(eq(applicationSubmission.candidacyId, candidacyId))
    .orderBy(desc(applicationSubmission.submittedAt))
    .limit(1);
  if (!row) return null;
  const [files] = await db
    .select({ n: count() })
    .from(applicationSubmissionAttachment)
    .where(eq(applicationSubmissionAttachment.submissionId, row.submission.id));
  return { ...row, attachmentCount: files?.n ?? 0 };
}
