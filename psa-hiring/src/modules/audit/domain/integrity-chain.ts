import { createHash } from "node:crypto";
import {
  GLOBAL_PARTITION_BUCKETS,
  partitionPattern,
  type EventStream,
} from "./vocabulary";

// Server-owned chain partitioning (packet M1.6 §12.2, ADR-0012). A
// partition is never accepted from a caller: it is derived from the
// envelope. Organization-bound events (M2+) chain per organization;
// pre-organization identity and security events spread over a fixed set
// of global buckets keyed by their opaque subject, so one global chain
// head is never a single hot lock and no fake organization is created.

export function chainPartitionFor(
  stream: EventStream,
  organizationId: string | null,
  subjectId: string | null,
): string {
  if (stream === "AUDIT" && organizationId) {
    return assertPartition(`ORG:${organizationId}`);
  }
  const prefix = stream === "AUDIT" ? "IDENTITY" : "SECURITY";
  const bucket = subjectId
    ? createHash("sha256").update(subjectId).digest()[0] %
      GLOBAL_PARTITION_BUCKETS
    : 0;
  return assertPartition(`${prefix}:${bucket.toString(16).padStart(2, "0")}`);
}

function assertPartition(partition: string): string {
  if (!partitionPattern.test(partition)) {
    throw new Error("invalid chain partition");
  }
  return partition;
}
