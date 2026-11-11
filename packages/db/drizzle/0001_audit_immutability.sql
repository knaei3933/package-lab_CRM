CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_audit_mutation();

DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_audit_mutation();
