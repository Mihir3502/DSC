import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from "../../domain/authorization-decision";
import {
  isUuid,
  type Operation,
  type SensitivityLevel,
} from "../../domain/authorization-vocabulary";
import type { SecurityEventPort } from "../../infrastructure/security-events";

// Reusable document access gate (packet M1.5 §15, ADR-0011). M1 has no
// document feature, storage, or download endpoint; later document
// milestones implement DocumentEnvelopeSource and register category
// permissions, and their Route Handlers stream the bytes with
// delivery/protected-response.ts protectedDownloadHeaders().
//
// Rules enforced here:
// - Each action (metadata, preview, download, print, export) is
//   authorized separately; view never implies download/print/export.
// - The permission comes from a reviewed per-category registry, never from
//   the request. The production registry is empty, so everything denies.
// - The document's category, parent record, audience, scan state, and
//   sensitivity come from a minimal server-side envelope; a storage key,
//   object URL, filename, or link in the request is never authority.
// - Bytes are served only after current authorization: the grant carries
//   the document ID and action, never a storage key or provider URL, and
//   expires quickly. Unauthorized callers are never redirected to storage.
// - Every allowed restricted access is reported to the future-audit port
//   with safe codes only. A denial is reported once, by the M1.4 service
//   (authz.high_risk_denied for every restricted permission), never again
//   here.

export const documentActions = [
  "METADATA",
  "PREVIEW",
  "DOWNLOAD",
  "PRINT",
  "EXPORT",
] as const;
export type DocumentAction = (typeof documentActions)[number];

export type DocumentScanState = "PENDING" | "CLEAN" | "QUARANTINED" | "FAILED";

/** Minimal server-side facts; never contents, storage keys, or URLs. */
export type DocumentEnvelope = Readonly<{
  id: string;
  category: string;
  /** The business record whose scope governs the document. */
  parentRecordId: string;
  sensitivity: SensitivityLevel;
  audience: "CANDIDATE_VISIBLE" | "STAFF_INTERNAL" | "RESTRICTED_REVIEW";
  scanState: DocumentScanState;
  hidden: boolean;
}>;

export interface DocumentEnvelopeSource {
  loadDocumentEnvelope(id: string): Promise<DocumentEnvelope | null>;
}

export type CategoryPermission = Readonly<{
  permission: string;
  operation: Operation;
}>;

/** Reviewed category → action → permission registry. */
export type DocumentPermissionRegistry = Readonly<
  Record<string, Partial<Readonly<Record<DocumentAction, CategoryPermission>>>>
>;

/** Production default: no document category exists yet in M1. */
export const productionDocumentPermissions: DocumentPermissionRegistry =
  Object.freeze({});

export type DocumentAccessRequest = Readonly<{
  principal: AuthorizationRequest["principal"];
  /** Untrusted opaque document ID from the request. */
  documentId: unknown;
  action: DocumentAction;
  /** Safe purpose code when the permission requires a reason. */
  purposeCode?: string;
  correlationId?: string;
}>;

export type DocumentGrant = Readonly<{
  documentId: string;
  action: DocumentAction;
  /** Short-lived, single-purpose; checked again when the bytes are sent. */
  expiresAt: Date;
}>;

export type DocumentAccessResult =
  | Readonly<{ kind: "AUTHORIZED"; grant: DocumentGrant }>
  | Readonly<{ kind: "UNAUTHENTICATED" }>
  /** Unknown, hidden, wrong-scope, or unauthorized: indistinguishable. */
  | Readonly<{ kind: "NOT_FOUND" }>
  /** The caller may see metadata but the file is not available yet. */
  | Readonly<{ kind: "UNAVAILABLE" }>
  | Readonly<{ kind: "REAUTHENTICATION_REQUIRED" }>;

export type DocumentAccessDependencies = Readonly<{
  source: DocumentEnvelopeSource;
  registry: DocumentPermissionRegistry;
  authorize: (request: AuthorizationRequest) => Promise<AuthorizationDecision>;
  events: SecurityEventPort;
  clock: () => Date;
  /** Grant lifetime; short by design. */
  grantSeconds?: number;
}>;

const restricted = new Set<SensitivityLevel>([
  "RESTRICTED_IDENTITY_FINANCIAL",
  "RESTRICTED_SCREENING_MEDICAL",
  "SECURITY_AUDIT_RESTRICTED",
]);

export async function authorizeDocumentAccess(
  request: DocumentAccessRequest,
  deps: DocumentAccessDependencies,
): Promise<DocumentAccessResult> {
  if (!request.principal) return { kind: "UNAUTHENTICATED" };
  if (
    !(documentActions as readonly string[]).includes(request.action) ||
    !isUuid(request.documentId)
  ) {
    return { kind: "NOT_FOUND" };
  }
  const envelope = await deps.source.loadDocumentEnvelope(request.documentId);
  if (!envelope || envelope.id !== request.documentId || envelope.hidden) {
    return { kind: "NOT_FOUND" };
  }
  const mapping = Object.hasOwn(deps.registry, envelope.category)
    ? deps.registry[envelope.category]?.[request.action]
    : undefined;
  if (!mapping) return { kind: "NOT_FOUND" };

  const decision = await deps.authorize({
    principal: request.principal,
    permission: mapping.permission,
    operation: mapping.operation,
    resource: {
      kind: "RECORD",
      id: envelope.parentRecordId,
      sensitivity: envelope.sensitivity,
    },
    ...(request.purposeCode ? { reasonCode: request.purposeCode } : {}),
    ...(request.correlationId ? { correlationId: request.correlationId } : {}),
  });
  const isRestricted = restricted.has(envelope.sensitivity);
  if (decision.decision === "DENY") {
    if (
      decision.reasonCode === "UNAUTHENTICATED" ||
      decision.reasonCode === "ACCOUNT_INACTIVE"
    ) {
      return { kind: "UNAUTHENTICATED" };
    }
    return decision.reasonCode === "RECENT_AUTH_REQUIRED"
      ? { kind: "REAUTHENTICATION_REQUIRED" }
      : { kind: "NOT_FOUND" };
  }
  // Content actions require a clean, scanned file; metadata does not.
  if (request.action !== "METADATA" && envelope.scanState !== "CLEAN") {
    return { kind: "UNAVAILABLE" };
  }
  if (isRestricted && decision.decision === "ALLOW") {
    deps.events.record({
      code: "authz.restricted_access_allowed",
      category: "ok",
      accountRef: request.principal.accountId,
      permissionCode: decision.permissionCode,
      roleCode: decision.effectiveRoleCode,
      scopeType: decision.effectiveScopeType ?? undefined,
      reasonCode: decision.reasonCode,
      policyVersion: decision.policyVersion,
      correlationId: request.correlationId,
    });
  }
  const seconds = Math.min(Math.max(deps.grantSeconds ?? 60, 1), 300);
  return Object.freeze({
    kind: "AUTHORIZED",
    grant: Object.freeze({
      documentId: envelope.id,
      action: request.action,
      expiresAt: new Date(deps.clock().getTime() + seconds * 1000),
    }),
  });
}
