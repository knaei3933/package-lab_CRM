-- M5: delivery confirmation immutability (design sections 5.5 and 6.4).
--
-- A confirmation is the record that one verified evidence document was bound to
-- one delivery. Correcting it is a business event, not an edit: the row is
-- append-only, exactly like the deliveries it points at (migration 0003) and
-- the audit_events pattern behind every M0 to M4 event log.
CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_delivery_confirmation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'delivery_confirmations are append-only; record a new confirmation instead of rewriting delivery evidence history';
END;
$$;

DROP TRIGGER IF EXISTS delivery_confirmations_no_update ON delivery_confirmations;
CREATE TRIGGER delivery_confirmations_no_update
BEFORE UPDATE ON delivery_confirmations
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_delivery_confirmation_mutation();

DROP TRIGGER IF EXISTS delivery_confirmations_no_delete ON delivery_confirmations;
CREATE TRIGGER delivery_confirmations_no_delete
BEFORE DELETE ON delivery_confirmations
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_delivery_confirmation_mutation();
