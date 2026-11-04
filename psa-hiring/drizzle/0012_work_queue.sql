CREATE TABLE "app"."work_responsibility_history" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"work_item_id" uuid,
	"change_code" varchar(32) NOT NULL,
	"previous_owner_account_id" uuid,
	"new_owner_account_id" uuid,
	"previous_due_at" timestamp with time zone,
	"new_due_at" timestamp with time zone,
	"reason_code" varchar(64),
	"actor_account_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_responsibility_history_change_check" CHECK (CASE "app"."work_responsibility_history"."change_code"
        WHEN 'OWNER_ASSIGNED' THEN "app"."work_responsibility_history"."work_item_id" IS NULL AND "app"."work_responsibility_history"."previous_owner_account_id" IS NULL AND "app"."work_responsibility_history"."new_owner_account_id" IS NOT NULL AND "app"."work_responsibility_history"."new_due_at" IS NULL AND "app"."work_responsibility_history"."previous_due_at" IS NULL
        WHEN 'OWNER_REASSIGNED' THEN "app"."work_responsibility_history"."work_item_id" IS NULL AND "app"."work_responsibility_history"."previous_owner_account_id" IS NOT NULL AND "app"."work_responsibility_history"."new_owner_account_id" IS NOT NULL AND "app"."work_responsibility_history"."previous_owner_account_id" <> "app"."work_responsibility_history"."new_owner_account_id" AND "app"."work_responsibility_history"."new_due_at" IS NULL AND "app"."work_responsibility_history"."previous_due_at" IS NULL
        WHEN 'OWNER_RELEASED' THEN "app"."work_responsibility_history"."work_item_id" IS NULL AND "app"."work_responsibility_history"."previous_owner_account_id" IS NOT NULL AND "app"."work_responsibility_history"."new_owner_account_id" IS NULL AND "app"."work_responsibility_history"."new_due_at" IS NULL AND "app"."work_responsibility_history"."previous_due_at" IS NULL
        WHEN 'DUE_DATE_SET' THEN "app"."work_responsibility_history"."work_item_id" IS NOT NULL AND "app"."work_responsibility_history"."previous_owner_account_id" IS NULL AND "app"."work_responsibility_history"."new_owner_account_id" IS NULL AND "app"."work_responsibility_history"."new_due_at" IS NOT NULL AND "app"."work_responsibility_history"."previous_due_at" IS DISTINCT FROM "app"."work_responsibility_history"."new_due_at"
        WHEN 'DUE_DATE_CLEARED' THEN "app"."work_responsibility_history"."work_item_id" IS NOT NULL AND "app"."work_responsibility_history"."previous_owner_account_id" IS NULL AND "app"."work_responsibility_history"."new_owner_account_id" IS NULL AND "app"."work_responsibility_history"."new_due_at" IS NULL AND "app"."work_responsibility_history"."previous_due_at" IS NOT NULL
        ELSE false END),
	CONSTRAINT "work_responsibility_history_reason_check" CHECK ("app"."work_responsibility_history"."reason_code" IS NULL OR "app"."work_responsibility_history"."reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
ALTER TABLE "app"."work_item" ADD CONSTRAINT "work_item_id_candidacy_unique" UNIQUE("id","candidacy_id");--> statement-breakpoint
ALTER TABLE "app"."work_responsibility_history" ADD CONSTRAINT "work_responsibility_history_candidacy_fk" FOREIGN KEY ("candidacy_id") REFERENCES "app"."candidacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_responsibility_history" ADD CONSTRAINT "work_responsibility_history_item_fk" FOREIGN KEY ("work_item_id","candidacy_id") REFERENCES "app"."work_item"("id","candidacy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_responsibility_history" ADD CONSTRAINT "work_responsibility_history_previous_owner_fk" FOREIGN KEY ("previous_owner_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_responsibility_history" ADD CONSTRAINT "work_responsibility_history_new_owner_fk" FOREIGN KEY ("new_owner_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_responsibility_history" ADD CONSTRAINT "work_responsibility_history_actor_fk" FOREIGN KEY ("actor_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_responsibility_history_candidacy_idx" ON "app"."work_responsibility_history" USING btree ("candidacy_id","occurred_at");--> statement-breakpoint
CREATE INDEX "candidacy_work_queue_idx" ON "app"."candidacy" USING btree ("created_at","public_id") WHERE "app"."candidacy"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "work_item_staff_queue_idx" ON "app"."work_item" USING btree ("candidacy_id","due_at") WHERE "app"."work_item"."candidate_action_required" = false AND "app"."work_item"."status" IN ('OPEN', 'IN_PROGRESS', 'BLOCKED');--> statement-breakpoint
ALTER TABLE "app"."work_item" ADD CONSTRAINT "work_item_due_staff_check" CHECK ("app"."work_item"."due_at" IS NULL OR "app"."work_item"."candidate_action_required" = false);--> statement-breakpoint
-- Hand-written tail (packet M3.1 §6): history is append-only for every role.
CREATE TRIGGER "work_responsibility_history_append_only" BEFORE UPDATE OR DELETE ON "app"."work_responsibility_history" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "work_responsibility_history_no_truncate" BEFORE TRUNCATE ON "app"."work_responsibility_history" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();
