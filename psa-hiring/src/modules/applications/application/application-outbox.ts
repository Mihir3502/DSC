import "server-only";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  findCandidacy,
  findPerson,
  type CandidateDependencies,
  type CandidateExecutor,
} from "@/modules/candidates";
import {
  applicationEmailSender,
  readVerifiedCandidateEmail,
} from "@/modules/identity-access";
import { outboxEvent } from "../infrastructure/applications-schema";

// Delivers the application-received email after the submission has committed
// (packet M2.6; DATA_MODEL §19.3). A delivery problem never undoes a
// submission. Each row is leased before sending, so two dispatchers can't take
// the same one; a crash while sending can repeat an email but never lose it.
// The address is read when sending, and rows and logs hold only codes.

const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;

type OutboxDependencies = Pick<
  CandidateDependencies,
  "db" | "logger" | "clock"
>;
type SendEmail = (
  to: string,
  reference: string,
  template: "APPLICATION_RECEIVED" | "APPLICATION_RETURNED",
) => Promise<void>;

export async function dispatchApplicationEmails(
  deps: OutboxDependencies,
  send: SendEmail = applicationEmailSender(),
  limit = 20,
): Promise<Readonly<{ sent: number; failed: number; retrying: number }>> {
  const now = deps.clock();
  const claimed = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.status, "PENDING"),
          lte(outboxEvent.availableAt, now),
        ),
      )
      .orderBy(asc(outboxEvent.availableAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      await tx
        .update(outboxEvent)
        .set({
          attemptCount: sql`${outboxEvent.attemptCount} + 1`,
          availableAt: new Date(now.getTime() + LEASE_MS),
        })
        .where(eq(outboxEvent.id, row.id));
    }
    return rows;
  });
  const db = deps.db as unknown as CandidateExecutor;
  const totals = { sent: 0, failed: 0, retrying: 0 };
  for (const row of claimed) {
    let problem: string | null = null;
    try {
      const candidacy = await findCandidacy(db, row.aggregateId, null);
      const person = candidacy
        ? await findPerson(db, candidacy.personId, null)
        : null;
      const to = person?.candidateAccountId
        ? await readVerifiedCandidateEmail(db, person.candidateAccountId)
        : null;
      if (!candidacy || !to) problem = "NO_VERIFIED_ADDRESS";
      else {
        await send(
          to,
          candidacy.candidateReference,
          row.eventType === "APPLICATION_RETURNED_EMAIL"
            ? "APPLICATION_RETURNED"
            : "APPLICATION_RECEIVED",
        );
      }
    } catch {
      problem = "DELIVERY_FAILED";
    }
    const attempts = row.attemptCount + 1;
    const final =
      problem === null ||
      problem === "NO_VERIFIED_ADDRESS" ||
      attempts >= MAX_ATTEMPTS;
    await deps.db
      .update(outboxEvent)
      .set({
        status: problem === null ? "SENT" : final ? "FAILED" : "PENDING",
        lastErrorCode: problem,
        processedAt: final ? deps.clock() : null,
      })
      .where(eq(outboxEvent.id, row.id));
    if (problem === null) totals.sent += 1;
    else if (final) totals.failed += 1;
    else totals.retrying += 1;
    if (problem !== null) {
      deps.logger.warn("applications.email_not_delivered", {
        module: "applications",
        resultCode: problem.toLowerCase(),
      });
    }
  }
  return totals;
}
