import "server-only";
import { getDatabase } from "@/shared/database";
import {
  issueApplicationHandoff,
  resolveCurrentCandidate,
  verifyApplicationHandoff,
} from "@/modules/identity-access";
import { effectiveAvailability } from "../domain/lifecycle";
import {
  isPublicReference,
  isWorkerPaths,
  type WorkerPaths,
} from "../domain/values";
import {
  findPublicCycle,
  type PublicCycleSource,
  type PublicListQuery,
} from "../infrastructure/organization-repository";
import {
  cachedPublicCycle,
  cachedPublicList,
  cachedPublicLocations,
} from "../infrastructure/public-position-cache";
import {
  publicDetail,
  publicListItem,
  type PublicPositionDetail,
  type PublicPositionListItem,
} from "../presentation/public-position-view";

// Public position list/detail and the start-application handoff (packet
// M2.1 §17–§19). Public callers never authenticate here and never reach
// staff projections. Every response is computed from public snapshot rows
// and the trusted server clock at request time: a cached row is
// re-evaluated, so a cycle stops accepting at exactly closes_at even if no
// close command or cache refresh has happened. Unknown, malformed, draft,
// published-not-open, cancelled, archived, and never-opened references are
// one indistinguishable NOT_FOUND.

export type PublicPositionSource = Readonly<{
  list(query: PublicListQuery): Promise<readonly PublicCycleSource[]>;
  locations(now: Date): Promise<readonly string[]>;
  detail(publicReference: string): Promise<PublicCycleSource | null>;
}>;

export type PublicDependencies = Readonly<{
  source: PublicPositionSource;
  /** Uncached reads for decisions (handoff issue and revalidation). */
  live: (publicReference: string) => Promise<PublicCycleSource | null>;
  clock: () => Date;
}>;

export function publicDependencies(
  overrides: Partial<PublicDependencies> = {},
): PublicDependencies {
  return {
    source: {
      list: cachedPublicList,
      locations: cachedPublicLocations,
      detail: cachedPublicCycle,
    },
    live: (ref) => findPublicCycle(getDatabase(), ref),
    clock: () => new Date(),
    ...overrides,
  };
}

const PAGE_SIZE = 20;
const MAX_PAGE = 50;
const listKeys = new Set(["page", "location", "type"]);

export type PublicListView = Readonly<{
  items: readonly PublicPositionListItem[];
  page: number;
  hasNext: boolean;
  locations: readonly string[];
  filters: Readonly<{ location: string | null; type: WorkerPaths | null }>;
}>;

export type PublicListResult =
  | Readonly<{ kind: "OK"; view: PublicListView }>
  /** Unknown, repeated, or out-of-range parameters (never echoed). */
  | Readonly<{ kind: "INVALID_FILTER" }>;

function single(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= 120 ? value : null;
}

/**
 * The currently accepting openings. Parameters are allowlisted and
 * bounded; a location filter must equal a currently listed public label.
 */
export async function queryPublicPositions(
  params: Readonly<Record<string, string | string[] | undefined>>,
  deps: PublicDependencies = publicDependencies(),
): Promise<PublicListResult> {
  for (const key of Object.keys(params)) {
    if (!listKeys.has(key)) return { kind: "INVALID_FILTER" };
  }
  const now = deps.clock();
  const page = single(params.page);
  const location = single(params.location);
  const type = single(params.type);
  if (page === null || location === null || type === null) {
    return { kind: "INVALID_FILTER" };
  }
  const pageNumber = page === undefined ? 1 : Number(page);
  if (
    !/^\d{1,2}$/.test(page ?? "1") ||
    pageNumber < 1 ||
    pageNumber > MAX_PAGE
  ) {
    return { kind: "INVALID_FILTER" };
  }
  if (type !== undefined && !isWorkerPaths(type))
    return { kind: "INVALID_FILTER" };
  const locations = await deps.source.locations(now);
  if (location !== undefined && !locations.includes(location)) {
    return { kind: "INVALID_FILTER" };
  }
  const rows = await deps.source.list({
    now,
    page: pageNumber,
    pageSize: PAGE_SIZE,
    workerPaths: (type as WorkerPaths | undefined) ?? null,
    location: location ?? null,
  });
  // Re-evaluate cached rows against the real clock (exclusive close).
  const accepting = rows.filter(
    (row) =>
      effectiveAvailability(
        {
          status: row.status,
          opensAt: row.opensAt,
          closesAt: row.closesAt,
          openEnded: row.closesAt === null,
          everOpened: row.openedAt !== null,
          parentsActive: row.parentsActive,
        },
        now,
      ) === "ACCEPTING",
  );
  return {
    kind: "OK",
    view: {
      items: accepting.slice(0, PAGE_SIZE).map((row) => publicListItem(row)),
      page: pageNumber,
      hasNext: rows.length > PAGE_SIZE,
      locations,
      filters: {
        location: location ?? null,
        type: (type as WorkerPaths | undefined) ?? null,
      },
    },
  };
}

export type PublicDetailResult =
  | Readonly<{ kind: "FOUND"; view: PublicPositionDetail }>
  | Readonly<{ kind: "NOT_FOUND" }>;

function availabilityOf(row: PublicCycleSource, now: Date) {
  return effectiveAvailability(
    {
      status: row.status,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      openEnded: row.closesAt === null,
      everOpened: row.openedAt !== null,
      parentsActive: row.parentsActive,
    },
    now,
  );
}

/** One opening's public detail, or the indistinguishable NOT_FOUND. */
export async function queryPublicPosition(
  reference: unknown,
  deps: PublicDependencies = publicDependencies(),
): Promise<PublicDetailResult> {
  if (!isPublicReference(reference)) return { kind: "NOT_FOUND" };
  const row = await deps.source.detail(reference);
  if (!row) return { kind: "NOT_FOUND" };
  const availability = availabilityOf(row, deps.clock());
  if (availability === "NOT_PUBLIC") return { kind: "NOT_FOUND" };
  return { kind: "FOUND", view: publicDetail(row, availability) };
}

// ------------------------------------------------- start-application handoff

export type HandoffStart =
  | Readonly<{
      kind: "ISSUED";
      token: string;
      /** A registered destination: the M2.2 boundary or candidate sign-in. */
      destination:
        "/candidate/applications/new" | "/sign-in?next=APPLICATION_START";
    }>
  | Readonly<{ kind: "NOT_AVAILABLE" }>;

/**
 * Validates (uncached) that the opening is accepting now and issues the
 * signed handoff. Creates no person, candidacy, or application.
 */
export async function beginApplicationHandoff(
  reference: unknown,
  headers: Headers,
  deps: PublicDependencies = publicDependencies(),
): Promise<HandoffStart> {
  if (!isPublicReference(reference)) return { kind: "NOT_AVAILABLE" };
  const row = await deps.live(reference);
  if (!row || availabilityOf(row, deps.clock()) !== "ACCEPTING") {
    return { kind: "NOT_AVAILABLE" };
  }
  const candidate = await resolveCurrentCandidate(headers);
  return {
    kind: "ISSUED",
    token: issueApplicationHandoff(reference),
    destination: candidate
      ? "/candidate/applications/new"
      : "/sign-in?next=APPLICATION_START",
  };
}

/** Public detail of an opening confirmed for the handoff page (uncached). */
export async function queryHandoffOpening(
  reference: unknown,
  deps: PublicDependencies = publicDependencies(),
): Promise<PublicDetailResult> {
  if (!isPublicReference(reference)) return { kind: "NOT_FOUND" };
  const row = await deps.live(reference);
  if (!row) return { kind: "NOT_FOUND" };
  const availability = availabilityOf(row, deps.clock());
  if (availability === "NOT_PUBLIC") return { kind: "NOT_FOUND" };
  return { kind: "FOUND", view: publicDetail(row, availability) };
}

export type HandoffConfirmation =
  | Readonly<{ kind: "UNAUTHENTICATED" }>
  | Readonly<{ kind: "NONE" }>
  | Readonly<{
      kind: "CONFIRMED";
      title: string;
      location: string;
      closes: string | null;
    }>
  /** Tampered, expired, wrong-purpose, closed, or cancelled: one result. */
  | Readonly<{ kind: "NOT_AVAILABLE" }>;

/**
 * The M2.2 boundary: a verified candidate with a valid handoff whose
 * opening is still accepting (re-checked uncached). Read-only: it creates
 * no person, candidacy, application, or ownership record.
 */
export async function confirmApplicationHandoff(
  headers: Headers,
  token: string | undefined,
  deps: PublicDependencies = publicDependencies(),
): Promise<HandoffConfirmation> {
  const candidate = await resolveCurrentCandidate(headers);
  if (!candidate) return { kind: "UNAUTHENTICATED" };
  if (token === undefined) return { kind: "NONE" };
  const reference = verifyApplicationHandoff(token);
  if (!reference) return { kind: "NOT_AVAILABLE" };
  const row = await deps.live(reference);
  if (!row || availabilityOf(row, deps.clock()) !== "ACCEPTING") {
    return { kind: "NOT_AVAILABLE" };
  }
  const view = publicDetail(row, "ACCEPTING");
  if (view.availability !== "ACCEPTING") return { kind: "NOT_AVAILABLE" };
  return {
    kind: "CONFIRMED",
    title: view.title,
    location: view.location,
    closes: view.closes,
  };
}
