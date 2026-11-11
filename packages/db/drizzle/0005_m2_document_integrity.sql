-- M2: document intake immutability (design sections 5.4 and 5.6). This mirrors
-- the M0 audit_events / M1 delivery append-only pattern at the database level:
--
-- - document_versions rows are append-only. sha256, storage_path and the size /
--   type check results are the intake record; a correction is a new version
--   row, never a rewrite. Human verification of a document lives on documents
--   (verification_status / verified_by / verified_at), deliberately separate
--   from the hash, so recording it never touches these rows.
-- - pre_order_references rows are append-only: original_received_at is
--   reference data about a paper document arriving and can never be edited to
--   satisfy a gate.
CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_document_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'document_versions are append-only; upload a new version instead of rewriting recorded bytes';
END;
$$;

CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_pre_order_reference_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'pre_order_references are append-only; original_received_at is immutable reference data';
END;
$$;

DROP TRIGGER IF EXISTS document_versions_no_update ON document_versions;
CREATE TRIGGER document_versions_no_update
BEFORE UPDATE ON document_versions
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_document_version_mutation();

DROP TRIGGER IF EXISTS document_versions_no_delete ON document_versions;
CREATE TRIGGER document_versions_no_delete
BEFORE DELETE ON document_versions
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_document_version_mutation();

DROP TRIGGER IF EXISTS pre_order_references_no_update ON pre_order_references;
CREATE TRIGGER pre_order_references_no_update
BEFORE UPDATE ON pre_order_references
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_pre_order_reference_mutation();

DROP TRIGGER IF EXISTS pre_order_references_no_delete ON pre_order_references;
CREATE TRIGGER pre_order_references_no_delete
BEFORE DELETE ON pre_order_references
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_pre_order_reference_mutation();
