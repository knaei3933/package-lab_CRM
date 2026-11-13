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
ALTER TABLE "film_supply_orders" ADD COLUMN "payment_terms" text DEFAULT 'undetermined';
ALTER TABLE "film_supply_orders" ADD CONSTRAINT "film_supply_orders_payment_terms_vocabulary" CHECK ("payment_terms" is null or "payment_terms" in ('prepaid', 'on_delivery', 'undetermined'));
