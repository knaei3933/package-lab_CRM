-- M4: maker PO event immutability (design sections 5.8 and 6.1).
--
-- maker_po_events are the record of what happened to the frozen maker paper: a
-- CEO approval, a voided snapshot, registered send or acceptance evidence, a
-- refused send. A correction is always a new event; UPDATE and DELETE are
-- rejected by trigger with a message naming the append-only contract, exactly
-- like the M0 audit_events / M1 delivery / M2 document_versions / M3 approval
-- event pattern.
CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_maker_po_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'maker_po_events are append-only; record a new event instead of rewriting maker purchase order history';
END;
$$;

DROP TRIGGER IF EXISTS maker_po_events_no_update ON maker_po_events;
CREATE TRIGGER maker_po_events_no_update
BEFORE UPDATE ON maker_po_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_maker_po_event_mutation();

DROP TRIGGER IF EXISTS maker_po_events_no_delete ON maker_po_events;
CREATE TRIGGER maker_po_events_no_delete
BEFORE DELETE ON maker_po_events
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_maker_po_event_mutation();
