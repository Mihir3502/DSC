import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, max, sql } from "drizzle-orm";
import type { Database } from "@/shared/database";
import type {
  InvitationIssuerReason,
  InvitationSnapshot,
  StaffInvitationPurpose,
  StaffInvitationStatus,
} from "../domain/staff-invitation";
import { uuidPattern } from "./account-repository";
import { staffInvitation } from "./staff-identity-schema";

// Staff invitation persistence (packet M1.3 §7–§8). Only a SHA-256 digest
// of the random 256-bit capability is stored; the raw token exists in
// memory just long enough to be placed in the email link fragment. Every
// transition is a conditional, version-checked UPDATE so concurrent
// accept/revoke/resend requests cannot both succeed.

type Executor = Pick<Database, "select" | "update" | "insert">;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A fresh 256-bit capability (base64url, 43 characters). */
export function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Purpose-bound digest used for storage and lookup. */
export function digestInvitationToken(token: string): string {
  return createHash("sha256")
    .update(`staff-invitation.v1:${token}`)
    .digest("base64url");
}

export function isInvitationTokenShape(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

export type InvitationRow = InvitationSnapshot &
  Readonly<{
    id: string;
    email: string;
    emailDisplay: string;
    sequence: number;
    version: number;
  }>;

const columns = {
  id: staffInvitation.id,
  email: staffInvitation.email,
  emailDisplay: staffInvitation.emailDisplay,
  status: staffInvitation.status,
  purpose: staffInvitation.purpose,
  expiresAt: staffInvitation.expiresAt,
  accountId: staffInvitation.accountId,
  sequence: staffInvitation.sequence,
  version: staffInvitation.version,
};

function toRow(row: {
  id: string;
  email: string;
  emailDisplay: string;
  status: string;
  purpose: string;
  expiresAt: Date;
  accountId: string | null;
  sequence: number;
  version: number;
}): InvitationRow {
  return Object.freeze({
    ...row,
    status: row.status as StaffInvitationStatus,
    purpose: row.purpose as StaffInvitationPurpose,
  });
}

export async function findInvitationByDigest(
  db: Executor,
  digest: string,
  forUpdate = false,
): Promise<InvitationRow | null> {
  const query = db
    .select(columns)
    .from(staffInvitation)
    .where(eq(staffInvitation.tokenDigest, digest))
    .limit(1);
  const [row] = await (forUpdate ? query.for("update") : query);
  return row ? toRow(row) : null;
}

export async function findInvitationById(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<InvitationRow | null> {
  if (!uuidPattern.test(id)) return null;
  const query = db
    .select(columns)
    .from(staffInvitation)
    .where(eq(staffInvitation.id, id))
    .limit(1);
  const [row] = await (forUpdate ? query.for("update") : query);
  return row ? toRow(row) : null;
}

/**
 * Serializes issuance for one normalized email until the transaction ends
 * (PostgreSQL transaction-scoped advisory lock), so concurrent issue or
 * resend requests supersede each other in order instead of racing the
 * one-pending-per-email unique index.
 */
export async function lockInvitationEmail(
  tx: Pick<Database, "execute">,
  email: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-invitation:${email}`}, 0))`,
  );
}

/** The single PENDING invitation for a normalized email, locked. */
export async function lockPendingInvitationForEmail(
  tx: Executor,
  email: string,
): Promise<InvitationRow | null> {
  const [row] = await tx
    .select(columns)
    .from(staffInvitation)
    .where(
      and(
        eq(staffInvitation.email, email),
        eq(staffInvitation.status, "PENDING"),
      ),
    )
    .for("update")
    .limit(1);
  return row ? toRow(row) : null;
}

/** The PENDING invitation bound to an account (activation in progress). */
export async function findPendingInvitationForAccount(
  db: Executor,
  accountId: string,
): Promise<InvitationRow | null> {
  if (!uuidPattern.test(accountId)) return null;
  const [row] = await db
    .select(columns)
    .from(staffInvitation)
    .where(
      and(
        eq(staffInvitation.accountId, accountId),
        eq(staffInvitation.status, "PENDING"),
      ),
    )
    .limit(1);
  return row ? toRow(row) : null;
}

/** Applies one conditional terminal transition; false when it lost a race. */
export async function transitionInvitation(
  tx: Executor,
  row: Pick<InvitationRow, "id" | "version">,
  to: Exclude<StaffInvitationStatus, "PENDING">,
  at: Date,
  extra: { accountId?: string; supersededById?: string } = {},
): Promise<boolean> {
  const stamp =
    to === "ACCEPTED"
      ? { acceptedAt: at }
      : to === "REVOKED"
        ? { revokedAt: at }
        : to === "SUPERSEDED"
          ? { supersededAt: at }
          : { expiredAt: at };
  const updated = await tx
    .update(staffInvitation)
    .set({
      status: to,
      ...stamp,
      ...(extra.accountId ? { accountId: extra.accountId } : {}),
      ...(extra.supersededById ? { supersededById: extra.supersededById } : {}),
      version: sql`${staffInvitation.version} + 1`,
      updatedAt: at,
    })
    .where(
      and(
        eq(staffInvitation.id, row.id),
        eq(staffInvitation.status, "PENDING"),
        eq(staffInvitation.version, row.version),
      ),
    )
    .returning({ id: staffInvitation.id });
  return updated.length === 1;
}

/** Binds the account an activation started for (version-checked). */
export async function bindInvitationAccount(
  tx: Executor,
  row: Pick<InvitationRow, "id" | "version">,
  accountId: string,
  at: Date,
): Promise<boolean> {
  const updated = await tx
    .update(staffInvitation)
    .set({
      accountId,
      version: sql`${staffInvitation.version} + 1`,
      updatedAt: at,
    })
    .where(
      and(
        eq(staffInvitation.id, row.id),
        eq(staffInvitation.status, "PENDING"),
        eq(staffInvitation.version, row.version),
      ),
    )
    .returning({ id: staffInvitation.id });
  return updated.length === 1;
}

export type NewInvitation = Readonly<{
  email: string;
  emailDisplay: string;
  purpose: StaffInvitationPurpose;
  tokenDigest: string;
  issuerReasonCode: InvitationIssuerReason;
  issuerAccountId?: string | null;
  accountId?: string | null;
  recoveryCaseId?: string | null;
  issuedAt: Date;
  expiresAt: Date;
}>;

/** Inserts the next PENDING invitation for an email; returns its id. */
export async function insertInvitation(
  tx: Executor,
  input: NewInvitation,
): Promise<string> {
  const [previous] = await tx
    .select({ n: max(staffInvitation.sequence) })
    .from(staffInvitation)
    .where(eq(staffInvitation.email, input.email));
  const [created] = await tx
    .insert(staffInvitation)
    .values({
      email: input.email,
      emailDisplay: input.emailDisplay,
      purpose: input.purpose,
      status: "PENDING",
      tokenDigest: input.tokenDigest,
      sequence: (previous?.n ?? 0) + 1,
      accountId: input.accountId ?? null,
      issuerAccountId: input.issuerAccountId ?? null,
      issuerReasonCode: input.issuerReasonCode,
      recoveryCaseId: input.recoveryCaseId ?? null,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      createdAt: input.issuedAt,
      updatedAt: input.issuedAt,
    })
    .returning({ id: staffInvitation.id });
  return created.id;
}

/** Links a superseded invitation to its replacement (audit trail). */
export async function linkSupersededInvitation(
  tx: Executor,
  previousId: string,
  replacementId: string,
): Promise<void> {
  await tx
    .update(staffInvitation)
    .set({ supersededById: replacementId })
    .where(
      and(
        eq(staffInvitation.id, previousId),
        eq(staffInvitation.status, "SUPERSEDED"),
      ),
    );
}
