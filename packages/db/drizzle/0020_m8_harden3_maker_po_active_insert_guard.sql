-- M8-HARDEN3: FIX B2's creation gate becomes a DB-level BEFORE INSERT trigger.
--
-- 0018 already pins the one-active-maker-PO rule with the partial unique index
-- maker_purchase_orders_active_order_unique:
--
--   UNIQUE (film_supply_order_id) WHERE deleted_at IS NULL AND status <> 'CANCELLED'
--
-- and the API pre-check (MAKER_PO_ALREADY_EXISTS, 422) is the friendly path.
-- This migration adds the trigger backstop for the same rule: a BEFORE INSERT
-- row trigger re-checks the exact active-set predicate before any row is
-- written, so the rule is enforced by an object in the database itself — it
-- survives even when the index is dropped, renamed, or bypassed by raw psql
-- maintenance on the paper table.
--
-- Same active set as the index — the trigger is never stricter and never
-- looser than 0018:
--   * The claiming predicate is exactly the index predicate:
--     deleted_at IS NULL AND status <> 'CANCELLED'.
--   * A row outside the active set never claims the order's slot: a CANCELLED
--     paper is history (the replacement step keeps the row), and a soft-deleted
--     paper is the hypothetical future exit the 0018 predicate already carries.
--     Such rows pass the trigger untouched, exactly as they pass the partial
--     index.
--   * INSERT-only: status transitions and soft-deletes are UPDATEs, so the
--     replacement step (cancel the old paper, then freeze the new one) and the
--     future soft-delete path are governed by the 0018 index alone — the
--     trigger is not in their path and cannot contradict it.
--   * Concurrency stays the index's job: this trigger reads a READ COMMITTED
--     snapshot and cannot see an uncommitted parallel create, so the 0018 index
--     remains the serialization point for races; the trigger adds the
--     deterministic DB-level refusal for every sequential or logical violation
--     (and for a world where the index is missing), with a message that names
--     the paper holding the slot.
--
-- SQLSTATE 23505 (unique_violation): the API's makerPoActiveUniqueViolation
-- fallback (code 23505 with no constraint name on the error) maps trigger
-- refusals to the same 422 MAKER_PO_ALREADY_EXISTS the index path produces, so
-- both backstops surface identically to the client and no app code changes.

CREATE OR REPLACE FUNCTION kanei_crm_mvp_assert_single_active_maker_po()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_conflicting_id uuid;
BEGIN
  -- Outside the active set: history that holds no order slot. Same rule as the
  -- 0018 partial index predicate — nothing is stricter, nothing is looser.
  IF NEW.deleted_at IS NOT NULL OR NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  SELECT other.id INTO v_conflicting_id
  FROM maker_purchase_orders AS other
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

DROP TRIGGER IF EXISTS maker_purchase_orders_active_insert_guard ON maker_purchase_orders;--> statement-breakpoint
CREATE TRIGGER maker_purchase_orders_active_insert_guard
BEFORE INSERT ON maker_purchase_orders
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_single_active_maker_po();
