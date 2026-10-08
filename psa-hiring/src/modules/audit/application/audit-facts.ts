import type {
  AuditEnvelope,
  SafeMetadata,
  SecurityEnvelope,
} from "../domain/envelope";
import {
  ENVELOPE_SCHEMA_VERSION,
  auditScopeTypes,
  codePattern,
  permissionPattern,
  uuidPattern,
  type ActorType,
  type AuditScopeType,
  type EventSource,
} from "../domain/vocabulary";
import {
  findEventDefinition,
  type CatalogEventName,
  type EventDefinition,
  type FactKey,
} from "./event-catalog";

// Narrow typed facts → validated, server-owned envelope (packet M1.6 §10,
// §11). Emitters pass only opaque references and closed codes; actor
// type, outcome, category, action, target type, retention class, time,
// partition, and integrity are all decided here or by the database,
// never by the caller. Any unknown event, version, fact, or malformed
// value rejects before a write.

/** Closed failure categories; never raw library codes. */
export const securityCategories = [
  "invalid_input",
  "invalid_credentials",
  "not_eligible",
  "invalid_intent",
  "invalid_code",
  "invalid_link",
  "rate_limited",
  "duplicate",
  "locked",
  "replayed",
  "expired",
  "denied",
  "challenge",
  "ok",
] as const;
export type SecurityCategory = (typeof securityCategories)[number];

export const systemActors = [
  "SYSTEM_PROCESS",
  "TEST_HARNESS",
  "SCHEDULED_EXPIRY",
] as const;
export type SystemActor = (typeof systemActors)[number];

export const methodCategories = ["PASSWORD", "TOTP", "BACKUP_CODE"] as const;
export type MethodCategory = (typeof methodCategories)[number];

/** The effective M1.4 authority used for an allowed decision. */
export type EffectiveAuthority = Readonly<{
  roleCode: string;
  assignmentId: string | null;
  scopeType: string | null;
  scopeReferenceId: string | null;
}>;

export type AuditFacts = Readonly<{
  code: CatalogEventName;
  /** Opaque subject account UUID; never an email. */
  accountRef?: string;
  /** Opaque acting account UUID when it differs from the subject. */
  actorRef?: string;
  systemActor?: SystemActor;
  /** Opaque invitation, recovery case, assignment, or resource UUID. */
  recordRef?: string;
  category?: SecurityCategory;
  permissionCode?: string;
  /** The assigned (changed) role/scope codes of an assignment event. */
  roleCode?: string;
  scopeType?: string;
  effective?: EffectiveAuthority;
  reasonCode?: string;
  policyVersion?: string;
  correlationId?: string;
  previousVersion?: number;
  newVersion?: number;
  count?: number;
  methodCategory?: MethodCategory;
  organizationRef?: string;
  candidacyRef?: string;
  filterCodes?: readonly string[];
  /** Changed field-category codes of a configuration edit (never values). */
  changeCodes?: readonly string[];
}>;

export type PreparedEvent =
  | Readonly<{
      kind: "AUDIT";
      definition: EventDefinition;
      envelope: Omit<AuditEnvelope, "occurredAt">;
      subjectId: string | null;
    }>
  | Readonly<{
      kind: "SECURITY";
      definition: EventDefinition;
      envelope: Omit<SecurityEnvelope, "occurredAt">;
      subjectId: string | null;
    }>
  | Readonly<{ kind: "TELEMETRY"; definition: EventDefinition }>;

/** A validation refusal: a closed code only, never the offending value. */
export class AuditValidationError extends Error {
  constructor(readonly reason: string) {
    super(`audit event rejected: ${reason}`);
    this.name = "AuditValidationError";
  }
}

const reject = (reason: string): never => {
  throw new AuditValidationError(reason);
};

const policyVersionPattern = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const MAX_COUNT = 100_000;
const MAX_METADATA_BYTES = 1024;

export type EventContext = Readonly<{
  source: EventSource;
  /** Server-issued per-command reference. */
  requestId: string;
  /** Fresh nonsequential event ID. */
  eventId: string;
}>;

/** Validates facts against the catalog and builds the safe envelope. */
export function prepareEvent(
  facts: AuditFacts,
  context: EventContext,
): PreparedEvent {
  if (typeof facts !== "object" || facts === null) reject("INVALID_FACTS");
  const definition = findEventDefinition(String(facts.code));
  if (!definition) return reject("UNKNOWN_EVENT");

  const present = Object.entries(facts).filter(
    ([key, value]) => key !== "code" && value !== undefined,
  ) as [FactKey, unknown][];
  for (const [key] of present) {
    if (!definition.allows.includes(key)) reject("UNEXPECTED_FACT");
  }
  for (const key of definition.requires) {
    if (facts[key] === undefined) reject("MISSING_FACT");
  }
  if (definition.stream === "TELEMETRY") {
    return { kind: "TELEMETRY", definition };
  }

  const accountRef = optionalUuid(facts.accountRef);
  const actorRef = optionalUuid(facts.actorRef);
  const recordRef = optionalUuid(facts.recordRef);
  // A missing or malformed correlation ID never drops required evidence:
  // the server-issued request reference is used instead.
  const correlationId =
    typeof facts.correlationId === "string" &&
    uuidPattern.test(facts.correlationId.toLowerCase())
      ? facts.correlationId.toLowerCase()
      : context.requestId;
  if (
    !uuidPattern.test(context.requestId) ||
    !uuidPattern.test(context.eventId)
  ) {
    reject("INVALID_CONTEXT");
  }
  if (
    facts.category !== undefined &&
    !securityCategories.includes(facts.category)
  ) {
    reject("INVALID_CATEGORY");
  }
  if (
    facts.systemActor !== undefined &&
    !systemActors.includes(facts.systemActor)
  ) {
    reject("INVALID_ACTOR");
  }
  const permissionCode = optionalPattern(
    facts.permissionCode,
    permissionPattern,
    100,
  );
  const roleCode = optionalPattern(facts.roleCode, codePattern, 64);
  const scopeType = optionalScope(facts.scopeType);
  const reasonCode =
    optionalPattern(facts.reasonCode, codePattern, 64) ??
    (facts.category ? facts.category.toUpperCase() : null);
  const policyVersion = optionalPattern(
    facts.policyVersion,
    policyVersionPattern,
    32,
  );
  const previousVersion = optionalInteger(
    facts.previousVersion,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const newVersion = optionalInteger(
    facts.newVersion,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    previousVersion !== null &&
    (newVersion === null || newVersion !== previousVersion + 1)
  ) {
    reject("INVALID_VERSIONS");
  }
  const count = optionalInteger(facts.count, 0, MAX_COUNT);
  if (
    facts.methodCategory !== undefined &&
    !methodCategories.includes(facts.methodCategory)
  ) {
    reject("INVALID_METHOD");
  }
  const filterCodes =
    facts.filterCodes === undefined ? null : codeList(facts.filterCodes);
  const changeCodes =
    facts.changeCodes === undefined ? null : codeList(facts.changeCodes);

  const metadata: Record<
    string,
    string | number | boolean | readonly string[]
  > = {};
  if (policyVersion) metadata.policy_version = policyVersion;
  if (count !== null) metadata.affected_count = count;
  if (facts.methodCategory) metadata.method_category = facts.methodCategory;
  if (roleCode) metadata.assigned_role_code = roleCode;
  if (scopeType) metadata.assigned_scope_type = scopeType;
  if (filterCodes) metadata.filter_codes = filterCodes;
  if (changeCodes) metadata.changed_fields = changeCodes;

  const subjectId = accountRef ?? recordRef ?? actorRef;

  if (definition.stream === "SECURITY") {
    if (permissionCode) metadata.permission_code = permissionCode;
    if (recordRef) metadata.record_ref = recordRef;
    return {
      kind: "SECURITY",
      definition,
      subjectId,
      envelope: Object.freeze({
        id: context.eventId,
        schemaVersion: ENVELOPE_SCHEMA_VERSION,
        eventName: definition.name,
        eventVersion: definition.version,
        outcome: definition.outcome,
        accountId: accountRef,
        riskCode: reasonCode,
        source: context.source,
        correlationId,
        requestId: context.requestId,
        metadata: boundedMetadata(metadata),
        retentionClassCode: "SECURITY_STANDARD_UNSET",
      }),
    };
  }

  const actor = resolveActor(
    definition,
    accountRef,
    actorRef,
    facts.systemActor,
  );
  const targetId =
    definition.targetFrom === "accountRef"
      ? accountRef
      : definition.targetFrom === "recordRef"
        ? recordRef
        : null;
  if (definition.targetFrom && !targetId) reject("MISSING_TARGET");
  const effective = facts.effective
    ? effectiveAuthority(facts.effective)
    : null;
  if (definition.category === null) reject("INVALID_CATEGORY");

  const idempotencyKey = definition.idempotent
    ? `${targetId ?? reject("MISSING_TARGET")}:${newVersion ?? reject("MISSING_VERSION")}`
    : null;

  return {
    kind: "AUDIT",
    definition,
    subjectId: targetId ?? subjectId,
    envelope: Object.freeze({
      id: context.eventId,
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      eventName: definition.name,
      eventVersion: definition.version,
      category: definition.category!,
      outcome: definition.outcome,
      organizationId: optionalUuid(facts.organizationRef),
      candidacyId: optionalUuid(facts.candidacyRef),
      actorType: actor.type,
      actorUserId: actor.userId,
      effectiveRoleCode: effective?.roleCode ?? null,
      effectiveAssignmentId: effective?.assignmentId ?? null,
      effectiveScopeType: effective?.scopeType ?? null,
      effectiveScopeReferenceId: effective?.scopeReferenceId ?? null,
      permissionCode,
      action: definition.action,
      targetType: definition.target,
      targetId,
      source: context.source,
      reasonCode,
      correlationId,
      requestId: context.requestId,
      idempotencyKey,
      metadata: boundedMetadata(metadata),
      previousRecordVersion: previousVersion,
      newRecordVersion: newVersion,
      retentionClassCode: "AUDIT_STANDARD_UNSET",
    }),
  };
}

function resolveActor(
  definition: EventDefinition,
  accountRef: string | null,
  actorRef: string | null,
  systemActor: SystemActor | undefined,
): { type: ActorType; userId: string | null } {
  switch (definition.actor) {
    case "SUBJECT":
      if (!accountRef) return reject("MISSING_ACTOR");
      if (actorRef && actorRef !== accountRef) reject("INVALID_ACTOR");
      return { type: "USER", userId: accountRef };
    case "ACTOR":
      if (!actorRef) return reject("MISSING_ACTOR");
      return { type: "USER", userId: actorRef };
    case "ACTOR_OR_SYSTEM":
      if (actorRef && systemActor) reject("INVALID_ACTOR");
      if (actorRef) return { type: "USER", userId: actorRef };
      if (systemActor) return { type: "SYSTEM", userId: null };
      return reject("MISSING_ACTOR");
    case "SYSTEM":
      if (actorRef) reject("INVALID_ACTOR");
      return { type: "SYSTEM", userId: null };
  }
}

function effectiveAuthority(value: EffectiveAuthority) {
  if (typeof value !== "object" || value === null) reject("INVALID_AUTHORITY");
  const roleCode = optionalPattern(value.roleCode, codePattern, 64);
  if (!roleCode) return reject("INVALID_AUTHORITY");
  const scopeType =
    value.scopeType === null ? null : optionalScope(value.scopeType);
  const scopeReferenceId =
    value.scopeReferenceId === null
      ? null
      : optionalUuid(value.scopeReferenceId);
  if ((scopeType === null) !== (scopeReferenceId === null))
    reject("INVALID_AUTHORITY");
  const assignmentId =
    value.assignmentId === null ? null : optionalUuid(value.assignmentId);
  return { roleCode, assignmentId, scopeType, scopeReferenceId };
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return reject("INVALID_REFERENCE");
  const lower = value.toLowerCase();
  if (!uuidPattern.test(lower)) reject("INVALID_REFERENCE");
  return lower;
}

function optionalPattern(
  value: unknown,
  pattern: RegExp,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max || !pattern.test(value)) {
    return reject("INVALID_CODE");
  }
  return value;
}

function optionalScope(value: unknown): AuditScopeType | null {
  if (value === undefined || value === null) return null;
  if (!auditScopeTypes.includes(value as AuditScopeType))
    reject("INVALID_SCOPE");
  return value as AuditScopeType;
}

function optionalInteger(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    return reject("INVALID_INTEGER");
  }
  return value;
}

function codeList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 12)
    return reject("INVALID_FILTER");
  return Object.freeze(
    value.map(
      (item) =>
        optionalPattern(item, codePattern, 64) ?? reject("INVALID_FILTER"),
    ),
  );
}

function boundedMetadata(metadata: Record<string, unknown>): SafeMetadata {
  if (
    Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES
  ) {
    reject("METADATA_TOO_LARGE");
  }
  return Object.freeze({ ...metadata }) as SafeMetadata;
}
