import {
  designations,
  holdCategories,
  participantRelationships,
  type Designation,
  type HoldCategory,
  type ParticipantRelationship,
} from "./authorization-vocabulary";

// Closed, declarative role-permission conditions (packet M1.4 §8.3). A
// condition narrows a grant; it is data, never an executable expression.
// Unknown kinds, unknown keys, and unknown versions are rejected, and a
// rejected condition makes the grant unusable (fail closed).

export type GrantCondition =
  | Readonly<{ v: 1; kind: "CANDIDATE_OWNERSHIP" }>
  | Readonly<{ v: 1; kind: "DESIGNATION"; designation: Designation }>
  | Readonly<{
      v: 1;
      kind: "PARTICIPANT";
      relationship: ParticipantRelationship;
    }>
  | Readonly<{
      v: 1;
      kind: "HOLD_CATEGORY";
      categories: readonly HoldCategory[];
    }>;

const allowedKeys: Record<GrantCondition["kind"], readonly string[]> = {
  CANDIDATE_OWNERSHIP: ["v", "kind"],
  DESIGNATION: ["v", "kind", "designation"],
  PARTICIPANT: ["v", "kind", "relationship"],
  HOLD_CATEGORY: ["v", "kind", "categories"],
};

const includes = <T extends string>(values: readonly T[], value: unknown) =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/**
 * Parses stored condition data. Returns `null` for "no condition",
 * `"INVALID"` for anything malformed, unknown, or unsupported.
 */
export function parseGrantCondition(
  value: unknown,
): GrantCondition | null | "INVALID" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "INVALID";
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return "INVALID";
  const kind = record.kind;
  if (typeof kind !== "string" || !Object.hasOwn(allowedKeys, kind)) {
    return "INVALID";
  }
  const keys = allowedKeys[kind as GrantCondition["kind"]];
  if (Object.keys(record).some((key) => !keys.includes(key))) return "INVALID";
  switch (kind) {
    case "CANDIDATE_OWNERSHIP":
      return Object.freeze({ v: 1, kind });
    case "DESIGNATION":
      return includes(designations, record.designation)
        ? Object.freeze({
            v: 1,
            kind,
            designation: record.designation as Designation,
          })
        : "INVALID";
    case "PARTICIPANT":
      return includes(participantRelationships, record.relationship)
        ? Object.freeze({
            v: 1,
            kind,
            relationship: record.relationship as ParticipantRelationship,
          })
        : "INVALID";
    case "HOLD_CATEGORY": {
      const categories = record.categories;
      if (
        !Array.isArray(categories) ||
        categories.length === 0 ||
        new Set(categories).size !== categories.length ||
        !categories.every((c) => includes(holdCategories, c))
      ) {
        return "INVALID";
      }
      return Object.freeze({
        v: 1,
        kind,
        categories: Object.freeze([...categories]) as readonly HoldCategory[],
      });
    }
    default:
      return "INVALID";
  }
}

/** Canonical JSON form used for storage and drift comparison. */
export function canonicalCondition(condition: GrantCondition | null): string {
  if (!condition) return "null";
  switch (condition.kind) {
    case "CANDIDATE_OWNERSHIP":
      return JSON.stringify({ v: 1, kind: condition.kind });
    case "DESIGNATION":
      return JSON.stringify({
        v: 1,
        kind: condition.kind,
        designation: condition.designation,
      });
    case "PARTICIPANT":
      return JSON.stringify({
        v: 1,
        kind: condition.kind,
        relationship: condition.relationship,
      });
    case "HOLD_CATEGORY":
      return JSON.stringify({
        v: 1,
        kind: condition.kind,
        categories: [...condition.categories].sort(),
      });
  }
}
