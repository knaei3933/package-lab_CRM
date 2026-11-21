-- P2 R32 (representative approval 2026-11-21): the maker purchase order
-- number MPO-{JST year}-{sequence} is stored once, company-wide and per JST
-- year, instead of being recomputed on every read (P1 computed it as the rank
-- by created_at, id).
--
-- * New table, one row per maker PO; the maker_purchase_orders rows are not
--   updated (their 0010/0020 guards stay exactly as they are).
-- * Numbers are assigned by an AFTER INSERT trigger, so every insert path gets
--   one. The trigger takes the same transaction advisory lock the API create
--   path already holds (kanei:maker_po_display_number), so two concurrent
--   inserts cannot read the same max; UNIQUE (year, seq) and UNIQUE
--   (display_number) are the database backstop. A rolled-back insert rolls its
--   number back too, so the sequence has no gaps.
-- * Backfill: existing rows get exactly the number P1 showed (rank by
--   created_at, id within the JST year), so no screen changes.
-- Rerunnable: CREATE ... IF NOT EXISTS, CREATE OR REPLACE, ON CONFLICT DO NOTHING.
--
-- Rollback (REPORT.md §3): revert the API to the P1 computed numbers, then
--   DROP TRIGGER IF EXISTS "maker_purchase_orders_assign_display_number" ON "maker_purchase_orders";
--   DROP FUNCTION IF EXISTS public.kanei_crm_mvp_assign_maker_po_display_number();
--   DROP TABLE IF EXISTS "maker_po_display_numbers";
-- The computed rank equals the stored number for every backfilled and
-- trigger-numbered row, so the screen keeps the same numbers.

CREATE TABLE IF NOT EXISTS "maker_po_display_numbers" (
	"maker_purchase_order_id" uuid PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"seq" integer NOT NULL,
	"display_number" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maker_po_display_numbers_year_range" CHECK ("year" BETWEEN 2000 AND 2999),
	CONSTRAINT "maker_po_display_numbers_seq_positive" CHECK ("seq" > 0),
	CONSTRAINT "maker_po_display_numbers_format" CHECK ("display_number" = 'MPO-' || "year"::text || '-' || lpad("seq"::text, 4, '0') OR ("seq" > 9999 AND "display_number" = 'MPO-' || "year"::text || '-' || "seq"::text))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maker_po_display_numbers_maker_purchase_order_id_fk' AND conrelid = 'public.maker_po_display_numbers'::regclass) THEN
    ALTER TABLE "maker_po_display_numbers" ADD CONSTRAINT "maker_po_display_numbers_maker_purchase_order_id_fk"
      FOREIGN KEY ("maker_purchase_order_id") REFERENCES "public"."maker_purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "maker_po_display_numbers_year_seq_unique"
  ON "maker_po_display_numbers" USING btree ("year", "seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "maker_po_display_numbers_display_number_unique"
  ON "maker_po_display_numbers" USING btree ("display_number");--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.kanei_crm_mvp_assign_maker_po_display_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_year integer;
  v_seq integer;
BEGIN
  -- Same lock key as the API create path (re-entrant inside one transaction).
  PERFORM pg_advisory_xact_lock(hashtextextended('kanei:maker_po_display_number', 215470));
  IF EXISTS (SELECT 1 FROM public.maker_po_display_numbers WHERE maker_purchase_order_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  v_year := extract(year FROM (NEW.created_at AT TIME ZONE 'Asia/Tokyo'))::integer;
  SELECT coalesce(max(n.seq), 0) + 1 INTO v_seq
    FROM public.maker_po_display_numbers n
   WHERE n.year = v_year;
  INSERT INTO public.maker_po_display_numbers (maker_purchase_order_id, year, seq, display_number)
  VALUES (
    NEW.id,
    v_year,
    v_seq,
    'MPO-' || v_year::text || '-' || CASE WHEN v_seq > 9999 THEN v_seq::text ELSE lpad(v_seq::text, 4, '0') END
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- Backfill before the trigger exists, under the same lock, with P1's formula.
SELECT pg_advisory_xact_lock(hashtextextended('kanei:maker_po_display_number', 215470));--> statement-breakpoint
INSERT INTO "maker_po_display_numbers" ("maker_purchase_order_id", "year", "seq", "display_number")
SELECT ranked.id,
       ranked.year,
       ranked.seq,
       'MPO-' || ranked.year::text || '-' || CASE WHEN ranked.seq > 9999 THEN ranked.seq::text ELSE lpad(ranked.seq::text, 4, '0') END
  FROM (
    SELECT id,
           extract(year FROM (created_at AT TIME ZONE 'Asia/Tokyo'))::integer AS year,
           row_number() OVER (
             PARTITION BY extract(year FROM (created_at AT TIME ZONE 'Asia/Tokyo'))
             ORDER BY created_at, id
           )::integer AS seq
      FROM "maker_purchase_orders"
  ) ranked
ON CONFLICT ("maker_purchase_order_id") DO NOTHING;--> statement-breakpoint

DROP TRIGGER IF EXISTS "maker_purchase_orders_assign_display_number" ON "maker_purchase_orders";--> statement-breakpoint
CREATE TRIGGER "maker_purchase_orders_assign_display_number"
  AFTER INSERT ON "maker_purchase_orders"
  FOR EACH ROW EXECUTE FUNCTION public.kanei_crm_mvp_assign_maker_po_display_number();
