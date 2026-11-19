-- R1-8 / SEC-09: pin the trigger function's schema search path.
--
-- 0020 recreated the one-active-maker-PO trigger function, but like ordinary
-- CREATE FUNCTION it inherited the invoker/connection search path when later
-- replaying its PL/pgSQL body. A malicious or accidental search_path could
-- make the unqualified maker_purchase_orders read resolve to a different
-- object. 0022 recreates the exact same rule with a minimal, explicit search
-- path and a schema-qualified table reference.
--
-- No table, column, constraint, enum, or row is changed. Existing deployments
-- must apply this only after representative approval; it is not applied to the
-- main DB by this development task.

CREATE OR REPLACE FUNCTION kanei_crm_mvp_assert_single_active_maker_po()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_conflicting_id uuid;
BEGIN
  -- Outside the active set: history that holds no order slot. Same rule as the
  -- 0018 partial index predicate — nothing is stricter and nothing is looser.
  IF NEW.deleted_at IS NOT NULL OR NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  SELECT other.id INTO v_conflicting_id
  FROM public.maker_purchase_orders AS other
  WHERE other.film_supply_order_id = NEW.film_supply_order_id
    AND other.deleted_at IS NULL
    AND other.status <> 'CANCELLED'
    AND other.id <> NEW.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'film supply order % already holds an active maker purchase order (%) — one active maker PO per film supply order (B2)',
      NEW.film_supply_order_id, v_conflicting_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS maker_purchase_orders_active_insert_guard ON public.maker_purchase_orders;--> statement-breakpoint
CREATE TRIGGER maker_purchase_orders_active_insert_guard
BEFORE INSERT ON public.maker_purchase_orders
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_single_active_maker_po();
