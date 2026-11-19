-- R1-9 / Q-A4: controlled CHANGE_REVIEW facts and explicit print-start approval.
--
-- These columns are optional together so every historical revision remains
-- valid. The API requires the complete set whenever a superseding revision
-- enters CHANGE_REVIEW; zero impact/cost values must be submitted explicitly.
-- No existing rows are changed.

ALTER TABLE "artwork_revisions"
  ADD COLUMN "change_requested_organization" "approval_organization";--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD COLUMN "change_reason" text;--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD COLUMN "change_evidence_document_version_id" uuid;--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD COLUMN "impact_schedule" text;--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD COLUMN "impact_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD COLUMN "impact_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD COLUMN "actual_cost" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD COLUMN "printed_change_approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD COLUMN "printed_change_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_change_request_fields_pair" CHECK ((
    "change_requested_organization" is null and "change_reason" is null
    and "change_evidence_document_version_id" is null and "impact_schedule" is null
    and "impact_quantity" is null and "impact_amount" is null
    and "actual_cost" is null
  ) or (
    "change_requested_organization" is not null and "change_reason" is not null
    and "change_evidence_document_version_id" is not null and "impact_schedule" is not null
    and "impact_quantity" is not null and "impact_amount" is not null
    and "actual_cost" is not null
  ));--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_change_reason_not_blank" CHECK ("change_reason" is null or length(btrim("change_reason")) > 0);--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_lot_change_marking_required" CHECK ("change_requested_organization" is null or length(btrim("lot_marking")) > 0);--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_impact_schedule_not_blank" CHECK ("impact_schedule" is null or length(btrim("impact_schedule")) > 0);--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_impact_quantity_nonnegative" CHECK ("impact_quantity" is null or "impact_quantity" >= 0);--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_actual_cost_nonnegative" CHECK ("actual_cost" is null or "actual_cost" >= 0);--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_printed_change_approval_pair" CHECK (("printed_change_approved_at" is null) = ("printed_change_approved_by_user_id" is null));--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_change_evidence_document_version_id_document_versions_id_fk"
  FOREIGN KEY ("change_evidence_document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_printed_change_approved_by_user_id_users_id_fk"
  FOREIGN KEY ("printed_change_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
