import "server-only";
import { and, desc, eq } from "drizzle-orm";
import {
  authorize,
  authorizeQueryScope,
  correlationOf,
  project,
  resolveCurrentCandidate,
  resolveCurrentStaff,
  verifyApplicationHandoff,
  type AuthorizationDependencies,
  type AuthorizationRequest,
  type Principal,
  type ProjectionContract,
} from "@/modules/identity-access";
import {
  acceptingCyclesInScope,
  cycleForCandidacy,
} from "@/modules/organization";
import {
  candidateVisibleStatus,
  decideMerge,
  isCandidacyPublicId,
  visibleStatusLabels,
  type CandidacyStage,
  type CandidacyStatus,
  type MergeSide,
} from "../domain/candidacy-policy";
import { maskEmail, maskPhone } from "../domain/normalization";
import { candidacy } from "../infrastructure/candidates-schema";
import {
  findActiveCandidacy,
  findCandidacy,
  findCandidacyByPublicId,
  findMatchByPublicId,
  findPerson,
  findPersonByAccount,
  hasOpenDuplicate,
  listOpenMatchesInScope,
  listStageHistory,
  type Executor,
} from "../infrastructure/candidates-repository";
import {
  candidateDependencies,
  type CandidateDependencies,
} from "./candidate-runtime";
import {
  candidateStartContract,
  duplicateQueueContract,
  duplicateReviewContract,
  prospectDetailContract,
  prospectFormContract,
  type CandidateStartView,
  type DuplicateReviewView,
  type ProspectDetailView,
} from "../presentation/candidate-views";

// Candidate and staff queries for M2.2 (packet M2.2 §18–§19). Each query
// resolves the server principal, authorizes through the M1 service, and
// returns one exact projection. Unknown, out-of-scope, merged-away, and
// denied references are one NOT_FOUND. Candidate views never mention
// duplicates, other people, or staff fields.

export type QueryResult<V> =
  | Readonly<{ kind: "OK"; view: V }>
  | Readonly<{
      kind: "UNAUTHENTICATED" | "NOT_FOUND" | "REAUTHENTICATION_REQUIRED";
    }>;

const silent: AuthorizationDependencies["events"] = {
  record: async () => true,
  recordInTransaction: async () => {},
};

const principalOf = (p: Principal) => ({
  accountId: p.accountId,
  accountType: p.accountType,
  sessionId: p.sessionId,
});

const db = (deps: CandidateDependencies) => deps.db as unknown as Executor;

function request(
  principal: Principal,
  permission: string,
  operation: AuthorizationRequest["operation"],
  id: string,
  reasonCode?: string,
): AuthorizationRequest {
  return {
    principal: principalOf(principal),
    permission,
    operation,
    resource: { kind: "RECORD", id, sensitivity: "CONFIDENTIAL_PERSONNEL" },
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function render<V extends object>(
  contract: ProjectionContract<V, V>,
  view: V,
  allowed: readonly string[],
  deps: AuthorizationDependencies,
): QueryResult<V> {
  const projected = project(contract, view, {
    audience: contract.audience,
    purpose: contract.purpose,
    allowed: new Set(allowed),
  });
  if (projected.kind !== "PROJECTED") {
    deps.logger.error("authz.projection_refused", {
      module: "candidates",
      action: contract.name,
      reasonCode: projected.reason,
    });
    return { kind: "NOT_FOUND" };
  }
  return { kind: "OK", view: projected.value };
}

const statusLabel = (stage: string, status: string) =>
  visibleStatusLabels[
    candidateVisibleStatus(stage as CandidacyStage, status as CandidacyStatus)
  ];

async function openingSummary(deps: CandidateDependencies, cycleId: string) {
  const found = await cycleForCandidacy(db(deps), { cycleId }, deps.clock());
  return found
    ? { title: found.cycle.publicTitle, location: found.cycle.locationLabel }
    : null;
}

// ------------------------------------------------------------- candidate

/**
 * The candidate start page: the opening named by the signed handoff (if it
 * still accepts applications), whether minimal details are still needed,
 * and the candidate's own candidacy for it (or, after a start, their most
 * recent one). Nothing about any other person or record.
 */
export async function queryCandidateStart(
  headers: Headers,
  handoffToken: string | undefined,
  options: Readonly<{ latest?: boolean }> = {},
  deps: CandidateDependencies = candidateDependencies(),
): Promise<QueryResult<CandidateStartView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const own = await authorize(
    request(
      principal,
      "candidate.candidacy.read_own",
      "READ",
      principal.accountId,
    ),
    deps,
  );
  if (own.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const ownPerson = await findPersonByAccount(
    db(deps),
    principal.accountId,
    null,
  );
  let opening: CandidateStartView["opening"] = null;
  let mine: CandidateStartView["own"] = null;
  const reference = verifyApplicationHandoff(handoffToken);
  if (reference) {
    const found = await cycleForCandidacy(
      db(deps),
      { publicReference: reference },
      deps.clock(),
    );
    if (found?.accepting) {
      opening = {
        title: found.cycle.publicTitle,
        location: found.cycle.locationLabel,
        closes: found.cycle.closesAt
          ? found.cycle.closesAt.toISOString().slice(0, 10)
          : null,
      };
      if (ownPerson) {
        const existing = await findActiveCandidacy(
          db(deps),
          ownPerson.id,
          found.cycle.id,
        );
        if (existing) {
          mine = {
            candidacyId: existing.publicId,
            reference: existing.candidateReference,
            status: statusLabel(existing.currentStage, existing.status),
            title: found.cycle.publicTitle,
          };
        }
      }
    }
  }
  if (!mine && options.latest && ownPerson) {
    const [latest] = await db(deps)
      .select()
      .from(candidacy)
      .where(
        and(
          eq(candidacy.personId, ownPerson.id),
          eq(candidacy.status, "ACTIVE"),
        ),
      )
      .orderBy(desc(candidacy.updatedAt))
      .limit(1);
    if (latest) {
      const summary = await openingSummary(deps, latest.hiringCycleId);
      mine = {
        candidacyId: latest.publicId,
        reference: latest.candidateReference,
        status: statusLabel(latest.currentStage, latest.status),
        title: summary?.title ?? "",
      };
    }
  }
  return render(
    candidateStartContract,
    { opening, needsPersonDetails: ownPerson === null, own: mine },
    ["candidate.candidacy.read_own"],
    deps,
  );
}

// ------------------------------------------------------------------ staff

async function staff(headers: Headers) {
  return resolveCurrentStaff(headers);
}

/** Accepting openings in the staff member's prospect scope. */
export async function queryProspectForm(
  headers: Headers,
  deps: CandidateDependencies = candidateDependencies(),
) {
  const principal = await staff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" } as const;
  const scope = await authorizeQueryScope(
    {
      principal: principalOf(principal),
      permission: "candidate.prospect.read",
      operation: "READ",
      sensitivity: "CONFIDENTIAL_PERSONNEL",
      ...(correlationOf(headers)
        ? { correlationId: correlationOf(headers)! }
        : {}),
    },
    deps,
  );
  if (scope.decision !== "ALLOW") return { kind: "NOT_FOUND" } as const;
  const openings = await acceptingCyclesInScope(
    db(deps),
    scope.constraint,
    deps.clock(),
  );
  return render(
    prospectFormContract,
    {
      openings: openings.map((o) => ({
        reference: o.publicReference,
        title: o.publicTitle,
        location: o.locationLabel,
        closes: o.closesAt ? o.closesAt.toISOString().slice(0, 10) : null,
      })),
    },
    ["candidate.prospect.read"],
    deps,
  );
}

const stageLabels = {
  PROSPECT: "Prospect",
  APPLICATION_INCOMPLETE: "Application incomplete",
} as const;

/** Bounded prospect/candidacy detail (not the M3 workspace). */
export async function queryProspectDetail(
  headers: Headers,
  candidacyId: string,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<QueryResult<ProspectDetailView>> {
  const principal = await staff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (!isCandidacyPublicId(candidacyId)) return { kind: "NOT_FOUND" };
  const row = await findCandidacyByPublicId(db(deps), candidacyId, null);
  if (!row) return { kind: "NOT_FOUND" };
  const allowed = await authorize(
    request(principal, "candidate.prospect.read", "READ", row.id),
    deps,
  );
  if (allowed.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const who = await findPerson(db(deps), row.personId, null);
  if (!who) return { kind: "NOT_FOUND" };
  const summary = await openingSummary(deps, row.hiringCycleId);
  const history = await listStageHistory(db(deps), row.id);
  const probe = { ...deps, events: silent };
  const actions: string[] = [];
  for (const [permission, operation, reason] of [
    ["candidate.prospect.create", "CREATE", undefined],
    ["candidate.prospect.close", "EDIT", "NOT_INTERESTED"],
    ["candidate.owner.assign", "EDIT", "WORKLOAD_BALANCE"],
  ] as const) {
    const decision = await authorize(
      request(principal, permission, operation, row.id, reason),
      probe,
    );
    if (decision.decision === "ALLOW")
      actions.push(permission.replace("candidate.", "").replace(".", "_"));
  }
  return render(
    prospectDetailContract,
    {
      id: row.publicId,
      reference: row.candidateReference,
      displayName: [
        who.preferredName ?? who.legalFirstName,
        who.legalLastName,
      ].join(" "),
      email: who.emailDisplay,
      phone: who.phoneDisplay,
      opening: summary ? `${summary.title} · ${summary.location}` : "",
      stage: stageLabels[row.currentStage as keyof typeof stageLabels],
      status: row.status === "ACTIVE" ? "Active" : "Closed",
      source:
        row.sourceCode === "STAFF_ENTERED"
          ? "Staff entered"
          : "Candidate self-service",
      owner:
        row.ownerAccountId === null
          ? "Unassigned"
          : row.ownerAccountId === principal.accountId
            ? "You"
            : "Another staff member",
      possibleDuplicate: await hasOpenDuplicate(
        db(deps),
        row.personId,
        row.organizationId,
      ),
      history: history.map((h) => ({
        stage: stageLabels[h.toStage as keyof typeof stageLabels] ?? h.toStage,
        occurredAt: h.occurredAt.toISOString(),
        command: h.commandCode.replaceAll("_", " "),
      })),
      version: row.version,
      actions,
    },
    ["candidate.prospect.read"],
    deps,
  );
}

/**
 * Open duplicate cases the reviewer may decide (no PII). List-scope
 * authorization supports READ only, so the organizations come from the
 * reviewer's prospect-read scope and each one is authorized for
 * candidate.duplicate.review (REVIEW, recent step-up) explicitly; every
 * row is then rechecked on its own record.
 */
export async function queryDuplicateQueue(
  headers: Headers,
  deps: CandidateDependencies = candidateDependencies(),
) {
  const principal = await staff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" } as const;
  const scope = await authorizeQueryScope(
    {
      principal: principalOf(principal),
      permission: "candidate.prospect.read",
      operation: "READ",
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    },
    { ...deps, events: silent },
  );
  if (scope.decision !== "ALLOW" || scope.constraint.kind !== "SCOPES") {
    return { kind: "NOT_FOUND" } as const;
  }
  const organizations = [
    ...new Set(scope.constraint.scopes.map((s) => s.organizationId)),
  ];
  const allowed: string[] = [];
  let stepUp = false;
  for (const organizationId of organizations) {
    const decision = await authorize(
      {
        principal: principalOf(principal),
        permission: "candidate.duplicate.review",
        operation: "REVIEW",
        resource: {
          kind: "SCOPE",
          scopeType: "ORGANIZATION",
          id: organizationId,
          sensitivity: "CONFIDENTIAL_PERSONNEL",
        },
        reasonCode: "DUPLICATE_REVIEW",
      },
      { ...deps, events: silent },
    );
    if (decision.decision === "ALLOW") allowed.push(organizationId);
    else if (decision.reasonCode === "RECENT_AUTH_REQUIRED") stepUp = true;
  }
  if (allowed.length === 0) {
    return stepUp
      ? ({ kind: "REAUTHENTICATION_REQUIRED" } as const)
      : ({ kind: "NOT_FOUND" } as const);
  }
  const rows = await listOpenMatchesInScope(db(deps), {
    kind: "SCOPES",
    scopes: allowed.map((organizationId) => ({
      type: "ORGANIZATION" as const,
      organizationId,
    })),
    excludeSubjectAccountId: principal.accountId,
  });
  const cases = [];
  for (const row of rows) {
    const recheck = await authorize(
      request(
        principal,
        "candidate.duplicate.review",
        "REVIEW",
        row.id,
        "DUPLICATE_REVIEW",
      ),
      { ...deps, events: silent },
    );
    if (recheck.decision === "ALLOW") cases.push(row);
  }
  return render(
    duplicateQueueContract,
    {
      cases: cases.map((c) => ({
        id: c.publicId,
        tier: c.confidenceTier as "HIGH" | "MEDIUM",
        status:
          c.status === "PENDING"
            ? ("Pending review" as const)
            : ("Confirmed duplicate" as const),
        created: c.createdAt.toISOString().slice(0, 10),
      })),
    },
    ["candidate.duplicate.review"],
    deps,
  );
}

/** The minimal side-by-side review projection (recent step-up required). */
export async function queryDuplicateReview(
  headers: Headers,
  matchId: string,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<QueryResult<DuplicateReviewView>> {
  const principal = await staff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (!isCandidacyPublicId(matchId)) return { kind: "NOT_FOUND" };
  const match = await findMatchByPublicId(db(deps), matchId, null);
  if (!match) return { kind: "NOT_FOUND" };
  const decision = await authorize(
    request(
      principal,
      "candidate.duplicate.review",
      "REVIEW",
      match.id,
      "DUPLICATE_REVIEW",
    ),
    deps,
  );
  if (decision.decision !== "ALLOW") {
    return decision.reasonCode === "RECENT_AUTH_REQUIRED"
      ? { kind: "REAUTHENTICATION_REQUIRED" }
      : { kind: "NOT_FOUND" };
  }
  const people = await Promise.all([
    findPerson(db(deps), match.personAId, null),
    findPerson(db(deps), match.personBId, null),
  ]);
  if (!people[0] || !people[1]) return { kind: "NOT_FOUND" };
  const rows = await db(deps)
    .select()
    .from(candidacy)
    .where(eq(candidacy.organizationId, match.organizationId));
  const sides: MergeSide[] = [];
  const views = people.map((p) => {
    const own = rows.filter((c) => c.personId === p!.id);
    sides.push({
      personId: p!.id,
      status: p!.status as MergeSide["status"],
      candidateAccountId: p!.candidateAccountId,
      createdAt: p!.createdAt,
      activeCycleIds: own
        .filter((c) => c.status === "ACTIVE")
        .map((c) => c.hiringCycleId),
    });
    return {
      displayName: [
        p!.preferredName ?? p!.legalFirstName,
        p!.legalLastName,
      ].join(" "),
      email: maskEmail(p!.emailNormalized),
      phone: p!.phoneDisplay
        ? maskPhone(p!.phoneE164 ?? p!.phoneDisplay)
        : null,
      candidateAccountLinked: p!.candidateAccountId !== null,
      candidacies: own.slice(0, 20).map((c) => ({
        reference: c.candidateReference,
        stage:
          stageLabels[c.currentStage as keyof typeof stageLabels] ??
          c.currentStage,
        status: c.status === "ACTIVE" ? "Active" : "Closed",
      })),
    };
  });
  const preview = decideMerge("CONFIRMED_DUPLICATE", sides[0]!, sides[1]!);
  const merge = await authorize(
    request(
      principal,
      "candidate.person.merge",
      "APPROVE",
      match.id,
      "CONFIRMED_DUPLICATE_RECORD",
    ),
    { ...deps, events: silent },
  );
  return render(
    duplicateReviewContract,
    {
      id: match.publicId,
      version: match.version,
      status: match.status as DuplicateReviewView["status"],
      tier: match.confidenceTier as "HIGH" | "MEDIUM",
      signals: match.signalCodes as ("EXACT_EMAIL" | "EXACT_PHONE")[],
      ruleset: match.rulesetVersion,
      first: views[0]!,
      second: views[1]!,
      mergeBlocker:
        preview.kind === "BLOCKED" &&
        preview.reason !== "BLOCKED_CASE_NOT_CONFIRMED"
          ? preview.reason
          : null,
      actions: [
        ...(match.status === "PENDING" ? ["review"] : []),
        ...(match.status === "CONFIRMED_DUPLICATE" && merge.decision === "ALLOW"
          ? ["merge"]
          : []),
      ],
    },
    ["candidate.duplicate.review"],
    deps,
  );
}

/**
 * The staff detail path for a candidacy a command just returned (internal
 * id → route public id), only when the principal may read it. Used after a
 * create so the browser never sees the internal identifier.
 */
export async function queryCandidacyPath(
  headers: Headers,
  targetId: string,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<string | null> {
  const principal = await staff(headers);
  if (!principal) return null;
  const row = await findCandidacy(db(deps), targetId, null);
  if (!row) return null;
  const allowed = await authorize(
    request(principal, "candidate.prospect.read", "READ", row.id),
    { ...deps, events: silent },
  );
  return allowed.decision === "ALLOW"
    ? `/staff/candidates/${row.publicId}`
    : null;
}
