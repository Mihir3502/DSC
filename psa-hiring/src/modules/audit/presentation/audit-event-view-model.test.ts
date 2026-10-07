import { describe, expect, it } from "vitest";
import { findEventDefinition } from "../application/event-catalog";
import {
  auditEventViewKeys,
  projectAuditEvent,
} from "./audit-event-view-model";

// Packet M1.6 §16.3, §26 (18), AC-M1.6-11: the exact redacted projection.

const row = {
  id: "4f5e3e1c-ae99-4a2c-9e7f-6b5b4a8c9eaf",
  event_name: "authz.assignment_approved",
  event_version: 1,
  category: "ACCESS_CONTROL",
  outcome: "SUCCEEDED",
  actor_type: "USER",
  actor_user_id: "1c8b6b4f-7b66-4d9f-8b4c-3e2e1d5f6b7c",
  effective_role_code: "SYSTEM_ADMINISTRATOR",
  effective_scope_type: "ORGANIZATION",
  effective_scope_reference_id: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
  effective_assignment_id: "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e",
  action: "ROLE_ASSIGNMENT_APPROVE",
  target_type: "ROLE_ASSIGNMENT",
  target_id: "2d7c5c3a-8c77-4e0a-9c5d-4f3f2e6a7c8d",
  reason_code: null,
  correlation_id: "3e6d4d2b-9d88-4f1b-8d6e-5a4a3f7b8d9e",
  request_id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  occurred_at: new Date("2026-10-07T12:00:00.000Z"),
  metadata_json: {
    assigned_role_code: "RECRUITER",
    assigned_scope_type: "BRANCH",
    policy_version: "authz-p1-c1",
    unregistered_key: "TESTCANARY",
  },
  integrity_hash: "TESTCANARY-hash",
  previous_hash: "TESTCANARY-prev",
  integrity_key_version: "t1",
  chain_partition: "IDENTITY:03",
  chain_sequence: 9,
  idempotency_key: "2d7c5c3a-8c77-4e0a-9c5d-4f3f2e6a7c8d:2",
};

describe("audit event projection", () => {
  it("returns only the exact approved fields and projectable metadata", () => {
    const view = projectAuditEvent(row, findEventDefinition);
    expect(Object.keys(view)).toEqual([...auditEventViewKeys]);
    expect(view.metadata).toEqual({
      assigned_role_code: "RECRUITER",
      assigned_scope_type: "BRANCH",
      policy_version: "authz-p1-c1",
    });
    expect(view.authority).toEqual({
      roleCode: "SYSTEM_ADMINISTRATOR",
      scopeType: "ORGANIZATION",
    });
    const text = JSON.stringify(view);
    for (const hidden of [
      "TESTCANARY",
      row.request_id,
      row.effective_scope_reference_id,
      row.effective_assignment_id,
      "IDENTITY:03",
      "idempotency",
      "integrity",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("drops metadata for an unknown event version", () => {
    const view = projectAuditEvent(
      { ...row, event_version: 99 },
      findEventDefinition,
    );
    expect(view.metadata).toEqual({});
  });
});
