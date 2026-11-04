CREATE TABLE "app"."document" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"public_id" varchar(12) NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"category_code" varchar(32) NOT NULL,
	"data_classification" varchar(32) NOT NULL,
	"retention_class_code" varchar(64) NOT NULL,
	"current_version_id" uuid,
	"status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "document_public_id_check" CHECK ("app"."document"."public_id" ~ '^[0-9a-hjkmnp-tv-z]{12}$'),
	CONSTRAINT "document_category_check" CHECK ("app"."document"."category_code" IN ('RESUME', 'CREDENTIAL')),
	CONSTRAINT "document_classification_check" CHECK ("app"."document"."data_classification" = 'CONFIDENTIAL_PERSONNEL'),
	CONSTRAINT "document_retention_check" CHECK ("app"."document"."retention_class_code" = 'APPLICATION_ATTACHMENT_UNSET'),
	CONSTRAINT "document_status_check" CHECK ("app"."document"."status" IN ('ACTIVE', 'REMOVED')),
	CONSTRAINT "document_version_check" CHECK ("app"."document"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."document_version" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"storage_provider_code" varchar(32) NOT NULL,
	"storage_object_key" uuid NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"media_type" varchar(32) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"scan_status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"scanner_code" varchar(32),
	"supersedes_id" uuid,
	"uploaded_by_account_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "document_version_number_unique" UNIQUE("document_id","version_number"),
	CONSTRAINT "document_version_key_unique" UNIQUE("storage_object_key"),
	CONSTRAINT "document_version_number_check" CHECK ("app"."document_version"."version_number" >= 1),
	CONSTRAINT "document_version_media_check" CHECK ("app"."document_version"."media_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "document_version_size_check" CHECK ("app"."document_version"."size_bytes" BETWEEN 1 AND 10485760),
	CONSTRAINT "document_version_hash_check" CHECK ("app"."document_version"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_version_scan_check" CHECK ("app"."document_version"."scan_status" IN ('PENDING', 'CLEAN', 'REJECTED', 'FAILED')),
	CONSTRAINT "document_version_finalized_check" CHECK (("app"."document_version"."scan_status" = 'PENDING') = ("app"."document_version"."finalized_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "audit"."audit_event" DROP CONSTRAINT "audit_event_target_check";--> statement-breakpoint
ALTER TABLE "app"."document" ADD CONSTRAINT "document_candidacy_fk" FOREIGN KEY ("candidacy_id") REFERENCES "app"."candidacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document" ADD CONSTRAINT "document_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_version" ADD CONSTRAINT "document_version_document_fk" FOREIGN KEY ("document_id") REFERENCES "app"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_version" ADD CONSTRAINT "document_version_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "app"."document_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_version" ADD CONSTRAINT "document_version_uploaded_by_fk" FOREIGN KEY ("uploaded_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_candidacy_idx" ON "app"."document" USING btree ("candidacy_id","status");--> statement-breakpoint
CREATE INDEX "document_version_pending_idx" ON "app"."document_version" USING btree ("scan_status","uploaded_at") WHERE "app"."document_version"."scan_status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "audit"."audit_event" ADD CONSTRAINT "audit_event_target_check" CHECK ((target_type IS NOT NULL OR target_id IS NULL) AND (target_type IS NULL OR target_type IN ('USER_ACCOUNT', 'STAFF_INVITATION', 'STAFF_RECOVERY_CASE', 'ROLE_ASSIGNMENT', 'AUTHORIZATION_CATALOG', 'PROTECTED_RESOURCE', 'AUDIT_LOG', 'ORGANIZATION', 'BRANCH', 'TEAM', 'POSITION', 'JOB_DESCRIPTION_VERSION', 'HIRING_CYCLE', 'PERSON', 'CANDIDACY', 'DUPLICATE_MATCH', 'DOCUMENT')) AND (target_id IS NOT NULL OR target_type IS NULL OR target_type IN ('AUTHORIZATION_CATALOG', 'AUDIT_LOG')));--> statement-breakpoint
-- ------------------------------------------------------------------------
-- Hand-written integrity controls (packet M2.5 §6, §9; DATA_MODEL §12).
-- Reviewed: fixed search_path, schema-qualified references, no dynamic SQL.
-- Error class CN as in 0006: CN004 immutable reference, CN005 invalid
-- transition. Added here because the two tables refer to each other.
-- ------------------------------------------------------------------------
ALTER TABLE "app"."document" ADD CONSTRAINT "document_current_version_fk" FOREIGN KEY ("current_version_id") REFERENCES "app"."document_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER "document_no_delete" BEFORE DELETE ON "app"."document" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "document_no_truncate" BEFORE TRUNCATE ON "app"."document" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "document_version_no_delete" BEFORE DELETE ON "app"."document_version" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "document_version_no_truncate" BEFORE TRUNCATE ON "app"."document_version" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
-- A document keeps its identity, adds one version per change, stays removed
-- once removed, and points only at its own clean version.
CREATE FUNCTION "app"."document_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.public_id, NEW.candidacy_id, NEW.category_code, NEW.data_classification, NEW.retention_class_code, NEW.created_by_account_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.public_id, OLD.candidacy_id, OLD.category_code, OLD.data_classification, OLD.retention_class_code, OLD.created_by_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'document references are immutable' USING ERRCODE = 'CN004';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a document change adds one version' USING ERRCODE = 'CN005';
  END IF;
  IF OLD.status = 'REMOVED' AND NEW.status <> 'REMOVED' THEN
    RAISE EXCEPTION 'a removed document stays removed' USING ERRCODE = 'CN005';
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
     AND NOT EXISTS (
       SELECT 1 FROM "app"."document_version" v
        WHERE v.id = NEW.current_version_id AND v.document_id = NEW.id AND v.scan_status = 'CLEAN')
  THEN
    RAISE EXCEPTION 'the current version must be this document''s clean version' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "document_guard" BEFORE UPDATE ON "app"."document" FOR EACH ROW EXECUTE FUNCTION "app"."document_guard"();--> statement-breakpoint
-- A version is evidence: only its pending scan can finish, once, and it
-- always starts pending.
CREATE FUNCTION "app"."document_version_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.scan_status <> 'PENDING' THEN
      RAISE EXCEPTION 'a version starts pending' USING ERRCODE = 'CN005';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.scan_status <> 'PENDING' THEN
    RAISE EXCEPTION 'a finished version is history' USING ERRCODE = 'CN005';
  END IF;
  IF (NEW.document_id, NEW.version_number, NEW.storage_provider_code, NEW.storage_object_key, NEW.display_name, NEW.media_type, NEW.size_bytes, NEW.content_hash, NEW.supersedes_id, NEW.uploaded_by_account_id, NEW.uploaded_at)
     IS DISTINCT FROM
     (OLD.document_id, OLD.version_number, OLD.storage_provider_code, OLD.storage_object_key, OLD.display_name, OLD.media_type, OLD.size_bytes, OLD.content_hash, OLD.supersedes_id, OLD.uploaded_by_account_id, OLD.uploaded_at) THEN
    RAISE EXCEPTION 'version evidence is immutable' USING ERRCODE = 'CN004';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "document_version_guard" BEFORE INSERT OR UPDATE ON "app"."document_version" FOR EACH ROW EXECUTE FUNCTION "app"."document_version_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."document_guard"(), "app"."document_version_guard"() FROM PUBLIC;
