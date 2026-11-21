-- P2 R30 / policy P-8 (representative approval 2026-11-21): storage for the
-- delivery dates and the セブン化学発注書 quantity and amount.
--
-- Additive only. Existing rows keep every value they had: the two new order
-- columns are NULL ("not recorded"), and the seven-PO facts live in a NEW table
-- so no existing seven_purchase_orders row (and no `select *` of it that an
-- endpoint already returns to staff or viewer) ever carries an amount.
-- Rerunnable: every statement is IF NOT EXISTS or guarded by a catalog check.
--
-- Rollback (documented in demo-eml/p2-server/REPORT.md §3):
--   DROP TABLE IF EXISTS "seven_po_order_facts";
--   ALTER TABLE "film_supply_orders" DROP COLUMN IF EXISTS "planned_delivery_date";
--   ALTER TABLE "film_supply_orders" DROP COLUMN IF EXISTS "requested_delivery_date";
-- Only the values written into these new places are lost.

-- 希望納期 (the date the customer asked for) and 納品予定日 (the date the maker
-- committed to). Calendar dates, no time of day and no time zone.
ALTER TABLE "film_supply_orders" ADD COLUMN IF NOT EXISTS "requested_delivery_date" date;--> statement-breakpoint
ALTER TABLE "film_supply_orders" ADD COLUMN IF NOT EXISTS "planned_delivery_date" date;--> statement-breakpoint

-- One row per seven purchase order, written only by the API. Quantity and unit
-- are a pair, amount and currency are a pair. The amount is the
-- representative's information: the API writes and returns it to admin only.
CREATE TABLE IF NOT EXISTS "seven_po_order_facts" (
	"seven_purchase_order_id" uuid PRIMARY KEY NOT NULL,
	"ordered_quantity" numeric(14, 3),
	"ordered_unit" "measure_unit",
	"total_amount" numeric(14, 2),
	"currency" text,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seven_po_order_facts_quantity_pair" CHECK (("ordered_quantity" IS NULL) = ("ordered_unit" IS NULL)),
	CONSTRAINT "seven_po_order_facts_quantity_positive" CHECK ("ordered_quantity" IS NULL OR "ordered_quantity" > 0),
	CONSTRAINT "seven_po_order_facts_amount_pair" CHECK (("total_amount" IS NULL) = ("currency" IS NULL)),
	CONSTRAINT "seven_po_order_facts_amount_nonnegative" CHECK ("total_amount" IS NULL OR "total_amount" >= 0),
	CONSTRAINT "seven_po_order_facts_currency_format" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seven_po_order_facts_seven_purchase_order_id_fk' AND conrelid = 'public.seven_po_order_facts'::regclass) THEN
    ALTER TABLE "seven_po_order_facts" ADD CONSTRAINT "seven_po_order_facts_seven_purchase_order_id_fk"
      FOREIGN KEY ("seven_purchase_order_id") REFERENCES "public"."seven_purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seven_po_order_facts_created_by_user_id_fk' AND conrelid = 'public.seven_po_order_facts'::regclass) THEN
    ALTER TABLE "seven_po_order_facts" ADD CONSTRAINT "seven_po_order_facts_created_by_user_id_fk"
      FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seven_po_order_facts_updated_by_user_id_fk' AND conrelid = 'public.seven_po_order_facts'::regclass) THEN
    ALTER TABLE "seven_po_order_facts" ADD CONSTRAINT "seven_po_order_facts_updated_by_user_id_fk"
      FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- Approval cards and the representative queue read the dates by order.
CREATE INDEX IF NOT EXISTS "film_supply_orders_requested_delivery_date_idx"
  ON "film_supply_orders" USING btree ("requested_delivery_date")
  WHERE "requested_delivery_date" IS NOT NULL AND "deleted_at" IS NULL;
