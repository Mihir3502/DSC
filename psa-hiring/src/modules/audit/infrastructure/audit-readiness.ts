import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./audit-store";

// Production-like startup check (packet M1.6 §19, AC-M1.6-14). Run as the
// runtime identity: refuses to start when that identity owns audit
// objects, holds any write/truncate/trigger/references privilege on audit
// tables, or when an append-only trigger is missing or disabled. Reports
// closed problem codes only, never counts, targets, or integrity values.

export const requiredAuditTriggers = [
  "audit_event_append_only",
  "audit_event_no_truncate",
  "security_event_append_only",
  "security_event_no_truncate",
  "chain_head_guard",
  "chain_head_no_truncate",
] as const;

export type AuditReadinessProblem =
  | "AUDIT_SCHEMA_MISSING"
  | "RUNTIME_OWNS_AUDIT_OBJECTS"
  | "RUNTIME_HAS_WRITE_PRIVILEGE"
  | "APPEND_ONLY_TRIGGER_MISSING";

export async function checkAuditReadiness(
  executor: SqlExecutor,
): Promise<readonly AuditReadinessProblem[]> {
  const problems: AuditReadinessProblem[] = [];
  const schema = await executor.execute(
    sql`SELECT pg_get_userbyid(nspowner) = current_user AS owned
        FROM pg_namespace WHERE nspname = 'audit'`,
  );
  if (!schema.rows[0]) return ["AUDIT_SCHEMA_MISSING"];

  const owned = await executor.execute(
    sql`SELECT (pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'audit')) = current_user
              OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'audit' AND pg_get_userbyid(c.relowner) = current_user)
              OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = 'audit' AND pg_get_userbyid(p.proowner) = current_user)) AS owned`,
  );
  if (owned.rows[0]?.owned === true)
    problems.push("RUNTIME_OWNS_AUDIT_OBJECTS");

  const writable = await executor.execute(
    sql`SELECT bool_or(has_table_privilege(current_user, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')) AS writable
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relkind = 'r'`,
  );
  if (writable.rows[0]?.writable === true) {
    problems.push("RUNTIME_HAS_WRITE_PRIVILEGE");
  }

  const triggers = await executor.execute(
    sql`SELECT t.tgname FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')`,
  );
  const enabled = new Set(triggers.rows.map((row) => String(row.tgname)));
  if (!requiredAuditTriggers.every((name) => enabled.has(name))) {
    problems.push("APPEND_ONLY_TRIGGER_MISSING");
  }
  return problems;
}
