import "server-only";
import type { DenyDecision } from "../domain/authorization-decision";
import type {
  ScopeType,
  SensitivityLevel,
} from "../domain/authorization-vocabulary";
import type { Principal } from "./current-account";
import {
  authorize,
  authorizeQueryScope,
  type AuthorizationDependencies,
  type QueryConstraint,
  type ScopeConstraint,
} from "./authorize";

// Reusable scoped list/search contract (packet M1.5 §14, ADR-0011). No
// production list/search exists in M1; later modules implement
// ScopedListSource for their own tables. The sequence is fixed:
//
// 1. Parse bounded, allowlisted list input. Unknown keys, filters, sorts,
//    field selections, projections, permissions, or scopes reject; nothing
//    falls back to a broad query.
// 2. authorizeQueryScope() turns current assignments into typed scope
//    constraints (or the candidate's own-account binding).
// 3. An optional scope selector may only narrow those constraints.
// 4. The source applies the constraints as SQL predicates BEFORE ordering,
//    pagination, or materialization, and selects only list-safe columns.
// 5. Every returned row is rechecked with authorize(); a row that fails
//    is dropped (and counted for telemetry), never returned.
// 6. No totals, facets, or counts are returned, so pagination cannot
//    reveal out-of-scope records.

const silentRowRecheck: AuthorizationDependencies["events"] = {
  record: async () => true,
  recordInTransaction: async () => {},
};

export type ListQuerySpec = Readonly<{
  maxPageSize: number;
  defaultPageSize: number;
  sorts: readonly string[];
  defaultSort: string;
  /** Allowlisted filters with bounded validators. */
  filters: Readonly<Record<string, (value: unknown) => boolean>>;
  maxSearchLength: number;
}>;

export type ListQuery = Readonly<{
  pageSize: number;
  cursor: string | null;
  sort: string;
  filters: Readonly<Record<string, string>>;
  search: string | null;
}>;

export type ListQueryRejection =
  | "UNKNOWN_KEY"
  | "UNKNOWN_FILTER"
  | "INVALID_FILTER"
  | "UNKNOWN_SORT"
  | "INVALID_PAGE_SIZE"
  | "INVALID_CURSOR"
  | "SEARCH_TOO_LONG";

const listKeys = new Set(["pageSize", "cursor", "sort", "filters", "search"]);
const cursorPattern = /^[A-Za-z0-9_-]{1,128}$/;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

export function parseListQuery(
  input: unknown,
  spec: ListQuerySpec,
):
  | Readonly<{ kind: "ACCEPTED"; query: ListQuery }>
  | Readonly<{ kind: "REJECTED"; reason: ListQueryRejection }> {
  const reject = (reason: ListQueryRejection) =>
    ({ kind: "REJECTED", reason }) as const;
  if (input === undefined) input = {};
  if (!isPlain(input)) return reject("UNKNOWN_KEY");
  if (!Object.keys(input).every((k) => listKeys.has(k))) {
    return reject("UNKNOWN_KEY");
  }
  const pageSize = input.pageSize ?? spec.defaultPageSize;
  if (
    typeof pageSize !== "number" ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > spec.maxPageSize
  ) {
    return reject("INVALID_PAGE_SIZE");
  }
  const cursor = input.cursor ?? null;
  if (
    cursor !== null &&
    (typeof cursor !== "string" || !cursorPattern.test(cursor))
  ) {
    return reject("INVALID_CURSOR");
  }
  const sort = input.sort ?? spec.defaultSort;
  if (typeof sort !== "string" || !spec.sorts.includes(sort)) {
    return reject("UNKNOWN_SORT");
  }
  const filters: Record<string, string> = {};
  const rawFilters = input.filters ?? {};
  if (!isPlain(rawFilters)) return reject("UNKNOWN_FILTER");
  for (const [name, value] of Object.entries(rawFilters)) {
    if (!Object.hasOwn(spec.filters, name)) return reject("UNKNOWN_FILTER");
    if (typeof value !== "string" || !spec.filters[name](value)) {
      return reject("INVALID_FILTER");
    }
    filters[name] = value;
  }
  const search = input.search ?? null;
  if (search !== null) {
    if (
      typeof search !== "string" ||
      search.length > spec.maxSearchLength ||
      controlCharacters.test(search)
    ) {
      return reject("SEARCH_TOO_LONG");
    }
  }
  return {
    kind: "ACCEPTED",
    query: Object.freeze({
      pageSize,
      cursor,
      sort,
      filters: Object.freeze(filters),
      search: search === null || search.trim() === "" ? null : search.trim(),
    }),
  };
}

/** A browser-selected scope that may only narrow current authority. */
export type ScopeSelection = Readonly<{ type: ScopeType; id: string }>;

function selects(scope: ScopeConstraint, selection: ScopeSelection): boolean {
  switch (scope.type) {
    case "ORGANIZATION":
      return (
        selection.type === "ORGANIZATION" &&
        scope.organizationId === selection.id
      );
    case "BRANCH":
      return selection.type === "BRANCH" && scope.branchId === selection.id;
    case "TEAM":
      return selection.type === "TEAM" && scope.teamId === selection.id;
    case "ASSIGNED_RECORDS":
      return (
        selection.type === "ASSIGNED_RECORDS" &&
        scope.assignmentSetId === selection.id
      );
    case "AUDIT_ASSIGNMENT":
      return false;
  }
}

/**
 * Intersects the constraint with a selection. The result is always a
 * subset of the authorized scopes; a selection outside them yields null
 * (treated exactly like "no authority"), never a wider query.
 */
export function narrowConstraint(
  constraint: QueryConstraint,
  selection: ScopeSelection | null,
): QueryConstraint | null {
  if (!selection) return constraint;
  if (constraint.kind === "OWNER") return null;
  const scopes = constraint.scopes.filter((s) => selects(s, selection));
  return scopes.length > 0 ? { ...constraint, scopes } : null;
}

/** A list row: an opaque ID plus its classification, for the recheck. */
export type ScopedRow = Readonly<{ id: string; sensitivity: SensitivityLevel }>;

/** Implemented by the owning module's repository (never generic). */
export interface ScopedListSource<R extends ScopedRow> {
  /** Must apply `constraint` in SQL before ordering/limit/materialization. */
  list(
    constraint: QueryConstraint,
    query: ListQuery,
  ): Promise<Readonly<{ rows: readonly R[]; nextCursor: string | null }>>;
}

export type ScopedListRequest = Readonly<{
  principal: Principal | null;
  permission: string;
  sensitivity: SensitivityLevel;
  input: unknown;
  selection?: ScopeSelection | null;
  /** Server-chosen safe purpose for permissions that require one. */
  purposeCode?: string;
  correlationId?: string;
}>;

export type ScopedListResult<R> =
  | Readonly<{
      kind: "LISTED";
      rows: readonly R[];
      nextCursor: string | null;
      /** Rows the SQL returned but the recheck refused (telemetry only). */
      refused: number;
    }>
  | Readonly<{ kind: "INVALID_INPUT"; reason: ListQueryRejection }>
  | Readonly<{ kind: "DENIED"; decision: DenyDecision | null }>;

export async function authorizeScopedList<R extends ScopedRow>(
  request: ScopedListRequest,
  source: ScopedListSource<R>,
  spec: ListQuerySpec,
  deps: AuthorizationDependencies,
): Promise<ScopedListResult<R>> {
  const parsed = parseListQuery(request.input, spec);
  if (parsed.kind === "REJECTED") {
    return { kind: "INVALID_INPUT", reason: parsed.reason };
  }
  const principal = request.principal
    ? {
        accountId: request.principal.accountId,
        accountType: request.principal.accountType,
        sessionId: request.principal.sessionId,
      }
    : null;
  const scope = await authorizeQueryScope(
    {
      principal,
      permission: request.permission,
      operation: "READ",
      sensitivity: request.sensitivity,
      ...(request.purposeCode ? { reasonCode: request.purposeCode } : {}),
      ...(request.correlationId
        ? { correlationId: request.correlationId }
        : {}),
    },
    deps,
  );
  if (scope.decision === "DENY") return { kind: "DENIED", decision: scope };
  const constraint = narrowConstraint(
    scope.constraint,
    request.selection ?? null,
  );
  if (!constraint) return { kind: "DENIED", decision: null };

  const page = await source.list(constraint, parsed.query);
  const rows: R[] = [];
  let refused = 0;
  // The list decision above already produced its own (single) evidence.
  // Per-row rechecks only drop rows; their refusals are summarized in one
  // telemetry line below instead of one durable event per row.
  const rowDeps = { ...deps, events: silentRowRecheck };
  for (const row of page.rows) {
    const recheck = await authorize(
      {
        principal,
        permission: request.permission,
        operation: "READ",
        resource: { kind: "RECORD", id: row.id, sensitivity: row.sensitivity },
        ...(request.purposeCode ? { reasonCode: request.purposeCode } : {}),
        ...(request.correlationId
          ? { correlationId: request.correlationId }
          : {}),
      },
      rowDeps,
    );
    if (recheck.decision === "ALLOW") rows.push(row);
    else refused += 1;
  }
  if (refused > 0) {
    deps.logger.warn("authz.list_rows_refused", {
      module: "authz",
      action: scope.permissionCode,
      resultCode: "rows_refused",
      policyVersion: scope.policyVersion,
      correlationId: request.correlationId,
    });
  }
  return { kind: "LISTED", rows, nextCursor: page.nextCursor, refused };
}
