import { sql } from "drizzle-orm";
import {
  closeDatabasePool,
  getDatabase,
  systemMetadata,
} from "../../src/shared/database";
import { runScript } from "./lib/tooling";

// Idempotent technical seed through the least-privileged application role.
// Writes one deterministic, non-secret record. No people, accounts, or
// business data.

const foundationSeed = {
  key: "foundation.seed",
  value: {
    schemaVersion: 1,
    foundation: "M0.3",
    purpose: "database foundation",
  },
};

void runScript("db:seed", async () => {
  try {
    const db = getDatabase();
    const [row] = await db
      .insert(systemMetadata)
      .values(foundationSeed)
      .onConflictDoUpdate({
        target: systemMetadata.key,
        set: { value: foundationSeed.value, updatedAt: sql`now()` },
      })
      .returning({
        key: systemMetadata.key,
        inserted: sql<boolean>`(xmax = 0)`,
      });
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(systemMetadata);
    console.log(
      `Seed ${row.inserted ? "inserted" : "updated"}: ${row.key} (${count} metadata row${count === 1 ? "" : "s"} total)`,
    );
  } finally {
    await closeDatabasePool();
  }
});
