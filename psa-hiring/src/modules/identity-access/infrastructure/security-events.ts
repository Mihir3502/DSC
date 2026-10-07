import type {
  AuditFacts,
  EventRecorder,
  SecurityCategory,
} from "@/modules/audit";

// Identity-access event port (packet M1.2 §15, M1.6 §15, ADR-0012). Until
// M1.6 this was a log-only adapter; it is now the durable audit recorder:
// every emitted code is registered in the audit event catalog, and each
// event is persisted to audit_event or security_event (or kept as an
// approved telemetry log line) according to that catalog.
//
// - record(): bounded standalone append for denials, failures, reads, and
//   Better Auth provider-committed changes. Never throws; returns false
//   when a required append failed so the caller can withhold success.
// - recordInTransaction(): append inside the caller's transaction; throws
//   so the mutation rolls back. Prefer withAuditedTransaction.
//
// Events carry only opaque UUID references and closed codes: never an
// email, password, token, cookie, header, IP, user agent, or request body.

export type SecurityEvent = AuditFacts;
export type SecurityEventCode = AuditFacts["code"];
export type SecurityEventCategory = SecurityCategory;
export type SecurityEventPort = EventRecorder;
