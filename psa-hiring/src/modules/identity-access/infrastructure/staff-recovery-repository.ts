import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/shared/database";
import {
  openRecoveryStatuses,
  type RecoveryCaseSnapshot,
  type RecoveryReasonCode,
  type RecoveryResolutionCode,
  type StaffRecoveryStatus,
} from "../domain/staff-recovery";
import { uuidPattern } from "./account-repository";
import { staffRecoveryCase } from "./staff-identity-schema";

// Staff recovery-case persistence (packet M1.3 §14). Cases carry references,
// timestamps, and safe codes only. Every transition is a conditional,
// version-checked UPDATE inside the caller's transaction.

type Executor = Pick<Database, "select" | "update" | "insert">;

export type RecoveryCaseRow = RecoveryCaseSnapshot &
  Readonly<{ id: string; version: number }>;

const columns = {
  id: staffRecoveryCase.id,
  status: staffRecoveryCase.status,
  accountId: staffRecoveryCase.accountId,
  expiresAt: staffRecoveryCase.expiresAt,
  verifierAccountId: staffRecoveryCase.verifierAccountId,
  approverAccountId: staffRecoveryCase.approverAccountId,
  approvalExpiresAt: staffRecoveryCase.approvalExpiresAt,
  version: staffRecoveryCase.version,
};

function toRow(row: {
  id: string;
  status: string;
  accountId: string;
  expiresAt: Date;
  verifierAccountId: string | null;
  approverAccountId: string | null;
  approvalExpiresAt: Date | null;
  version: number;
}): RecoveryCaseRow {
  return Object.freeze({ ...row, status: row.status as StaffRecoveryStatus });
}

export async function findRecoveryCase(
  db: Executor,
  caseId: string,
  forUpdate = false,
): Promise<RecoveryCaseRow | null> {
  if (!uuidPattern.test(caseId)) return null;
  const query = db
    .select(columns)
    .from(staffRecoveryCase)
    .where(eq(staffRecoveryCase.id, caseId))
    .limit(1);
  const [row] = await (forUpdate ? query.for("update") : query);
  return row ? toRow(row) : null;
}

export async function findOpenRecoveryCaseForAccount(
  db: Executor,
  accountId: string,
): Promise<RecoveryCaseRow | null> {
  const [row] = await db
    .select(columns)
    .from(staffRecoveryCase)
    .where(
      and(
        eq(staffRecoveryCase.accountId, accountId),
        inArray(staffRecoveryCase.status, [...openRecoveryStatuses]),
      ),
    )
    .limit(1);
  return row ? toRow(row) : null;
}

/** Opens a case; returns null when an open case already exists (race). */
export async function insertRecoveryCase(
  tx: Executor,
  input: {
    accountId: string;
    reasonCode: RecoveryReasonCode;
    requestedAt: Date;
    expiresAt: Date;
  },
): Promise<string | null> {
  const [created] = await tx
    .insert(staffRecoveryCase)
    .values({
      accountId: input.accountId,
      status: "REQUESTED",
      reasonCode: input.reasonCode,
      requestedAt: input.requestedAt,
      expiresAt: input.expiresAt,
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
    })
    .onConflictDoNothing()
    .returning({ id: staffRecoveryCase.id });
  return created?.id ?? null;
}

export type RecoveryUpdate = Readonly<{
  to: StaffRecoveryStatus;
  at: Date;
  resolution?: RecoveryResolutionCode;
  verifierAccountId?: string;
  approverAccountId?: string;
  approvalExpiresAt?: Date;
  completedByAccountId?: string;
}>;

/** Applies one version-checked transition; false when it lost a race. */
export async function updateRecoveryCase(
  tx: Executor,
  row: Pick<RecoveryCaseRow, "id" | "version" | "status">,
  change: RecoveryUpdate,
): Promise<boolean> {
  const stamps: Record<string, Date | string> = {};
  if (change.to === "IDENTITY_VERIFICATION_PENDING") {
    stamps.verificationStartedAt = change.at;
  }
  if (change.to === "APPROVAL_PENDING") stamps.identityVerifiedAt = change.at;
  if (change.to === "APPROVED") stamps.approvedAt = change.at;
  if (change.resolution) {
    stamps.resolvedAt = change.at;
    stamps.resolutionCode = change.resolution;
  }
  if (change.verifierAccountId) {
    stamps.verifierAccountId = change.verifierAccountId;
  }
  if (change.approverAccountId) {
    stamps.approverAccountId = change.approverAccountId;
  }
  if (change.approvalExpiresAt) {
    stamps.approvalExpiresAt = change.approvalExpiresAt;
  }
  if (change.completedByAccountId) {
    stamps.completedByAccountId = change.completedByAccountId;
  }
  const updated = await tx
    .update(staffRecoveryCase)
    .set({
      status: change.to,
      ...stamps,
      version: sql`${staffRecoveryCase.version} + 1`,
      updatedAt: change.at,
    })
    .where(
      and(
        eq(staffRecoveryCase.id, row.id),
        eq(staffRecoveryCase.status, row.status),
        eq(staffRecoveryCase.version, row.version),
      ),
    )
    .returning({ id: staffRecoveryCase.id });
  return updated.length === 1;
}
