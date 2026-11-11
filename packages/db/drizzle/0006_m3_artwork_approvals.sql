CREATE TYPE "public"."approval_organization" AS ENUM('customer', 'seven');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('APPROVE', 'REVOKE');--> statement-breakpoint
CREATE TYPE "public"."approval_evidence_source" AS ENUM('email', 'signed_document', 'other_verified');--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "film_supply_order_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "design_key" text;--> statement-breakpoint
CREATE TABLE "artwork_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_supply_order_id" uuid NOT NULL,
	"design_key" text NOT NULL,
	"revision_no" integer NOT NULL,
	"file_document_version_id" uuid NOT NULL,
	"lot_marking" text,
	"note" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artwork_revisions_order_design_revision_unique" UNIQUE("film_supply_order_id","design_key","revision_no")
);
--> statement-breakpoint
CREATE TABLE "artwork_approval_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artwork_revision_id" uuid NOT NULL,
	"organization" "approval_organization" NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"external_approver_name" text,
	"external_approver_org" text,
	"recorded_by_user_id" uuid NOT NULL,
	"evidence_document_version_id" uuid NOT NULL,
	"evidence_source" "approval_evidence_source" NOT NULL,
	"approved_file_sha256" text NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_event_id" uuid,
	CONSTRAINT "artwork_approval_events_sha256_format" CHECK ("artwork_approval_events"."approved_file_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_film_supply_order_id_film_supply_orders_id_fk" FOREIGN KEY ("film_supply_order_id") REFERENCES "public"."film_supply_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_artwork_binding_pair" CHECK (("documents"."film_supply_order_id" is null and "documents"."design_key" is null) or ("documents"."film_supply_order_id" is not null and "documents"."design_key" is not null));--> statement-breakpoint
ALTER TABLE "artwork_revisions" ADD CONSTRAINT "artwork_revisions_film_supply_order_id_film_supply_orders_id_fk" FOREIGN KEY ("film_supply_order_id") REFERENCES "public"."film_supply_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_revisions" ADD CONSTRAINT "artwork_revisions_file_document_version_id_document_versions_id_fk" FOREIGN KEY ("file_document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_revisions" ADD CONSTRAINT "artwork_revisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_revisions" ADD CONSTRAINT "artwork_revisions_revision_no_positive" CHECK ("artwork_revisions"."revision_no" > 0);--> statement-breakpoint
ALTER TABLE "artwork_revisions" ADD CONSTRAINT "artwork_revisions_design_key_not_blank" CHECK (length(btrim("artwork_revisions"."design_key")) > 0);--> statement-breakpoint
ALTER TABLE "artwork_approval_events" ADD CONSTRAINT "artwork_approval_events_artwork_revision_id_artwork_revisions_id_fk" FOREIGN KEY ("artwork_revision_id") REFERENCES "public"."artwork_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_approval_events" ADD CONSTRAINT "artwork_approval_events_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_approval_events" ADD CONSTRAINT "artwork_approval_events_evidence_document_version_id_document_versions_id_fk" FOREIGN KEY ("evidence_document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_approval_events" ADD CONSTRAINT "artwork_approval_events_supersedes_event_id_artwork_approval_events_id_fk" FOREIGN KEY ("supersedes_event_id") REFERENCES "public"."artwork_approval_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_film_supply_order_idx" ON "documents" USING btree ("film_supply_order_id");--> statement-breakpoint
CREATE INDEX "artwork_revisions_order_design_idx" ON "artwork_revisions" USING btree ("film_supply_order_id","design_key");--> statement-breakpoint
CREATE INDEX "artwork_revisions_file_version_idx" ON "artwork_revisions" USING btree ("file_document_version_id");--> statement-breakpoint
CREATE INDEX "artwork_approval_events_revision_idx" ON "artwork_approval_events" USING btree ("artwork_revision_id");--> statement-breakpoint
CREATE INDEX "artwork_approval_events_organization_idx" ON "artwork_approval_events" USING btree ("organization");--> statement-breakpoint
CREATE INDEX "artwork_approval_events_supersedes_idx" ON "artwork_approval_events" USING btree ("supersedes_event_id");
