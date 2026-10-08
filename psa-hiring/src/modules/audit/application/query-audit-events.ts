import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/shared/database";
import {
  projectAuditEvent,
  type AuditEventView,
} from "../presentation/audit-event-view-model";
import { auditCategories, type AuditCategory } from "../domain/vocabulary";
import type { EventRecorder } from "./audit-recorder";
import { catalogEventNames, findEventDefinition } from "./event-catalog";

// Authorized internal audit query projection (packet M1.6 §16,
// AC-M1.6-11, ADR-0012). An application service only: no page, route,
// Server Action, export, or generic API calls it in M1.6.
//
// 1. Strict, allowlisted input: exactly one category, a bounded date
//    range, optional allowlisted event/outcome/target filters, a bounded
//    page size, and an opaque keyset cursor. Nothing else is accepted.
// 2. The central M1.4 authorization service (through the injected
//    authorizer port) decides with the category's permission and data
//    sensitivity and returns the caller's current audit-assignment scopes.
//    Candidates, administrators, wrong-scope, expired, and insufficient-
//    assurance callers are denied there.
// 3. Every scope bound (organization, assignment window, record-group
//    candidacies) is a SQL predicate applied before ordering, pagination,
//    and materialization. Events outside every scope are never read.
// 4. Keyset pagination on (occurred_at, id); no totals or facets.
// 5. Rows are projected to an exact view model (no integrity data, raw
//    metadata, request IDs, or internal authority references).
// 6. Recursion-safe query audit: one audit.query_executed (or
//    audit.query_denied) event is appended after the page has been read,
//    outside the transaction that read it, so the query never observes or
//    re-audits its own event and no event audits another query event.

const restrictedCategories: readonly AuditCategory[] = [
  "RESTRICTED_ACCESS",
  "SECURITY",
  "AUDIT_ACCESS",
];

export const auditQueryPermissionFor = (category: AuditCategory) =>
  restrictedCategories.includes(category)
    ? ({
        permission: "audit.restricted.read.assigned",
        sensitivity: "SECURITY_AUDIT_RESTRICTED",
      } as const)
    : ({
        permission: "audit.read.assigned",
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      } as const);

export type AuditQueryPrincipal = Readonly<{
  accountId: string;
  accountType: string;
  sessionId: string;
}>;

/** One SQL-expressible audit scope from a current audit assignment. */
export type AuditQueryScope = Readonly<{
  organizationId: string;
  recordGroupIds: readonly string[];
  from: Date;
  to: Date;
}>;

export type AuditQueryAuthorization =
  | Readonly<{
      decision: "ALLOW";
      scopes: readonly AuditQueryScope[];
      effectiveRoleCode: string | null;
    }>
  | Readonly<{
      decision: "DENY";
      reasonCode: string;
      /** True when the authorizer already recorded a high-risk denial. */
      recorded: boolean;
    }>;

export interface AuditQueryAuthorizer {
  authorize(
    principal: AuditQueryPrincipal | null,
    access: ReturnType<typeof auditQueryPermissionFor>,
    correlationId: string | undefined,
  ): Promise<AuditQueryAuthorization>;
}

/** Resolves record groups to candidacies (M2+). Fails closed until then. */
export interface AuditRecordGroupResolver {
  candidaciesIn(
    organizationId: string,
    recordGroupIds: readonly string[],
  ): Promise<readonly string[]>;
}

export const noRecordGroups: AuditRecordGroupResolver = {
  candidaciesIn: async () => [],
};

export type AuditQueryDependencies = Readonly<{
  db: Database;
  events: EventRecorder;
  authorizer: AuditQueryAuthorizer;
  recordGroups: AuditRecordGroupResolver;
}>;

export const MAX_AUDIT_PAGE = 100;
export const DEFAULT_AUDIT_PAGE = 25;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_CANDIDACIES = 1000;

export type AuditQueryInput = Readonly<{
  category: AuditCategory;
  from: Date;
  to: Date;
  eventName?: string;
  outcome?: "SUCCEEDED" | "DENIED" | "FAILED";
  targetType?: string;
  pageSize?: number;
  cursor?: string | null;
}>;

export type AuditQueryResult =
  | Readonly<{
      kind: "OK";
      items: readonly AuditEventView[];
      nextCursor: string | null;
    }>
  | Readonly<{ kind: "INVALID_QUERY" }>
  | Readonly<{ kind: "NOT_PERMITTED" }>;

const inputKeys = new Set([
  "category",
  "from",
  "to",
  "eventName",
  "outcome",
  "targetType",
  "pageSize",
  "cursor",
]);
const outcomes = new Set(["SUCCEEDED", "DENIED", "FAILED"]);
const targetTypes = new Set([
  "USER_ACCOUNT",
  "STAFF_INVITATION",
  "STAFF_RECOVERY_CASE",
  "ROLE_ASSIGNMENT",
  "AUTHORIZATION_CATALOG",
  "PROTECTED_RESOURCE",
  "AUDIT_LOG",
  "ORGANIZATION",
  "BRANCH",
  "TEAM",
  "POSITION",
  "JOB_DESCRIPTION_VERSION",
  "HIRING_CYCLE",
]);
const eventNames = new Set<string>(catalogEventNames);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Parsed = Readonly<{
  category: AuditCategory;
  from: Date;
  to: Date;
  eventName: string | null;
  outcome: string | null;
  targetType: string | null;
  pageSize: number;
  cursor: { at: Date; id: string } | null;
}>;

function parseInput(input: unknown): Parsed | null {
  if (
    typeof input !== "object" ||
    input === null ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    return null;
  }
  const r = input as Record<string, unknown>;
  if (!Object.keys(r).every((key) => inputKeys.has(key))) return null;
  if (!auditCategories.includes(r.category as AuditCategory)) return null;
  if (!(r.from instanceof Date) || !(r.to instanceof Date)) return null;
  const span = r.to.getTime() - r.from.getTime();
  if (!Number.isFinite(span) || span <= 0 || span > MAX_RANGE_MS) return null;
  const eventName = r.eventName ?? null;
  if (eventName !== null) {
    const definition =
      typeof eventName === "string" && eventNames.has(eventName)
        ? findEventDefinition(eventName)
        : null;
    if (!definition || definition.stream !== "AUDIT") return null;
  }
  const outcome = r.outcome ?? null;
  if (outcome !== null && !outcomes.has(String(outcome))) return null;
  const targetType = r.targetType ?? null;
  if (targetType !== null && !targetTypes.has(String(targetType))) return null;
  const pageSize = r.pageSize ?? DEFAULT_AUDIT_PAGE;
  if (
    typeof pageSize !== "number" ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_AUDIT_PAGE
  ) {
    return null;
  }
  let cursor: Parsed["cursor"] = null;
  if (r.cursor !== undefined && r.cursor !== null) {
    cursor = decodeCursor(r.cursor);
    if (!cursor) return null;
  }
  return {
    category: r.category as AuditCategory,
    from: r.from,
    to: r.to,
    eventName: eventName as string | null,
    outcome: outcome as string | null,
    targetType: targetType as string | null,
    pageSize,
    cursor,
  };
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(value: unknown): { at: Date; id: string } | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
    return null;
  }
  const [iso, id, extra] = Buffer.from(value, "base64url")
    .toString("utf8")
    .split("|");
  const at = new Date(iso ?? "");
  if (
    extra !== undefined ||
    !id ||
    !uuid.test(id) ||
    Number.isNaN(at.getTime())
  ) {
    return null;
  }
  return { at, id };
}

/** Builds the scope predicate; null when no scope can match anything. */
async function scopePredicate(
  scopes: readonly AuditQueryScope[],
  from: Date,
  to: Date,
  resolver: AuditRecordGroupResolver,
): Promise<SQL | null> {
  const parts: SQL[] = [];
  for (const scope of scopes) {
    if (!uuid.test(scope.organizationId)) continue;
    const start = scope.from > from ? scope.from : from;
    const end = scope.to < to ? scope.to : to;
    if (start >= end) continue;
    const candidacies = (
      await resolver.candidaciesIn(scope.organizationId, scope.recordGroupIds)
    ).filter((id) => uuid.test(id));
    if (candidacies.length === 0 || candidacies.length > MAX_CANDIDACIES) {
      continue;
    }
    parts.push(
      sql`(e.organization_id = ${scope.organizationId}::uuid AND e.occurred_at >= ${start} AND e.occurred_at < ${end} AND e.candidacy_id = ANY(${`{${candidacies.join(",")}}`}::uuid[]))`,
    );
  }
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : null;
}

export async function queryAuditEvents(
  principal: AuditQueryPrincipal | null,
  input: unknown,
  deps: AuditQueryDependencies,
  options: { correlationId?: string } = {},
): Promise<AuditQueryResult> {
  const parsed = parseInput(input);
  if (!parsed) return { kind: "INVALID_QUERY" };
  const access = auditQueryPermissionFor(parsed.category);
  const decision = await deps.authorizer.authorize(
    principal,
    access,
    options.correlationId,
  );
  if (decision.decision === "DENY") {
    if (principal && !decision.recorded) {
      await deps.events.record({
        code: "audit.query_denied",
        actorRef: principal.accountId,
        permissionCode: access.permission,
        reasonCode: decision.reasonCode,
        correlationId: options.correlationId,
      });
    }
    return { kind: "NOT_PERMITTED" };
  }
  const actor = principal!;

  const scope = await scopePredicate(
    decision.scopes,
    parsed.from,
    parsed.to,
    deps.recordGroups,
  );
  let items: AuditEventView[] = [];
  let nextCursor: string | null = null;
  if (scope) {
    const filters: SQL[] = [
      sql`e.category = ${parsed.category}`,
      sql`e.occurred_at >= ${parsed.from}`,
      sql`e.occurred_at < ${parsed.to}`,
      scope,
    ];
    if (parsed.eventName) filters.push(sql`e.event_name = ${parsed.eventName}`);
    if (parsed.outcome) filters.push(sql`e.outcome = ${parsed.outcome}`);
    if (parsed.targetType) {
      filters.push(sql`e.target_type = ${parsed.targetType}`);
    }
    if (parsed.cursor) {
      filters.push(
        sql`(e.occurred_at, e.id) > (${parsed.cursor.at}, ${parsed.cursor.id}::uuid)`,
      );
    }
    const { rows } = await deps.db.execute(
      sql`SELECT e.id, e.event_name, e.event_version, e.category, e.outcome,
                 e.actor_type, e.actor_user_id, e.effective_role_code,
                 e.effective_scope_type, e.action, e.target_type, e.target_id,
                 e.reason_code, e.correlation_id, e.occurred_at, e.metadata_json
          FROM audit.audit_event e
          WHERE ${sql.join(filters, sql` AND `)}
          ORDER BY e.occurred_at, e.id
          LIMIT ${parsed.pageSize + 1}`,
    );
    const page = rows.slice(0, parsed.pageSize);
    items = page.map((row) => projectAuditEvent(row, findEventDefinition));
    const last = items.at(-1);
    if (rows.length > parsed.pageSize && last) {
      nextCursor = encodeCursor(last.occurredAt, last.id);
    }
  }

  // Required evidence: a query whose audit event cannot be written returns
  // nothing (fail closed), never an unaudited page.
  const recorded = await deps.events.record({
    code: "audit.query_executed",
    actorRef: actor.accountId,
    permissionCode: access.permission,
    count: items.length,
    filterCodes: [
      parsed.category,
      ...(parsed.outcome ? [parsed.outcome] : []),
      ...(parsed.targetType ? [parsed.targetType] : []),
    ],
    correlationId: options.correlationId,
  });
  if (!recorded) return { kind: "NOT_PERMITTED" };
  return { kind: "OK", items, nextCursor };
}
