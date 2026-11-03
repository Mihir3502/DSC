CREATE TABLE "app"."candidacy" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"public_id" varchar(12) NOT NULL,
	"candidate_reference" varchar(10) NOT NULL,
	"person_id" uuid NOT NULL,
	"hiring_cycle_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"team_id" uuid,
	"source_code" varchar(32) NOT NULL,
	"current_stage" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
	"candidate_visible_status" varchar(32) NOT NULL,
	"owner_account_id" uuid,
	"proposed_worker_path" varchar(16) DEFAULT 'UNDECIDED' NOT NULL,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closure_reason_code" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidacy_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "candidacy_reference_unique" UNIQUE("candidate_reference"),
	CONSTRAINT "candidacy_public_id_check" CHECK ("app"."candidacy"."public_id" ~ '^[0-9a-hjkmnp-tv-z]{12}$'),
	CONSTRAINT "candidacy_reference_check" CHECK ("app"."candidacy"."candidate_reference" ~ '^C-[0-9A-HJKMNP-TV-Z]{8}$'),
	CONSTRAINT "candidacy_source_check" CHECK ("app"."candidacy"."source_code" IN ('CANDIDATE_SELF_SERVICE', 'STAFF_ENTERED')),
	CONSTRAINT "candidacy_stage_check" CHECK ("app"."candidacy"."current_stage" IN ('PROSPECT', 'APPLICATION_INCOMPLETE')),
	CONSTRAINT "candidacy_status_check" CHECK ("app"."candidacy"."status" IN ('ACTIVE', 'TERMINAL', 'ARCHIVED')),
	CONSTRAINT "candidacy_visible_status_check" CHECK ("app"."candidacy"."candidate_visible_status" = CASE WHEN "app"."candidacy"."status" <> 'ACTIVE' THEN 'CLOSED' WHEN "app"."candidacy"."current_stage" = 'APPLICATION_INCOMPLETE' THEN 'APPLICATION_STARTED' ELSE 'NOT_STARTED' END),
	CONSTRAINT "candidacy_worker_path_check" CHECK ("app"."candidacy"."proposed_worker_path" IN ('UNDECIDED', 'W2', 'CONTRACTOR')),
	CONSTRAINT "candidacy_lifecycle_check" CHECK ((("app"."candidacy"."current_stage" = 'APPLICATION_INCOMPLETE') = ("app"."candidacy"."started_at" IS NOT NULL)) AND (("app"."candidacy"."status" = 'TERMINAL') = ("app"."candidacy"."closed_at" IS NOT NULL)) AND (("app"."candidacy"."closed_at" IS NULL) = ("app"."candidacy"."closure_reason_code" IS NULL)) AND ("app"."candidacy"."closure_reason_code" IS NULL OR "app"."candidacy"."closure_reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$')),
	CONSTRAINT "candidacy_version_check" CHECK ("app"."candidacy"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."candidacy_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"from_stage" varchar(32),
	"to_stage" varchar(32) NOT NULL,
	"from_status" varchar(16),
	"to_status" varchar(16) NOT NULL,
	"command_code" varchar(64) NOT NULL,
	"actor_account_id" uuid,
	"system_actor" varchar(32),
	"reason_code" varchar(64),
	"version_before" integer,
	"version_after" integer NOT NULL,
	"correlation_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "candidacy_stage_history_actor_check" CHECK (("app"."candidacy_stage_history"."actor_account_id" IS NULL) <> ("app"."candidacy_stage_history"."system_actor" IS NULL)),
	CONSTRAINT "candidacy_stage_history_command_check" CHECK ("app"."candidacy_stage_history"."command_code" IN ('create_prospect', 'start_application', 'start_application_from_prospect', 'close_prospect')),
	CONSTRAINT "candidacy_stage_history_version_check" CHECK ("app"."candidacy_stage_history"."version_after" >= 1 AND ("app"."candidacy_stage_history"."version_before" IS NULL OR "app"."candidacy_stage_history"."version_after" = "app"."candidacy_stage_history"."version_before" + 1))
);
--> statement-breakpoint
CREATE TABLE "app"."candidate_command_receipt" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"command_key" uuid NOT NULL,
	"command_name" varchar(64) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"target_id" uuid NOT NULL,
	"result_version" integer NOT NULL,
	"outcome_code" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_command_receipt_key_unique" UNIQUE("actor_account_id","command_key"),
	CONSTRAINT "candidate_command_receipt_name_check" CHECK ("app"."candidate_command_receipt"."command_name" ~ '^[a-z][a-z_]{1,63}$'),
	CONSTRAINT "candidate_command_receipt_fingerprint_check" CHECK ("app"."candidate_command_receipt"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "candidate_command_receipt_outcome_check" CHECK ("app"."candidate_command_receipt"."outcome_code" ~ '^[A-Z][A-Z_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "app"."duplicate_candidate_match" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"public_id" varchar(12) NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_a_id" uuid NOT NULL,
	"person_b_id" uuid NOT NULL,
	"ruleset_version" varchar(16) NOT NULL,
	"signal_codes" text[] NOT NULL,
	"confidence_tier" varchar(8) NOT NULL,
	"status" varchar(24) DEFAULT 'PENDING' NOT NULL,
	"reviewed_by_account_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reason_code" varchar(64),
	"merge_record_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duplicate_candidate_match_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "duplicate_candidate_match_public_id_check" CHECK ("app"."duplicate_candidate_match"."public_id" ~ '^[0-9a-hjkmnp-tv-z]{12}$'),
	CONSTRAINT "duplicate_candidate_match_pair_check" CHECK ("app"."duplicate_candidate_match"."person_a_id" < "app"."duplicate_candidate_match"."person_b_id"),
	CONSTRAINT "duplicate_candidate_match_ruleset_check" CHECK ("app"."duplicate_candidate_match"."ruleset_version" ~ '^DUP-[0-9]{1,3}$'),
	CONSTRAINT "duplicate_candidate_match_signals_check" CHECK (cardinality("app"."duplicate_candidate_match"."signal_codes") BETWEEN 1 AND 8 AND array_position("app"."duplicate_candidate_match"."signal_codes", NULL) IS NULL AND "app"."duplicate_candidate_match"."signal_codes" <@ ARRAY['EXACT_EMAIL', 'EXACT_PHONE']::text[]),
	CONSTRAINT "duplicate_candidate_match_tier_check" CHECK ("app"."duplicate_candidate_match"."confidence_tier" IN ('HIGH', 'MEDIUM')),
	CONSTRAINT "duplicate_candidate_match_status_check" CHECK ("app"."duplicate_candidate_match"."status" IN ('PENDING', 'CONFIRMED_DUPLICATE', 'NOT_DUPLICATE', 'MERGED')),
	CONSTRAINT "duplicate_candidate_match_review_check" CHECK ((("app"."duplicate_candidate_match"."status" = 'PENDING') = ("app"."duplicate_candidate_match"."reviewed_at" IS NULL)) AND (("app"."duplicate_candidate_match"."reviewed_at" IS NULL) = ("app"."duplicate_candidate_match"."reviewed_by_account_id" IS NULL)) AND (("app"."duplicate_candidate_match"."reviewed_at" IS NULL) = ("app"."duplicate_candidate_match"."reason_code" IS NULL)) AND (("app"."duplicate_candidate_match"."status" = 'MERGED') = ("app"."duplicate_candidate_match"."merge_record_id" IS NOT NULL))),
	CONSTRAINT "duplicate_candidate_match_version_check" CHECK ("app"."duplicate_candidate_match"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."person" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"legal_first_name" varchar(100) NOT NULL,
	"legal_middle_name" varchar(100),
	"legal_last_name" varchar(100) NOT NULL,
	"preferred_name" varchar(100),
	"email_display" varchar(254) NOT NULL,
	"email_normalized" varchar(254) NOT NULL,
	"phone_display" varchar(40),
	"phone_e164" varchar(16),
	"normalization_version" varchar(16) NOT NULL,
	"candidate_account_id" uuid,
	"status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
	"merged_into_person_id" uuid,
	"merged_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_first_name_check" CHECK (char_length("app"."person"."legal_first_name") BETWEEN 1 AND 100),
	CONSTRAINT "person_middle_name_check" CHECK ("app"."person"."legal_middle_name" IS NULL OR char_length("app"."person"."legal_middle_name") BETWEEN 1 AND 100),
	CONSTRAINT "person_last_name_check" CHECK (char_length("app"."person"."legal_last_name") BETWEEN 1 AND 100),
	CONSTRAINT "person_preferred_name_check" CHECK ("app"."person"."preferred_name" IS NULL OR char_length("app"."person"."preferred_name") BETWEEN 1 AND 100),
	CONSTRAINT "person_email_check" CHECK (char_length("app"."person"."email_display") BETWEEN 1 AND 254 AND "app"."person"."email_normalized" = lower("app"."person"."email_normalized") AND "app"."person"."email_normalized" LIKE '%_@_%'),
	CONSTRAINT "person_phone_check" CHECK (("app"."person"."phone_e164" IS NULL OR "app"."person"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$') AND ("app"."person"."phone_e164" IS NULL OR "app"."person"."phone_display" IS NOT NULL)),
	CONSTRAINT "person_normalization_check" CHECK ("app"."person"."normalization_version" ~ '^NORM-[0-9]{1,3}$'),
	CONSTRAINT "person_status_check" CHECK ("app"."person"."status" IN ('ACTIVE', 'MERGED', 'ARCHIVED')),
	CONSTRAINT "person_merge_check" CHECK ((("app"."person"."status" = 'MERGED') = ("app"."person"."merged_into_person_id" IS NOT NULL)) AND (("app"."person"."merged_into_person_id" IS NULL) = ("app"."person"."merged_at" IS NULL)) AND ("app"."person"."merged_into_person_id" IS NULL OR "app"."person"."merged_into_person_id" <> "app"."person"."id") AND ("app"."person"."status" <> 'MERGED' OR "app"."person"."candidate_account_id" IS NULL)),
	CONSTRAINT "person_version_check" CHECK ("app"."person"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."person_merge_record" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"surviving_person_id" uuid NOT NULL,
	"merged_person_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"field_resolution_codes" text[] NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"executed_by_account_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "person_merge_record_merged_unique" UNIQUE("merged_person_id"),
	CONSTRAINT "person_merge_record_distinct_check" CHECK ("app"."person_merge_record"."surviving_person_id" <> "app"."person_merge_record"."merged_person_id"),
	CONSTRAINT "person_merge_record_codes_check" CHECK (cardinality("app"."person_merge_record"."field_resolution_codes") BETWEEN 1 AND 12 AND array_position("app"."person_merge_record"."field_resolution_codes", NULL) IS NULL),
	CONSTRAINT "person_merge_record_reason_check" CHECK ("app"."person_merge_record"."reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
ALTER TABLE "audit"."audit_event" DROP CONSTRAINT "audit_event_category_check";--> statement-breakpoint
ALTER TABLE "audit"."audit_event" DROP CONSTRAINT "audit_event_target_check";--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_person_fk" FOREIGN KEY ("person_id") REFERENCES "app"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Reordered by review: the composite-key target must exist before the FK.
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_candidacy_key" UNIQUE("id","organization_id","position_id","branch_id");--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_hiring_cycle_fk" FOREIGN KEY ("hiring_cycle_id","organization_id","position_id","branch_id") REFERENCES "app"."hiring_cycle"("id","organization_id","position_id","branch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_owner_fk" FOREIGN KEY ("owner_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_updated_by_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidacy_stage_history" ADD CONSTRAINT "candidacy_stage_history_candidacy_fk" FOREIGN KEY ("candidacy_id") REFERENCES "app"."candidacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidacy_stage_history" ADD CONSTRAINT "candidacy_stage_history_actor_fk" FOREIGN KEY ("actor_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidate_command_receipt" ADD CONSTRAINT "candidate_command_receipt_actor_fk" FOREIGN KEY ("actor_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."duplicate_candidate_match" ADD CONSTRAINT "duplicate_candidate_match_a_fk" FOREIGN KEY ("person_a_id") REFERENCES "app"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."duplicate_candidate_match" ADD CONSTRAINT "duplicate_candidate_match_b_fk" FOREIGN KEY ("person_b_id") REFERENCES "app"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."duplicate_candidate_match" ADD CONSTRAINT "duplicate_candidate_match_reviewer_fk" FOREIGN KEY ("reviewed_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person" ADD CONSTRAINT "person_candidate_account_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person" ADD CONSTRAINT "person_merged_into_fk" FOREIGN KEY ("merged_into_person_id") REFERENCES "app"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person" ADD CONSTRAINT "person_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person" ADD CONSTRAINT "person_updated_by_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person_merge_record" ADD CONSTRAINT "person_merge_record_survivor_fk" FOREIGN KEY ("surviving_person_id") REFERENCES "app"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person_merge_record" ADD CONSTRAINT "person_merge_record_merged_fk" FOREIGN KEY ("merged_person_id") REFERENCES "app"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person_merge_record" ADD CONSTRAINT "person_merge_record_match_fk" FOREIGN KEY ("match_id") REFERENCES "app"."duplicate_candidate_match"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person_merge_record" ADD CONSTRAINT "person_merge_record_actor_fk" FOREIGN KEY ("executed_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidacy_current_unique" ON "app"."candidacy" USING btree ("person_id","hiring_cycle_id") WHERE "app"."candidacy"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "candidacy_scope_idx" ON "app"."candidacy" USING btree ("organization_id","branch_id","team_id","current_stage","status");--> statement-breakpoint
CREATE INDEX "candidacy_person_idx" ON "app"."candidacy" USING btree ("person_id","status");--> statement-breakpoint
CREATE INDEX "candidacy_owner_idx" ON "app"."candidacy" USING btree ("owner_account_id","current_stage") WHERE "app"."candidacy"."owner_account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "candidacy_stage_history_candidacy_idx" ON "app"."candidacy_stage_history" USING btree ("candidacy_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_candidate_match_open_unique" ON "app"."duplicate_candidate_match" USING btree ("person_a_id","person_b_id","ruleset_version") WHERE "app"."duplicate_candidate_match"."status" IN ('PENDING', 'CONFIRMED_DUPLICATE');--> statement-breakpoint
CREATE INDEX "duplicate_candidate_match_review_idx" ON "app"."duplicate_candidate_match" USING btree ("organization_id","status","created_at") WHERE "app"."duplicate_candidate_match"."status" IN ('PENDING', 'CONFIRMED_DUPLICATE');--> statement-breakpoint
CREATE UNIQUE INDEX "person_candidate_account_unique" ON "app"."person" USING btree ("candidate_account_id") WHERE "app"."person"."candidate_account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "person_email_idx" ON "app"."person" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "person_phone_idx" ON "app"."person" USING btree ("phone_e164") WHERE "app"."person"."phone_e164" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "audit"."audit_event" ADD CONSTRAINT "audit_event_category_check" CHECK (category IN ('IDENTITY', 'ACCESS_CONTROL', 'SECURITY', 'RESTRICTED_ACCESS', 'CONFIGURATION', 'AUDIT_ACCESS', 'CANDIDATE_RECORD'));--> statement-breakpoint
ALTER TABLE "audit"."audit_event" ADD CONSTRAINT "audit_event_target_check" CHECK ((target_type IS NOT NULL OR target_id IS NULL) AND (target_type IS NULL OR target_type IN ('USER_ACCOUNT', 'STAFF_INVITATION', 'STAFF_RECOVERY_CASE', 'ROLE_ASSIGNMENT', 'AUTHORIZATION_CATALOG', 'PROTECTED_RESOURCE', 'AUDIT_LOG', 'ORGANIZATION', 'BRANCH', 'TEAM', 'POSITION', 'JOB_DESCRIPTION_VERSION', 'HIRING_CYCLE', 'PERSON', 'CANDIDACY', 'DUPLICATE_MATCH')) AND (target_id IS NOT NULL OR target_type IS NULL OR target_type IN ('AUTHORIZATION_CATALOG', 'AUDIT_LOG')));--> statement-breakpoint
-- ------------------------------------------------------------------------
-- Hand-written integrity controls (packet M2.2 §8, §11, §15, §22;
-- DATA_MODEL §6). Reviewed: fixed search_path, schema-qualified
-- references, no dynamic SQL, owner = migration role, no PUBLIC access.
-- Error class CN: CN001 delete refused, CN002 append-only, CN003 invalid
-- candidate owner, CN004 candidacy coherence/immutability, CN005 invalid
-- transition, CN006 merged person is frozen.
-- ------------------------------------------------------------------------
CREATE FUNCTION "app"."candidates_reject_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'candidate history is never deleted' USING ERRCODE = 'CN001';
END
$$;--> statement-breakpoint
CREATE FUNCTION "app"."candidates_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'candidate history is append-only' USING ERRCODE = 'CN002';
END
$$;--> statement-breakpoint
CREATE TRIGGER "person_no_delete" BEFORE DELETE ON "app"."person" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "person_no_truncate" BEFORE TRUNCATE ON "app"."person" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "candidacy_no_delete" BEFORE DELETE ON "app"."candidacy" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "candidacy_no_truncate" BEFORE TRUNCATE ON "app"."candidacy" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "duplicate_candidate_match_no_delete" BEFORE DELETE ON "app"."duplicate_candidate_match" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "duplicate_candidate_match_no_truncate" BEFORE TRUNCATE ON "app"."duplicate_candidate_match" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "candidacy_stage_history_append_only" BEFORE UPDATE OR DELETE ON "app"."candidacy_stage_history" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "candidacy_stage_history_no_truncate" BEFORE TRUNCATE ON "app"."candidacy_stage_history" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "person_merge_record_append_only" BEFORE UPDATE OR DELETE ON "app"."person_merge_record" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "person_merge_record_no_truncate" BEFORE TRUNCATE ON "app"."person_merge_record" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "candidate_command_receipt_append_only" BEFORE UPDATE OR DELETE ON "app"."candidate_command_receipt" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "candidate_command_receipt_no_truncate" BEFORE TRUNCATE ON "app"."candidate_command_receipt" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
-- Person: the owner must be an ACTIVE, verified CANDIDATE account; a
-- MERGED person is frozen; an ownership link is never replaced in place.
CREATE FUNCTION "app"."person_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.candidate_account_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.candidate_account_id IS DISTINCT FROM OLD.candidate_account_id)
     AND NOT EXISTS (
       SELECT 1 FROM "auth"."user" u
        WHERE u.id = NEW.candidate_account_id
          AND u.account_type = 'CANDIDATE'
          AND u.status = 'ACTIVE'
          AND u.email_verified)
  THEN
    RAISE EXCEPTION 'only a verified candidate account can own a person' USING ERRCODE = 'CN003';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'MERGED' THEN
      RAISE EXCEPTION 'a merged person is frozen' USING ERRCODE = 'CN006';
    END IF;
    IF OLD.candidate_account_id IS NOT NULL
       AND NEW.candidate_account_id IS NOT NULL
       AND NEW.candidate_account_id <> OLD.candidate_account_id THEN
      RAISE EXCEPTION 'an ownership link is never replaced' USING ERRCODE = 'CN003';
    END IF;
    IF OLD.candidate_account_id IS NOT NULL AND NEW.candidate_account_id IS NULL
       AND NEW.status <> 'MERGED' THEN
      RAISE EXCEPTION 'an ownership link is removed only by merge' USING ERRCODE = 'CN003';
    END IF;
    IF (NEW.email_normalized, NEW.created_at, NEW.created_by_account_id)
       IS DISTINCT FROM (OLD.email_normalized, OLD.created_at, OLD.created_by_account_id) THEN
      RAISE EXCEPTION 'person identity fields are immutable here' USING ERRCODE = 'CN006';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "person_guard" BEFORE INSERT OR UPDATE ON "app"."person" FOR EACH ROW EXECUTE FUNCTION "app"."person_guard"();--> statement-breakpoint
-- Candidacy: the team equals the cycle's team; the cycle, hierarchy,
-- source, references, and creation facts never change; the person
-- changes only to the survivor of a recorded merge; stages and statuses
-- only move forward.
CREATE FUNCTION "app"."candidacy_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "app"."hiring_cycle" hc
       WHERE hc.id = NEW.hiring_cycle_id AND hc.team_id IS NOT DISTINCT FROM NEW.team_id)
    THEN
      RAISE EXCEPTION 'candidacy team must equal the cycle team' USING ERRCODE = 'CN004';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.public_id, NEW.candidate_reference, NEW.hiring_cycle_id, NEW.organization_id, NEW.position_id,
      NEW.branch_id, NEW.team_id, NEW.source_code, NEW.created_at, NEW.created_by_account_id)
     IS DISTINCT FROM
     (OLD.public_id, OLD.candidate_reference, OLD.hiring_cycle_id, OLD.organization_id, OLD.position_id,
      OLD.branch_id, OLD.team_id, OLD.source_code, OLD.created_at, OLD.created_by_account_id) THEN
    RAISE EXCEPTION 'candidacy references are immutable' USING ERRCODE = 'CN004';
  END IF;
  IF NEW.person_id <> OLD.person_id AND NOT EXISTS (
    SELECT 1 FROM "app"."person_merge_record" m
     WHERE m.merged_person_id = OLD.person_id AND m.surviving_person_id = NEW.person_id)
  THEN
    RAISE EXCEPTION 'a candidacy moves only to a merge survivor' USING ERRCODE = 'CN004';
  END IF;
  IF OLD.status <> 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
    RAISE EXCEPTION 'closed candidacies do not reopen here' USING ERRCODE = 'CN005';
  END IF;
  IF OLD.current_stage = 'APPLICATION_INCOMPLETE' AND NEW.current_stage = 'PROSPECT' THEN
    RAISE EXCEPTION 'stages only move forward' USING ERRCODE = 'CN005';
  END IF;
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'start time is immutable' USING ERRCODE = 'CN004';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "candidacy_guard" BEFORE INSERT OR UPDATE ON "app"."candidacy" FOR EACH ROW EXECUTE FUNCTION "app"."candidacy_guard"();--> statement-breakpoint
-- Duplicate cases: the pair, ruleset, and signals never change; a
-- decided case is final except CONFIRMED_DUPLICATE -> MERGED.
CREATE FUNCTION "app"."duplicate_candidate_match_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.public_id, NEW.organization_id, NEW.person_a_id, NEW.person_b_id, NEW.ruleset_version,
      NEW.signal_codes, NEW.confidence_tier, NEW.created_at)
     IS DISTINCT FROM
     (OLD.public_id, OLD.organization_id, OLD.person_a_id, OLD.person_b_id, OLD.ruleset_version,
      OLD.signal_codes, OLD.confidence_tier, OLD.created_at) THEN
    RAISE EXCEPTION 'duplicate evidence is immutable' USING ERRCODE = 'CN004';
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('CONFIRMED_DUPLICATE', 'NOT_DUPLICATE'))
    OR (OLD.status = 'CONFIRMED_DUPLICATE' AND NEW.status = 'MERGED'
        AND (NEW.reviewed_by_account_id, NEW.reviewed_at, NEW.reason_code)
            IS NOT DISTINCT FROM (OLD.reviewed_by_account_id, OLD.reviewed_at, OLD.reason_code))
  ) THEN
    RAISE EXCEPTION 'invalid duplicate case transition' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "duplicate_candidate_match_guard" BEFORE UPDATE ON "app"."duplicate_candidate_match" FOR EACH ROW EXECUTE FUNCTION "app"."duplicate_candidate_match_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."candidates_reject_delete"(), "app"."candidates_append_only"(), "app"."person_guard"(), "app"."candidacy_guard"(), "app"."duplicate_candidate_match_guard"() FROM PUBLIC;
