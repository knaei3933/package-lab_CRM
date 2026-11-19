-- Backfill append-only FILM_SUPPLY_ORDER_LINE_CREATED audit events for film
-- supply order lines created before server batch E (2026-11-19).
--
-- RUN SAFETY: this script was already applied once to the approved main DB
-- (kanei_crm_mvp). Do not rerun it there without fresh representative approval.
-- When such approval exists, set the explicit acknowledgment flag through the
-- connection:
--   PGOPTIONS='-c kanei.allow_main_backfill_20261119=approved' psql ...
--
-- Safety contract:
-- 1. This script appends audit_events only; film_supply_order_lines and
--    film_supply_orders are never updated or deleted.
-- 2. One missing line yields exactly one event, using the line's own id as
--    entityId and its created_at as occurredAt (the historical fact time).
-- 3. Idempotency is based on the line entity, not on this script's operation
--    marker: any pre-existing FILM_SUPPLY_ORDER_LINE_CREATED event for the same
--    line id is skipped (including API /lines and Seven-PO creation events).
--    The transaction-scoped advisory lock additionally serializes invocations.
-- 4. actor_user_id is intentionally NULL because no human actor performed this
--    historical record; request_metadata.actor explicitly says system backfill.
-- 5. afterState mirrors the server-created event shape and deliberately omits
--    monetary fields. Numeric quantity is text, exactly as the API emits it.
-- 6. The guard below fails closed for the approved main database unless the
--    acknowledgment custom GUC named in the run-safety note is set. Other
--    databases (test/scratch) do not require that flag.

BEGIN;

DO $main_database_guard$
BEGIN
  IF current_database() = 'kanei_crm_mvp'
    AND COALESCE(current_setting('kanei.allow_main_backfill_20261119', true), '')
      <> 'approved' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55006',
      MESSAGE = 'refusing main DB backfill rerun without explicit approval flag',
      HINT = 'set kanei.allow_main_backfill_20261119=approved only after fresh representative approval';
  END IF;
END
$main_database_guard$;

SELECT pg_advisory_xact_lock(215467, 20261119);

WITH missing AS (
  SELECT
    l.id,
    o.project_id,
    o.id AS film_supply_order_id,
    l.line_number,
    l.description,
    l.ordered_quantity,
    l.unit,
    l.created_at
  FROM film_supply_order_lines AS l
  JOIN film_supply_orders AS o ON o.id = l.film_supply_order_id
  WHERE o.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM audit_events AS a
      WHERE a.action = 'FILM_SUPPLY_ORDER_LINE_CREATED'
        AND a.entity_type = 'film_supply_order_line'
        AND a.entity_id = l.id::text
    )
), inserted AS (
  INSERT INTO audit_events (
    id,
    project_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_state,
    after_state,
    occurred_at,
    request_metadata
  )
  SELECT
    gen_random_uuid(),
    m.project_id,
    NULL,
    'FILM_SUPPLY_ORDER_LINE_CREATED',
    'film_supply_order_line',
    m.id::text,
    NULL,
    jsonb_build_object(
      'id', m.id,
      'filmSupplyOrderId', m.film_supply_order_id,
      'lineNumber', m.line_number,
      'description', m.description,
      'orderedQuantity', m.ordered_quantity::text,
      'unit', m.unit
    ),
    m.created_at,
    jsonb_build_object(
      'operation', 'film_order_line_backfill:2026-11-19',
      'actor', 'system:film_order_line_backfill',
      'sourceLineId', m.id,
      'filmSupplyOrderId', m.film_supply_order_id
    )
  FROM missing AS m
  RETURNING 1
)
SELECT count(*) AS inserted_count FROM inserted;

COMMIT;
