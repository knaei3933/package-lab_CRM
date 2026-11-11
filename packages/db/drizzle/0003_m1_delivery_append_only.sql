-- M1: delivery rows are append-only. Split deliveries are new rows; a recorded
-- quantity is never overwritten. This mirrors the M0 audit_events immutability
-- pattern at the database level.
CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_delivery_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'delivery rows are append-only; record a split delivery instead of overwriting a quantity';
END;
$$;

DROP TRIGGER IF EXISTS film_deliveries_no_update ON film_deliveries;
CREATE TRIGGER film_deliveries_no_update
BEFORE UPDATE ON film_deliveries
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_delivery_mutation();

DROP TRIGGER IF EXISTS film_deliveries_no_delete ON film_deliveries;
CREATE TRIGGER film_deliveries_no_delete
BEFORE DELETE ON film_deliveries
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_delivery_mutation();

DROP TRIGGER IF EXISTS filling_deliveries_no_update ON filling_deliveries;
CREATE TRIGGER filling_deliveries_no_update
BEFORE UPDATE ON filling_deliveries
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_delivery_mutation();

DROP TRIGGER IF EXISTS filling_deliveries_no_delete ON filling_deliveries;
CREATE TRIGGER filling_deliveries_no_delete
BEFORE DELETE ON filling_deliveries
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_delivery_mutation();
