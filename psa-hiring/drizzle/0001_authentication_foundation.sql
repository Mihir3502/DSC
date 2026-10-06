CREATE SCHEMA IF NOT EXISTS "auth";
--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email_display" varchar(320),
	"account_type" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"last_authenticated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason_code" varchar(40),
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_account_type_check" CHECK ("auth"."user"."account_type" IN ('CANDIDATE', 'STAFF', 'SERVICE')),
	CONSTRAINT "user_status_check" CHECK ("auth"."user"."status" IN ('INVITED', 'ACTIVE', 'LOCKED', 'DISABLED', 'CLOSED')),
	CONSTRAINT "user_disabled_reason_code_check" CHECK ("auth"."user"."disabled_reason_code" IS NULL OR "auth"."user"."disabled_reason_code" IN ('SECURITY_LOCK', 'ADMINISTRATIVE_DISABLE', 'ACCOUNT_CLOSED')),
	CONSTRAINT "user_restriction_metadata_check" CHECK (("auth"."user"."status" IN ('LOCKED', 'DISABLED', 'CLOSED')) = ("auth"."user"."disabled_at" IS NOT NULL AND "auth"."user"."disabled_reason_code" IS NOT NULL)),
	CONSTRAINT "user_email_normalized_check" CHECK ("auth"."user"."email" = lower("auth"."user"."email") AND "auth"."user"."email" = btrim("auth"."user"."email") AND char_length("auth"."user"."email") BETWEEN 3 AND 254),
	CONSTRAINT "user_name_length_check" CHECK (char_length("auth"."user"."name") BETWEEN 1 AND 200),
	CONSTRAINT "user_version_check" CHECK ("auth"."user"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");