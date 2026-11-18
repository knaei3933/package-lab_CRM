-- M9: CANCELLATION_REVIEW may end a film order as CANCELLED through the
-- representative-only resolution endpoint. CANCELLED is terminal in the film
-- state machine and is never reachable through generic transitions.
-- Rollback warning: PostgreSQL cannot drop one enum value. Reverting code
-- without this database value can make closed orders fail on old deployments.
ALTER TYPE "public"."film_supply_order_status" ADD VALUE IF NOT EXISTS 'CANCELLED' AFTER 'CANCELLATION_REVIEW';
