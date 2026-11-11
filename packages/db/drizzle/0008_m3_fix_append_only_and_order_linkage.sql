-- M3 repair migration (T-12 and the M3 audit-transaction test).
--
-- Two defects are repaired idempotently, so a database that was migrated from
-- an earlier revision of migrations 0006/0007 is healed in place:
--
-- 1. The append-only trigger functions and triggers on artwork_approval_events
--    and artwork_revisions are re-applied verbatim from migration 0007. A
--    trigger function body is only updated when CREATE OR REPLACE runs again,
--    so a database holding an earlier wording of the rejection message would
--    keep raising exceptions that no longer name the immutability contract.
--    Re-applying guarantees every rejection message contains "append-only".
-- 2. The documents order linkage (design section 5.4: documents carry
--    project_id and order_id) is ensured: film_supply_order_id and design_key
--    exist, the pair check and the foreign key are in place, and the lookup
--    index exists. Approval evidence, send evidence and acceptance evidence
--    must record the order and design they belong to.
CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_approval_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artwork_approval_events are append-only; record a REVOKE or a superseding APPROVE instead of rewriting a decision';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_artwork_revision_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.film_supply_order_id IS DISTINCT FROM OLD.film_supply_order_id
     OR NEW.design_key IS DISTINCT FROM OLD.design_key
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.file_document_version_id IS DISTINCT FROM OLD.file_document_version_id THEN
    RAISE EXCEPTION 'artwork_revisions are append-only; register a new revision instead of rewriting artwork history';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_artwork_revision_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artwork_revisions are append-only; revisions and their approval history are never deleted';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kanei_crm_mvp_assert_artwork_revision_file()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_document_project uuid;
  v_document_type document_type;
  v_order_project uuid;
BEGIN
  SELECT d.project_id, d.document_type
    INTO v_document_project, v_document_type
  FROM document_versions dv
  JOIN documents d ON d.id = dv.document_id
  WHERE dv.id = NEW.file_document_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artwork revision references an unknown document version';
  END IF;
  IF v_document_type <> 'proof' THEN
    RAISE EXCEPTION 'artwork revision file must be a document of type proof';
  END IF;

  SELECT o.project_id INTO v_order_project
  FROM film_supply_orders o
  WHERE o.id = NEW.film_supply_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artwork revision references an unknown film supply order';
  END IF;

  IF v_document_project IS DISTINCT FROM v_order_project THEN
    RAISE EXCEPTION 'artwork revision file belongs to a different project than its order';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kanei_crm_mvp_assert_approval_event_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id uuid;
  v_design_key text;
  v_order_project uuid;
  v_file_sha256 text;
  v_evidence_project uuid;
  v_evidence_order uuid;
  v_evidence_design text;
  v_evidence_type document_type;
BEGIN
  SELECT r.film_supply_order_id, r.design_key, o.project_id, dv.sha256
    INTO v_order_id, v_design_key, v_order_project, v_file_sha256
  FROM artwork_revisions r
  JOIN film_supply_orders o ON o.id = r.film_supply_order_id
  JOIN document_versions dv ON dv.id = r.file_document_version_id
  WHERE r.id = NEW.artwork_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval event references an unknown artwork revision';
  END IF;

  IF NEW.approved_file_sha256 <> v_file_sha256 THEN
    RAISE EXCEPTION 'approved_file_sha256 must be the exact hash of the revision file being approved';
  END IF;

  SELECT d.project_id, d.film_supply_order_id, d.design_key, d.document_type
    INTO v_evidence_project, v_evidence_order, v_evidence_design, v_evidence_type
  FROM document_versions dv
  JOIN documents d ON d.id = dv.document_id
  WHERE dv.id = NEW.evidence_document_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval event references an unknown evidence document version';
  END IF;

  IF v_evidence_type <> 'approval_evidence' THEN
    RAISE EXCEPTION 'approval evidence must be a document of type approval_evidence';
  END IF;
  IF v_evidence_project IS DISTINCT FROM v_order_project THEN
    RAISE EXCEPTION 'approval evidence belongs to a different project (company)';
  END IF;
  IF v_evidence_order IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'approval evidence is bound to a different film supply order';
  END IF;
  IF v_evidence_design IS DISTINCT FROM v_design_key THEN
    RAISE EXCEPTION 'approval evidence is bound to a different design';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS artwork_approval_events_no_update ON artwork_approval_events;
CREATE TRIGGER artwork_approval_events_no_update
BEFORE UPDATE ON artwork_approval_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_approval_event_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artwork_approval_events_no_delete ON artwork_approval_events;
CREATE TRIGGER artwork_approval_events_no_delete
BEFORE DELETE ON artwork_approval_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_approval_event_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artwork_approval_events_binding_check ON artwork_approval_events;
CREATE TRIGGER artwork_approval_events_binding_check
BEFORE INSERT ON artwork_approval_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_approval_event_binding();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artwork_revisions_identity_check ON artwork_revisions;
CREATE TRIGGER artwork_revisions_identity_check
BEFORE UPDATE ON artwork_revisions
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_artwork_revision_identity_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artwork_revisions_no_delete ON artwork_revisions;
CREATE TRIGGER artwork_revisions_no_delete
BEFORE DELETE ON artwork_revisions
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_artwork_revision_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artwork_revisions_file_check ON artwork_revisions;
CREATE TRIGGER artwork_revisions_file_check
BEFORE INSERT ON artwork_revisions
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_artwork_revision_file();
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "film_supply_order_id" uuid;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "design_key" text;
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_film_supply_order_id_film_supply_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_film_supply_order_id_film_supply_orders_id_fk" FOREIGN KEY ("film_supply_order_id") REFERENCES "public"."film_supply_orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_artwork_binding_pair";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_artwork_binding_pair" CHECK (("documents"."film_supply_order_id" is null and "documents"."design_key" is null) or ("documents"."film_supply_order_id" is not null and "documents"."design_key" is not null));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_film_supply_order_idx" ON "documents" USING btree ("film_supply_order_id");
