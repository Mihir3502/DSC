CREATE TABLE "auth"."two_factor" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "two_factor_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "two_factor_failed_count_check" CHECK ("auth"."two_factor"."failed_verification_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth"."staff_invitation" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_display" varchar(320) NOT NULL,
	"purpose" varchar(24) NOT NULL,
	"status" varchar(16) NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"account_id" uuid,
	"issuer_account_id" uuid,
	"issuer_reason_code" varchar(32) NOT NULL,
	"recovery_case_id" uuid,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invitation_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "staff_invitation_status_check" CHECK ("auth"."staff_invitation"."status" IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'SUPERSEDED')),
	CONSTRAINT "staff_invitation_purpose_check" CHECK ("auth"."staff_invitation"."purpose" IN ('STAFF_ACTIVATION', 'STAFF_REENROLLMENT')),
	CONSTRAINT "staff_invitation_issuer_reason_check" CHECK ("auth"."staff_invitation"."issuer_reason_code" IN ('LOCAL_BOOTSTRAP', 'TEST_HARNESS', 'RECOVERY_REENROLLMENT')),
	CONSTRAINT "staff_invitation_email_normalized_check" CHECK ("auth"."staff_invitation"."email" = lower("auth"."staff_invitation"."email") AND "auth"."staff_invitation"."email" = btrim("auth"."staff_invitation"."email") AND char_length("auth"."staff_invitation"."email") BETWEEN 3 AND 254),
	CONSTRAINT "staff_invitation_token_digest_check" CHECK ("auth"."staff_invitation"."token_digest" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "staff_invitation_sequence_check" CHECK ("auth"."staff_invitation"."sequence" >= 1),
	CONSTRAINT "staff_invitation_version_check" CHECK ("auth"."staff_invitation"."version" >= 1),
	CONSTRAINT "staff_invitation_expiry_check" CHECK ("auth"."staff_invitation"."expires_at" > "auth"."staff_invitation"."issued_at"),
	CONSTRAINT "staff_invitation_accepted_check" CHECK (("auth"."staff_invitation"."status" = 'ACCEPTED') = ("auth"."staff_invitation"."accepted_at" IS NOT NULL) AND ("auth"."staff_invitation"."status" <> 'ACCEPTED' OR ("auth"."staff_invitation"."account_id" IS NOT NULL AND "auth"."staff_invitation"."accepted_at" <= "auth"."staff_invitation"."expires_at"))),
	CONSTRAINT "staff_invitation_revoked_check" CHECK (("auth"."staff_invitation"."status" = 'REVOKED') = ("auth"."staff_invitation"."revoked_at" IS NOT NULL)),
	CONSTRAINT "staff_invitation_superseded_check" CHECK (("auth"."staff_invitation"."status" = 'SUPERSEDED') = ("auth"."staff_invitation"."superseded_at" IS NOT NULL)),
	CONSTRAINT "staff_invitation_expired_check" CHECK (("auth"."staff_invitation"."status" = 'EXPIRED') = ("auth"."staff_invitation"."expired_at" IS NOT NULL)),
	CONSTRAINT "staff_invitation_reenrollment_check" CHECK ("auth"."staff_invitation"."purpose" <> 'STAFF_REENROLLMENT' OR ("auth"."staff_invitation"."account_id" IS NOT NULL AND "auth"."staff_invitation"."recovery_case_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "auth"."staff_recovery_case" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" varchar(32) NOT NULL,
	"reason_code" varchar(32) NOT NULL,
	"resolution_code" varchar(32),
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verification_started_at" timestamp with time zone,
	"identity_verified_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approval_expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"verifier_account_id" uuid,
	"approver_account_id" uuid,
	"completed_by_account_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_recovery_case_status_check" CHECK ("auth"."staff_recovery_case"."status" IN ('REQUESTED', 'IDENTITY_VERIFICATION_PENDING', 'APPROVAL_PENDING', 'APPROVED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
	CONSTRAINT "staff_recovery_case_reason_check" CHECK ("auth"."staff_recovery_case"."reason_code" IN ('LOST_AUTHENTICATOR', 'FORGOTTEN_PASSWORD', 'SUSPECTED_COMPROMISE', 'UNSPECIFIED')),
	CONSTRAINT "staff_recovery_case_resolution_check" CHECK (("auth"."staff_recovery_case"."status" IN ('COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED')) = ("auth"."staff_recovery_case"."resolved_at" IS NOT NULL AND "auth"."staff_recovery_case"."resolution_code" IS NOT NULL)),
	CONSTRAINT "staff_recovery_case_resolution_code_check" CHECK ("auth"."staff_recovery_case"."resolution_code" IS NULL OR "auth"."staff_recovery_case"."resolution_code" IN ('RESET_COMPLETED', 'IDENTITY_NOT_VERIFIED', 'APPROVAL_DENIED', 'REQUEST_CANCELLED', 'REQUEST_EXPIRED', 'APPROVAL_EXPIRED')),
	CONSTRAINT "staff_recovery_case_expiry_check" CHECK ("auth"."staff_recovery_case"."expires_at" > "auth"."staff_recovery_case"."requested_at"),
	CONSTRAINT "staff_recovery_case_separation_check" CHECK (("auth"."staff_recovery_case"."verifier_account_id" IS NULL OR "auth"."staff_recovery_case"."verifier_account_id" <> "auth"."staff_recovery_case"."account_id") AND ("auth"."staff_recovery_case"."approver_account_id" IS NULL OR ("auth"."staff_recovery_case"."approver_account_id" <> "auth"."staff_recovery_case"."account_id" AND "auth"."staff_recovery_case"."approver_account_id" IS DISTINCT FROM "auth"."staff_recovery_case"."verifier_account_id"))),
	CONSTRAINT "staff_recovery_case_approval_check" CHECK (("auth"."staff_recovery_case"."approved_at" IS NULL) = ("auth"."staff_recovery_case"."approver_account_id" IS NULL) AND ("auth"."staff_recovery_case"."approved_at" IS NULL) = ("auth"."staff_recovery_case"."approval_expires_at" IS NULL)),
	CONSTRAINT "staff_recovery_case_version_check" CHECK ("auth"."staff_recovery_case"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "auth"."totp_replay_guard" (
	"user_id" uuid NOT NULL,
	"code_digest" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "totp_replay_guard_pk" PRIMARY KEY("user_id","code_digest")
);
--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "auth_purpose" varchar(24);--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "auth_method" varchar(32);--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "primary_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "mfa_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "account_version" integer;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "reauthenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "reauthentication_method" varchar(32);--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "reauthentication_purpose" varchar(64);--> statement-breakpoint
ALTER TABLE "auth"."user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."staff_invitation" ADD CONSTRAINT "staff_invitation_account_id_user_id_fk" FOREIGN KEY ("account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."staff_invitation" ADD CONSTRAINT "staff_invitation_issuer_account_id_user_id_fk" FOREIGN KEY ("issuer_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."staff_invitation" ADD CONSTRAINT "staff_invitation_recovery_case_id_staff_recovery_case_id_fk" FOREIGN KEY ("recovery_case_id") REFERENCES "auth"."staff_recovery_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."staff_invitation" ADD CONSTRAINT "staff_invitation_superseded_by_id_staff_invitation_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "auth"."staff_invitation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."staff_recovery_case" ADD CONSTRAINT "staff_recovery_case_account_id_user_id_fk" FOREIGN KEY ("account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."staff_recovery_case" ADD CONSTRAINT "staff_recovery_case_verifier_account_id_user_id_fk" FOREIGN KEY ("verifier_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."staff_recovery_case" ADD CONSTRAINT "staff_recovery_case_approver_account_id_user_id_fk" FOREIGN KEY ("approver_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."staff_recovery_case" ADD CONSTRAINT "staff_recovery_case_completed_by_account_id_user_id_fk" FOREIGN KEY ("completed_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."totp_replay_guard" ADD CONSTRAINT "totp_replay_guard_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "auth"."two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "auth"."two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invitation_one_pending_per_email" ON "auth"."staff_invitation" USING btree ("email") WHERE "auth"."staff_invitation"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "staff_invitation_account_idx" ON "auth"."staff_invitation" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_recovery_case_one_open_per_account" ON "auth"."staff_recovery_case" USING btree ("account_id") WHERE "auth"."staff_recovery_case"."status" IN ('REQUESTED', 'IDENTITY_VERIFICATION_PENDING', 'APPROVAL_PENDING', 'APPROVED');--> statement-breakpoint
CREATE INDEX "totp_replay_guard_expires_idx" ON "auth"."totp_replay_guard" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_auth_purpose_check" CHECK ("auth"."session"."auth_purpose" IS NULL OR "auth"."session"."auth_purpose" IN ('STANDARD', 'STAFF_FIRST_FACTOR', 'STAFF_ACTIVATION', 'STAFF'));--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_auth_method_check" CHECK ("auth"."session"."auth_method" IS NULL OR "auth"."session"."auth_method" IN ('PASSWORD', 'PASSWORD_TOTP', 'PASSWORD_BACKUP_CODE'));--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_staff_assurance_check" CHECK ("auth"."session"."auth_purpose" IS DISTINCT FROM 'STAFF' OR ("auth"."session"."auth_method" IN ('PASSWORD_TOTP', 'PASSWORD_BACKUP_CODE') AND "auth"."session"."primary_authenticated_at" IS NOT NULL AND "auth"."session"."mfa_authenticated_at" IS NOT NULL AND "auth"."session"."account_version" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_reauthentication_check" CHECK (("auth"."session"."reauthenticated_at" IS NULL AND "auth"."session"."reauthentication_method" IS NULL AND "auth"."session"."reauthentication_purpose" IS NULL) OR ("auth"."session"."reauthenticated_at" IS NOT NULL AND "auth"."session"."reauthentication_method" = 'PASSWORD_TOTP' AND "auth"."session"."reauthentication_purpose" ~ '^[A-Z_]{1,64}$'));