-- M7-SEC3 FIX 3: the G6 payment gate (design "G6 결제 조건").
--
-- Every film supply order records its transaction terms. The column is nullable
-- with 'undetermined' as the default: orders created before this migration and
-- orders created without a stated term read as undetermined, which is exactly
-- the state that closes G6 — the maker purchase order approval refuses to run
-- while the terms are not settled.
--
-- The vocabulary is constrained at the database level so nothing outside the
-- API can write a term the gate does not understand. NULL stays allowed: it is
-- the pre-migration state of existing orders and reads as 'undetermined'.
ALTER TABLE "film_supply_orders" ADD COLUMN IF NOT EXISTS "payment_terms" text DEFAULT 'undetermined';
DO $$
DECLARE
  actual_column_default text;
  named_constraint_definition text;
  expected_constraint_definition text := 'CHECK (((payment_terms IS NULL) OR (payment_terms = ANY (ARRAY[''prepaid''::text, ''on_delivery''::text, ''undetermined''::text]))))';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'film_supply_orders'
      AND column_name = 'payment_terms'
  ) THEN
    ALTER TABLE "film_supply_orders" ADD COLUMN "payment_terms" text DEFAULT 'undetermined';
  ELSE
    SELECT column_default INTO actual_column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'film_supply_orders'
      AND column_name = 'payment_terms';
    IF actual_column_default IS DISTINCT FROM '''undetermined''::text' THEN
      RAISE EXCEPTION 'payment_terms column definition drift: expected text DEFAULT ''undetermined''::text, found %', actual_column_default;
    END IF;
  END IF;

  SELECT pg_get_constraintdef(con.oid) INTO named_constraint_definition
  FROM pg_constraint con
  WHERE con.conname = 'film_supply_orders_payment_terms_vocabulary'
    AND con.conrelid = '"public"."film_supply_orders"'::regclass;
  IF named_constraint_definition IS NOT NULL
    AND named_constraint_definition IS DISTINCT FROM expected_constraint_definition THEN
    RAISE EXCEPTION 'payment_terms constraint definition drift: expected %, found %', expected_constraint_definition, named_constraint_definition;
  END IF;

  -- A functionally identical manually named CHECK is accepted, but never
  -- duplicated. Any other foreign CHECK on this column remains untouched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    WHERE con.conrelid = '"public"."film_supply_orders"'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(con.oid) = expected_constraint_definition
  ) THEN
    ALTER TABLE "film_supply_orders"
      ADD CONSTRAINT "film_supply_orders_payment_terms_vocabulary"
      CHECK ("payment_terms" is null or "payment_terms" in ('prepaid', 'on_delivery', 'undetermined'));
  END IF;
END
$$;
--> statement-breakpoint

-- Pre-commit enum vocabulary required by migrations 0016 and 0018. PostgreSQL
-- rejects use of an enum value added in the same transaction; the original
-- later migrations worked on already-migrated databases but failed on a fresh
-- database. Adding them here (before those migrations run) keeps fresh and
-- existing deployments on the same result.
ALTER TYPE "public"."maker_po_event_type" ADD VALUE IF NOT EXISTS 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL';
ALTER TYPE "public"."maker_purchase_order_status" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "public"."maker_po_event_type" ADD VALUE IF NOT EXISTS 'MAKER_PO_CANCELLED';
ALTER TYPE "public"."maker_po_event_verification_status" ADD VALUE IF NOT EXISTS 'PENDING_MANUAL_VERIFICATION';
--> statement-breakpoint

-- Drizzle wraps every pending migration in one transaction. PostgreSQL cannot
-- use an enum value added in that same transaction, so commit the base schema
-- and vocabulary here, then open the transaction Drizzle expects for the
-- remaining migrations. If 0016+ fails, reruns start at 0016 with the enum
-- already committed; IF NOT EXISTS keeps this idempotent.
COMMIT;
BEGIN;
