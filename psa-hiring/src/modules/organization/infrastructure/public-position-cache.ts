import "server-only";
import { revalidateTag, unstable_cache, updateTag } from "next/cache";
import { getDatabase } from "@/shared/database";
import { getLogger } from "@/shared/logging";
import {
  findPublicCycle,
  listPublicCycles,
  listPublicLocations,
  type PublicCycleSource,
  type PublicListQuery,
} from "./organization-repository";

// Public position projection cache (ADR-0013). Only public snapshot rows
// are cached, under tags built from public references only; staff data is
// never cached. Whether a cycle is accepting is NOT cached: callers
// recompute it from these rows and the trusted server clock on every
// request, and the start-application handoff reads the database directly.

export const PUBLIC_POSITIONS_TAG = "public-positions";
export const publicPositionTag = (publicReference: string) =>
  `public-position:${publicReference}`;

/** Backstop lifetime; commits invalidate by tag immediately. */
export const PUBLIC_CACHE_SECONDS = 60;

export interface PublicPositionInvalidator {
  /** Called only after the configuration transaction committed. */
  invalidate(tags: readonly string[]): Promise<void>;
}

/**
 * Next.js adapter: `updateTag` gives read-your-own-writes inside a Server
 * Action; outside one (scripts, jobs) it throws and `revalidateTag` with
 * immediate expiry is used. A failure is logged with a safe code only;
 * the short lifetime bounds staleness and acceptance never relies on it.
 */
export const nextPublicPositionInvalidator: PublicPositionInvalidator =
  Object.freeze({
    async invalidate(tags: readonly string[]) {
      for (const tag of tags) {
        try {
          updateTag(tag);
        } catch {
          try {
            revalidateTag(tag, { expire: 0 });
          } catch {
            getLogger().warn("organization.cache_invalidation_failed", {
              module: "organization",
              resultCode: "invalidation_unavailable",
            });
          }
        }
      }
    },
  });

/** Dates survive the data cache as strings; restore them. */
function revive(row: PublicCycleSource): PublicCycleSource {
  return {
    ...row,
    opensAt: new Date(row.opensAt),
    closesAt: row.closesAt === null ? null : new Date(row.closesAt),
    openedAt: row.openedAt === null ? null : new Date(row.openedAt),
  };
}

/** Bucket the list instant to the minute so cache keys stay bounded. */
const minute = (now: Date) => Math.floor(now.getTime() / 60_000) * 60_000;

export async function cachedPublicList(
  query: PublicListQuery,
): Promise<readonly PublicCycleSource[]> {
  const bucket = minute(query.now);
  const load = unstable_cache(
    async () =>
      listPublicCycles(getDatabase(), { ...query, now: new Date(bucket) }),
    [
      "public-positions-list",
      String(bucket),
      String(query.page),
      String(query.pageSize),
      query.workerPaths ?? "-",
      query.location ?? "-",
    ],
    { tags: [PUBLIC_POSITIONS_TAG], revalidate: PUBLIC_CACHE_SECONDS },
  );
  return (await load()).map(revive);
}

export async function cachedPublicLocations(
  now: Date,
): Promise<readonly string[]> {
  const bucket = minute(now);
  const load = unstable_cache(
    async () => listPublicLocations(getDatabase(), new Date(bucket)),
    ["public-positions-locations", String(bucket)],
    { tags: [PUBLIC_POSITIONS_TAG], revalidate: PUBLIC_CACHE_SECONDS },
  );
  return load();
}

export async function cachedPublicCycle(
  publicReference: string,
): Promise<PublicCycleSource | null> {
  const load = unstable_cache(
    async () => findPublicCycle(getDatabase(), publicReference),
    ["public-position-detail", publicReference],
    {
      tags: [PUBLIC_POSITIONS_TAG, publicPositionTag(publicReference)],
      revalidate: PUBLIC_CACHE_SECONDS,
    },
  );
  const row = await load();
  return row ? revive(row) : null;
}
