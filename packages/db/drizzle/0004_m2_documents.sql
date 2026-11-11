CREATE TYPE "public"."document_type" AS ENUM('seven_po', 'filling_quote_seven', 'film_quote_kanei', 'proof', 'approval_evidence', 'send_evidence', 'acceptance_evidence');--> statement-breakpoint
CREATE TYPE "public"."issuer_entity" AS ENUM('seven', 'kanei', 'maker', 'customer_generated', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'verified', 'mismatch');--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"original_filename" text NOT NULL,
	"declared_mime_type" text NOT NULL,
	"detected_mime_type" text,
	"size_check_passed" boolean NOT NULL,
	"type_check_passed" boolean NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_document_version_unique" UNIQUE("document_id","version_number"),
	CONSTRAINT "document_versions_document_sha256_unique" UNIQUE("document_id","sha256"),
	CONSTRAINT "document_versions_sha256_format" CHECK ("document_versions"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_versions_byte_size_positive" CHECK ("document_versions"."byte_size" > 0),
	CONSTRAINT "document_versions_checks_passed" CHECK ("document_versions"."size_check_passed" = true and "document_versions"."type_check_passed" = true)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"document_type" "document_type" NOT NULL,
	"issuer_entity" "issuer_entity" NOT NULL,
	"original_filename" text NOT NULL,
	"note" text,
	"pre_order_reference_id" uuid,
	"seven_purchase_order_id" uuid,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"verification_note" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_project_type_issuer_filename_unique" UNIQUE("project_id","document_type","issuer_entity","original_filename"),
	CONSTRAINT "documents_official_artifact_requires_po" CHECK ("documents"."document_type" in ('seven_po', 'filling_quote_seven', 'film_quote_kanei') or "documents"."seven_purchase_order_id" is not null),
	CONSTRAINT "documents_verification_fields_pair" CHECK (("documents"."verification_status" = 'unverified' and "documents"."verified_at" is null and "documents"."verified_by_user_id" is null) or ("documents"."verification_status" in ('verified', 'mismatch') and "documents"."verified_at" is not null and "documents"."verified_by_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD COLUMN "verification_status" "verification_status" DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD COLUMN "verified_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD COLUMN "verification_note" text;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD COLUMN "authenticity_checklist" jsonb;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD COLUMN "review_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_pre_order_reference_id_pre_order_references_id_fk" FOREIGN KEY ("pre_order_reference_id") REFERENCES "public"."pre_order_references"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_seven_purchase_order_id_seven_purchase_orders_id_fk" FOREIGN KEY ("seven_purchase_order_id") REFERENCES "public"."seven_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD CONSTRAINT "seven_purchase_orders_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD CONSTRAINT "seven_purchase_orders_verification_fields_pair" CHECK (("seven_purchase_orders"."verification_status" = 'unverified' and "seven_purchase_orders"."verified_at" is null and "seven_purchase_orders"."verified_by_user_id" is null) or ("seven_purchase_orders"."verification_status" in ('verified', 'mismatch') and "seven_purchase_orders"."verified_at" is not null and "seven_purchase_orders"."verified_by_user_id" is not null));--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD CONSTRAINT "seven_purchase_orders_review_pending_has_note" CHECK (("seven_purchase_orders"."review_pending" = false) or ("seven_purchase_orders"."review_note" is not null));--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "documents_type_idx" ON "documents" USING btree ("document_type");--> statement-breakpoint
CREATE INDEX "documents_seven_purchase_order_idx" ON "documents" USING btree ("seven_purchase_order_id");--> statement-breakpoint
CREATE INDEX "documents_pre_order_reference_idx" ON "documents" USING btree ("pre_order_reference_id");--> statement-breakpoint
CREATE INDEX "document_versions_sha256_idx" ON "document_versions" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "document_versions_document_idx" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "seven_purchase_orders_verification_status_idx" ON "seven_purchase_orders" USING btree ("verification_status");
