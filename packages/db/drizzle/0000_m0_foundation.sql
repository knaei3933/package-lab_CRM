CREATE TYPE "public"."account_role" AS ENUM('end_customer', 'seven', 'maker');--> statement-breakpoint
CREATE TYPE "public"."business_unit" AS ENUM('F1');--> statement-breakpoint
CREATE TYPE "public"."project_route" AS ENUM('F1');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'staff', 'viewer');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" "account_role" NOT NULL,
	"external_code" text,
	"contact_email" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "accounts_external_code_unique" UNIQUE("external_code"),
	CONSTRAINT "accounts_active_role_name_unique" UNIQUE("name","role")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "project_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_assignments_user_project_unique" UNIQUE("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"business_unit" "business_unit" NOT NULL,
	"route" "project_route" NOT NULL,
	"lead_source" text NOT NULL,
	"status" "project_status" DEFAULT 'DRAFT' NOT NULL,
	"end_customer_account_id" uuid NOT NULL,
	"seven_account_id" uuid NOT NULL,
	"maker_account_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "projects_code_unique" UNIQUE("code"),
	CONSTRAINT "projects_f1_only" CHECK ("projects"."route" = 'F1' and "projects"."business_unit" = 'F1' and "projects"."lead_source" = 'KANEI'),
	CONSTRAINT "projects_required_accounts_distinct" CHECK ("projects"."end_customer_account_id" <> "projects"."seven_account_id" and "projects"."end_customer_account_id" <> "projects"."maker_account_id" and "projects"."seven_account_id" <> "projects"."maker_account_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('admin', 'staff', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assignments" ADD CONSTRAINT "project_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assignments" ADD CONSTRAINT "project_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_end_customer_account_id_accounts_id_fk" FOREIGN KEY ("end_customer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_seven_account_id_accounts_id_fk" FOREIGN KEY ("seven_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_maker_account_id_accounts_id_fk" FOREIGN KEY ("maker_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_role_idx" ON "accounts" USING btree ("role");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "project_assignments_project_idx" ON "project_assignments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_business_route_idx" ON "projects" USING btree ("business_unit","route");--> statement-breakpoint
CREATE INDEX "projects_created_by_idx" ON "projects" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");