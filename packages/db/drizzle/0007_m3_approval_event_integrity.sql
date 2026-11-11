-- M3: approval immutability and binding integrity (design sections 5.7 and 6.1).
-- This extends the M0 audit_events / M1 delivery / M2 document_versions
-- append-only pattern to the approval record:
--
-- - artwork_approval_events are the record of external approval decisions. A
--   withdrawal or a re-approval is a new REVOKE or superseding APPROVE event;
--   a recorded fact is never rewritten or removed (T-12). UPDATE and DELETE are
--   rejected by trigger exactly like the M0 audit_events pattern.
-- - artwork_revisions keep their identity forever: the order, design, revision
--   number and file a revision points at can never be edited (that would
--   silently re-bind decisions recorded against other bytes). Only descriptive
--   metadata (lot_marking / note) may be corrected, and a revision row can
--   never be deleted.
-- - Both tables are additionally guarded on insert: an approval event must
--   carry the exact hash of the revision file it approves, and its evidence
--   document must be bound to the same order, design and company as that
--   revision (T-35). A revision must point at a proof document of its own
--   order's project.
CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_approval_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artwork_approval_events are append-only; record a REVOKE or a superseding APPROVE instead of rewriting a decision';
END;
$$;

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

CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_artwork_revision_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artwork_revisions are append-only; revisions and their approval history are never deleted';
END;
$$;

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

DROP TRIGGER IF EXISTS artwork_approval_events_no_update ON artwork_approval_events;
CREATE TRIGGER artwork_approval_events_no_update
BEFORE UPDATE ON artwork_approval_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_approval_event_mutation();

DROP TRIGGER IF EXISTS artwork_approval_events_no_delete ON artwork_approval_events;
CREATE TRIGGER artwork_approval_events_no_delete
BEFORE DELETE ON artwork_approval_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_approval_event_mutation();

DROP TRIGGER IF EXISTS artwork_approval_events_binding_check ON artwork_approval_events;
CREATE TRIGGER artwork_approval_events_binding_check
BEFORE INSERT ON artwork_approval_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_approval_event_binding();

DROP TRIGGER IF EXISTS artwork_revisions_identity_check ON artwork_revisions;
CREATE TRIGGER artwork_revisions_identity_check
BEFORE UPDATE ON artwork_revisions
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_artwork_revision_identity_mutation();

DROP TRIGGER IF EXISTS artwork_revisions_no_delete ON artwork_revisions;
CREATE TRIGGER artwork_revisions_no_delete
BEFORE DELETE ON artwork_revisions
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_artwork_revision_delete();

DROP TRIGGER IF EXISTS artwork_revisions_file_check ON artwork_revisions;
CREATE TRIGGER artwork_revisions_file_check
BEFORE INSERT ON artwork_revisions
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_artwork_revision_file();
