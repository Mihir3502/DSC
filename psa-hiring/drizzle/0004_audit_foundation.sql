CREATE SCHEMA IF NOT EXISTS "audit";
--> statement-breakpoint
CREATE TABLE "audit"."audit_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"event_name" varchar(96) NOT NULL,
	"event_version" integer NOT NULL,
	"category" varchar(32) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"organization_id" uuid,
	"candidacy_id" uuid,
	"actor_type" varchar(16) NOT NULL,
	"actor_user_id" uuid,
	"effective_role_code" varchar(64),
	"effective_assignment_id" uuid,
	"effective_scope_type" varchar(32),
	"effective_scope_reference_id" uuid,
	"permission_code" varchar(100),
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32),
	"target_id" uuid,
	"source" varchar(16) NOT NULL,
	"reason_code" varchar(64),
	"correlation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"idempotency_key" varchar(64),
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"previous_record_version" bigint,
	"new_record_version" bigint,
	"retention_class_code" varchar(32) NOT NULL,
	"chain_partition" varchar(48) NOT NULL,
	"chain_sequence" bigint NOT NULL,
	"previous_hash" "bytea" NOT NULL,
	"integrity_hash" "bytea" NOT NULL,
	"integrity_key_version" varchar(8) NOT NULL,
	"canonicalization_version" integer NOT NULL,
	CONSTRAINT "audit_event_chain_unique" UNIQUE("chain_partition","chain_sequence"),
	CONSTRAINT "audit_event_partition_check" CHECK (chain_partition ~ '^((IDENTITY|SECURITY):[0-9a-f]{2}|ORG:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
	CONSTRAINT "audit_event_sequence_check" CHECK (chain_sequence >= 1),
	CONSTRAINT "audit_event_hash_check" CHECK (octet_length(previous_hash) = 32 AND octet_length(integrity_hash) = 32),
	CONSTRAINT "audit_event_key_version_check" CHECK (integrity_key_version ~ '^[tv][0-9]{1,4}$'),
	CONSTRAINT "audit_event_canonicalization_check" CHECK (canonicalization_version = 1),
	CONSTRAINT "audit_event_schema_version_check" CHECK (schema_version = 1),
	CONSTRAINT "audit_event_event_version_check" CHECK (event_version >= 1),
	CONSTRAINT "audit_event_event_name_check" CHECK (event_name ~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "audit_event_metadata_check" CHECK (jsonb_typeof(metadata_json) = 'object' AND pg_column_size(metadata_json) <= 2048),
	CONSTRAINT "audit_event_time_check" CHECK (occurred_at <= recorded_at + interval '5 seconds' AND occurred_at >= recorded_at - interval '10 minutes'),
	CONSTRAINT "audit_event_source_check" CHECK (source IN ('WEB', 'API', 'JOB', 'PROVIDER', 'SYSTEM', 'LOCAL_TEST')),
	CONSTRAINT "audit_event_outcome_check" CHECK (outcome IN ('SUCCEEDED', 'DENIED', 'FAILED')),
	CONSTRAINT "audit_event_reference_check" CHECK (correlation_id IS NOT NULL AND request_id IS NOT NULL),
	CONSTRAINT "audit_event_category_check" CHECK (category IN ('IDENTITY', 'ACCESS_CONTROL', 'SECURITY', 'RESTRICTED_ACCESS', 'CONFIGURATION', 'AUDIT_ACCESS')),
	CONSTRAINT "audit_event_actor_check" CHECK ((actor_type = 'USER' AND actor_user_id IS NOT NULL) OR (actor_type IN ('SERVICE', 'SYSTEM', 'ANONYMOUS') AND actor_user_id IS NULL)),
	CONSTRAINT "audit_event_scope_check" CHECK ((effective_scope_type IS NULL) = (effective_scope_reference_id IS NULL) AND (effective_scope_type IS NULL OR effective_scope_type IN ('ASSIGNED_RECORDS', 'TEAM', 'BRANCH', 'ORGANIZATION', 'AUDIT_ASSIGNMENT')) AND (effective_role_code IS NOT NULL OR (effective_scope_type IS NULL AND effective_assignment_id IS NULL)) AND (effective_role_code IS NULL OR actor_type = 'USER')),
	CONSTRAINT "audit_event_target_check" CHECK ((target_type IS NOT NULL OR target_id IS NULL) AND (target_type IS NULL OR target_type IN ('USER_ACCOUNT', 'STAFF_INVITATION', 'STAFF_RECOVERY_CASE', 'ROLE_ASSIGNMENT', 'AUTHORIZATION_CATALOG', 'PROTECTED_RESOURCE', 'AUDIT_LOG')) AND (target_id IS NOT NULL OR target_type IS NULL OR target_type IN ('AUTHORIZATION_CATALOG', 'AUDIT_LOG'))),
	CONSTRAINT "audit_event_version_check" CHECK ((previous_record_version IS NULL OR previous_record_version >= 0) AND (new_record_version IS NULL OR new_record_version >= 1) AND (previous_record_version IS NULL OR new_record_version = previous_record_version + 1)),
	CONSTRAINT "audit_event_code_check" CHECK (action ~ '^[A-Z][A-Z0-9_]{0,63}$' AND (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$') AND (effective_role_code IS NULL OR effective_role_code ~ '^[A-Z][A-Z0-9_]{0,63}$') AND (permission_code IS NULL OR permission_code ~ '^[a-z][a-z0-9_.]{0,99}$') AND (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f-]{36}:[0-9]{1,19}$')),
	CONSTRAINT "audit_event_retention_check" CHECK (retention_class_code = 'AUDIT_STANDARD_UNSET')
);
--> statement-breakpoint
CREATE TABLE "audit"."chain_head" (
	"chain_partition" varchar(48) PRIMARY KEY NOT NULL,
	"last_sequence" bigint NOT NULL,
	"last_hash" "bytea" NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "chain_head_sequence_check" CHECK (last_sequence >= 0),
	CONSTRAINT "chain_head_hash_check" CHECK (octet_length(last_hash) = 32),
	CONSTRAINT "chain_head_partition_check" CHECK (chain_partition ~ '^((IDENTITY|SECURITY):[0-9a-f]{2}|ORG:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')
);
--> statement-breakpoint
CREATE TABLE "audit"."security_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"event_name" varchar(96) NOT NULL,
	"event_version" integer NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"account_id" uuid,
	"risk_code" varchar(64),
	"source" varchar(16) NOT NULL,
	"correlation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"retention_class_code" varchar(32) NOT NULL,
	"chain_partition" varchar(48) NOT NULL,
	"chain_sequence" bigint NOT NULL,
	"previous_hash" "bytea" NOT NULL,
	"integrity_hash" "bytea" NOT NULL,
	"integrity_key_version" varchar(8) NOT NULL,
	"canonicalization_version" integer NOT NULL,
	CONSTRAINT "security_event_chain_unique" UNIQUE("chain_partition","chain_sequence"),
	CONSTRAINT "security_event_partition_check" CHECK (chain_partition ~ '^((IDENTITY|SECURITY):[0-9a-f]{2}|ORG:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
	CONSTRAINT "security_event_sequence_check" CHECK (chain_sequence >= 1),
	CONSTRAINT "security_event_hash_check" CHECK (octet_length(previous_hash) = 32 AND octet_length(integrity_hash) = 32),
	CONSTRAINT "security_event_key_version_check" CHECK (integrity_key_version ~ '^[tv][0-9]{1,4}$'),
	CONSTRAINT "security_event_canonicalization_check" CHECK (canonicalization_version = 1),
	CONSTRAINT "security_event_schema_version_check" CHECK (schema_version = 1),
	CONSTRAINT "security_event_event_version_check" CHECK (event_version >= 1),
	CONSTRAINT "security_event_event_name_check" CHECK (event_name ~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "security_event_metadata_check" CHECK (jsonb_typeof(metadata_json) = 'object' AND pg_column_size(metadata_json) <= 2048),
	CONSTRAINT "security_event_time_check" CHECK (occurred_at <= recorded_at + interval '5 seconds' AND occurred_at >= recorded_at - interval '10 minutes'),
	CONSTRAINT "security_event_source_check" CHECK (source IN ('WEB', 'API', 'JOB', 'PROVIDER', 'SYSTEM', 'LOCAL_TEST')),
	CONSTRAINT "security_event_outcome_check" CHECK (outcome IN ('SUCCEEDED', 'DENIED', 'FAILED')),
	CONSTRAINT "security_event_reference_check" CHECK (correlation_id IS NOT NULL AND request_id IS NOT NULL),
	CONSTRAINT "security_event_code_check" CHECK (risk_code IS NULL OR risk_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "security_event_retention_check" CHECK (retention_class_code = 'SECURITY_STANDARD_UNSET')
);
--> statement-breakpoint
ALTER TABLE "audit"."audit_event" ADD CONSTRAINT "audit_event_actor_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "audit"."security_event" ADD CONSTRAINT "security_event_account_fk" FOREIGN KEY ("account_id") REFERENCES "auth"."user"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_event_idempotency_unique" ON "audit"."audit_event" USING btree ("event_name","idempotency_key") WHERE "audit"."audit_event"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_event_occurred_idx" ON "audit"."audit_event" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "audit_event_target_idx" ON "audit"."audit_event" USING btree ("target_type","target_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_actor_idx" ON "audit"."audit_event" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_organization_idx" ON "audit"."audit_event" USING btree ("organization_id","occurred_at","id") WHERE "audit"."audit_event"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_event_candidacy_idx" ON "audit"."audit_event" USING btree ("candidacy_id","occurred_at") WHERE "audit"."audit_event"."candidacy_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_event_category_idx" ON "audit"."audit_event" USING btree ("category","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_correlation_idx" ON "audit"."audit_event" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "security_event_occurred_idx" ON "audit"."security_event" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "security_event_account_idx" ON "audit"."security_event" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_event_name_idx" ON "audit"."security_event" USING btree ("event_name","occurred_at");--> statement-breakpoint
-- ------------------------------------------------------------------------
-- Hand-written append-only and integrity controls (packet M1.6 §12, §17,
-- ADR-0012). Reviewed: fixed search_path, schema-qualified references, no
-- dynamic SQL, typed inputs, owner = migration role, no PUBLIC access.
-- ------------------------------------------------------------------------
REVOKE ALL ON SCHEMA "audit" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "audit" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "audit"."reject_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'audit history is append-only' USING ERRCODE = 'AU002';
END
$$;--> statement-breakpoint
CREATE TRIGGER "audit_event_append_only" BEFORE UPDATE OR DELETE ON "audit"."audit_event" FOR EACH ROW EXECUTE FUNCTION "audit"."reject_mutation"();--> statement-breakpoint
CREATE TRIGGER "audit_event_no_truncate" BEFORE TRUNCATE ON "audit"."audit_event" FOR EACH STATEMENT EXECUTE FUNCTION "audit"."reject_mutation"();--> statement-breakpoint
CREATE TRIGGER "security_event_append_only" BEFORE UPDATE OR DELETE ON "audit"."security_event" FOR EACH ROW EXECUTE FUNCTION "audit"."reject_mutation"();--> statement-breakpoint
CREATE TRIGGER "security_event_no_truncate" BEFORE TRUNCATE ON "audit"."security_event" FOR EACH STATEMENT EXECUTE FUNCTION "audit"."reject_mutation"();--> statement-breakpoint
CREATE FUNCTION "audit"."guard_chain_head"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_sequence <> 0 OR NEW.last_hash <> decode(repeat('00', 32), 'hex') THEN
      RAISE EXCEPTION 'audit chain head must start at genesis' USING ERRCODE = 'AU003';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.chain_partition <> OLD.chain_partition
       OR NEW.last_sequence <> OLD.last_sequence + 1 THEN
      RAISE EXCEPTION 'audit chain head may only advance by one' USING ERRCODE = 'AU003';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit chain head is never deleted' USING ERRCODE = 'AU002';
END
$$;--> statement-breakpoint
CREATE TRIGGER "chain_head_guard" BEFORE INSERT OR UPDATE OR DELETE ON "audit"."chain_head" FOR EACH ROW EXECUTE FUNCTION "audit"."guard_chain_head"();--> statement-breakpoint
CREATE TRIGGER "chain_head_no_truncate" BEFORE TRUNCATE ON "audit"."chain_head" FOR EACH STATEMENT EXECUTE FUNCTION "audit"."reject_mutation"();--> statement-breakpoint
-- Locks (creating at genesis on first use) one server-derived partition
-- head until the caller's transaction ends and returns the next sequence,
-- the previous hash, and trusted database time for the occurrence.
CREATE FUNCTION "audit"."claim_chain_head"(p_partition text)
RETURNS TABLE (next_sequence bigint, previous_hash text, occurred_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_partition IS NULL OR p_partition !~ '^((IDENTITY|SECURITY):[0-9a-f]{2}|ORG:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'invalid audit chain partition' USING ERRCODE = '22023';
  END IF;
  INSERT INTO "audit"."chain_head" (chain_partition, last_sequence, last_hash, updated_at)
  VALUES (p_partition, 0, decode(repeat('00', 32), 'hex'), date_trunc('milliseconds', clock_timestamp()))
  ON CONFLICT (chain_partition) DO NOTHING;
  RETURN QUERY
    SELECT h.last_sequence + 1,
           encode(h.last_hash, 'hex'),
           date_trunc('milliseconds', clock_timestamp())
    FROM "audit"."chain_head" h
    WHERE h.chain_partition = p_partition
    FOR UPDATE;
END
$$;--> statement-breakpoint
CREATE FUNCTION "audit"."append_audit_event"(p_event jsonb) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r "audit"."audit_event";
  head "audit"."chain_head";
  existing uuid;
BEGIN
  r := jsonb_populate_record(NULL::"audit"."audit_event", p_event);
  IF r.idempotency_key IS NOT NULL THEN
    SELECT e.id INTO existing FROM "audit"."audit_event" e
    WHERE e.event_name = r.event_name AND e.idempotency_key = r.idempotency_key;
    IF FOUND THEN
      RETURN existing;
    END IF;
  END IF;
  SELECT * INTO head FROM "audit"."chain_head" h
  WHERE h.chain_partition = r.chain_partition
  FOR UPDATE;
  IF NOT FOUND
     OR r.chain_sequence IS DISTINCT FROM head.last_sequence + 1
     OR r.previous_hash IS DISTINCT FROM head.last_hash THEN
    RAISE EXCEPTION 'audit chain head mismatch' USING ERRCODE = 'AU001';
  END IF;
  r.recorded_at := date_trunc('milliseconds', clock_timestamp());
  INSERT INTO "audit"."audit_event" SELECT r.*;
  UPDATE "audit"."chain_head"
  SET last_sequence = r.chain_sequence, last_hash = r.integrity_hash, updated_at = r.recorded_at
  WHERE chain_partition = r.chain_partition;
  RETURN r.id;
END
$$;--> statement-breakpoint
CREATE FUNCTION "audit"."append_security_event"(p_event jsonb) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r "audit"."security_event";
  head "audit"."chain_head";
BEGIN
  r := jsonb_populate_record(NULL::"audit"."security_event", p_event);
  SELECT * INTO head FROM "audit"."chain_head" h
  WHERE h.chain_partition = r.chain_partition
  FOR UPDATE;
  IF NOT FOUND
     OR r.chain_sequence IS DISTINCT FROM head.last_sequence + 1
     OR r.previous_hash IS DISTINCT FROM head.last_hash THEN
    RAISE EXCEPTION 'audit chain head mismatch' USING ERRCODE = 'AU001';
  END IF;
  r.recorded_at := date_trunc('milliseconds', clock_timestamp());
  INSERT INTO "audit"."security_event" SELECT r.*;
  UPDATE "audit"."chain_head"
  SET last_sequence = r.chain_sequence, last_hash = r.integrity_hash, updated_at = r.recorded_at
  WHERE chain_partition = r.chain_partition;
  RETURN r.id;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."reject_mutation"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."guard_chain_head"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."claim_chain_head"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."append_audit_event"(jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."append_security_event"(jsonb) FROM PUBLIC;