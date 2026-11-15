-- M8-HARDEN: maker-PO production-order safety (CEO-approved P0 fixes A3·B2·C1·C2).
--
-- B2 — one active maker PO per film order:
--   * maker_purchase_orders_status gains CANCELLED, the explicit replacement
--     exit (정정·재발주 = cancel the old paper, then freeze a new one). Rows are
--     never deleted: the cancelled paper stays on the trail as history.
--   * deleted_at is added as the soft-delete column of the active-paper rule.
--     The application never writes it — cancellation is the CANCELLED status —
--     and it stays NULL on every row; it is carried in the partial unique index
--     below so a future soft-delete path cannot re-open the uniqueness hole.
--   * The partial UNIQUE index maker_purchase_orders_active_order_unique pins
--     the rule in the database, so two concurrent creates cannot both win (the
--     API pre-check is only the friendly path). Chosen predicate:
--
--       WHERE deleted_at IS NULL AND status <> 'CANCELLED'
--
--     CANCELLED is the only status that frees an order (state machine in
--     packages/core/src/state-machine.ts has no cancelled state of its own and
--     maker_purchase_orders carries no other closed status — SEND_UNVERIFIED is
--     a deliberate T-21 dead end that still occupies the order, and
--     MAKER_PO_ACCEPTED is finished paper). Statuses that leave the index:
--     CANCELLED only; rows are never hard-deleted, so deleted_at is always NULL
--     today and the predicate keeps the rule intact if that ever changes.
--   * The status_requires_ceo_approval CHECK is replaced: CANCELLED is
--     reachable on paper nobody approved (cancelling a draft is the normal
--     replacement step), every other non-DRAFT status still needs the stamp.
--
-- C1 — send evidence is the production-order EMAIL, verified as an email:
--   * maker_po_event_verification_status gains PENDING_MANUAL_VERIFICATION: the
--     evidence was read as an email and at least one header check failed, so
--     the event can never read VERIFIED until a human verifies it.
--   * maker_po_events gains verification_method / verification_checks /
--     verification_note: how the evidence was verified, the machine-readable
--     check list, and why a pending event waits. verification_method is NULL on
--     every pre-existing row — those are exactly the legacy VERIFIED sends the
--     audit (docs/reports/LEGACY_VERIFIED_SEND_AUDIT_20261115.md) lists.
--   * maker_po_send_manual_verifications records the human verification of a
--     pending send event (verifier, time, result, reason). Append-only by
--     trigger like evidence_manual_verifications (0017), and insert-guarded: the
--     target must be a SEND_EVIDENCE_REGISTERED event of that paper whose
--     verification_status is PENDING_MANUAL_VERIFICATION, and the row must name
--     that event's own paper.
--
-- B2 (acceptance binding): documents gains maker_purchase_order_id — the
--   acceptance evidence of one exact paper. Null on every existing row and on
--   every other document type, so nothing already stored changes meaning.
--
-- No existing row is rewritten by this migration: every added column is NULL,
-- every added enum value is unused, and the new constraints only forbid states
-- that could not legitimately exist (two live maker POs for one order).

ALTER TYPE "public"."maker_purchase_order_status" ADD VALUE 'CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."maker_po_event_type" ADD VALUE 'MAKER_PO_CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."maker_po_event_verification_status" ADD VALUE 'PENDING_MANUAL_VERIFICATION';--> statement-breakpoint

ALTER TABLE "maker_purchase_orders" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maker_purchase_orders" DROP CONSTRAINT IF EXISTS "maker_purchase_orders_status_requires_ceo_approval";--> statement-breakpoint
ALTER TABLE "maker_purchase_orders" ADD CONSTRAINT "maker_purchase_orders_status_requires_ceo_approval" CHECK ("maker_purchase_orders"."status" in ('DRAFT', 'CANCELLED') or "maker_purchase_orders"."ceo_approved_at" is not null);--> statement-breakpoint

-- The backstop of FIX B2: transaction-safe, so a duplicate create loses here
-- (SQLSTATE 23505) even when two requests pass the API pre-check together.
CREATE UNIQUE INDEX IF NOT EXISTS "maker_purchase_orders_active_order_unique"
  ON "maker_purchase_orders" USING btree ("film_supply_order_id")
  WHERE "deleted_at" IS NULL AND "status" <> 'CANCELLED';--> statement-breakpoint

ALTER TABLE "maker_po_events" ADD COLUMN "verification_method" text;--> statement-breakpoint
ALTER TABLE "maker_po_events" ADD COLUMN "verification_checks" jsonb;--> statement-breakpoint
ALTER TABLE "maker_po_events" ADD COLUMN "verification_note" text;--> statement-breakpoint

-- B2 (d): the acceptance evidence is bound to one maker purchase order.
ALTER TABLE "documents" ADD COLUMN "maker_purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_maker_purchase_order_id_maker_purchase_orders_id_fk" FOREIGN KEY ("maker_purchase_order_id") REFERENCES "public"."maker_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_maker_purchase_order_idx" ON "documents" USING btree ("maker_purchase_order_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "maker_po_send_manual_verifications" (
  "id" uuid PRIMARY KEY NOT NULL,
  "maker_po_event_id" uuid NOT NULL REFERENCES "maker_po_events"("id"),
  "maker_purchase_order_id" uuid NOT NULL REFERENCES "maker_purchase_orders"("id"),
  "result" text NOT NULL,
  "verifier_name" text NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "reason_note" text NOT NULL,
  "recorded_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maker_po_send_manual_verifications_result_vocabulary" CHECK ("result" in ('confirmed', 'rejected')),
  CONSTRAINT "maker_po_send_manual_verifications_verifier_name_not_blank" CHECK (length(btrim("verifier_name")) > 0),
  CONSTRAINT "maker_po_send_manual_verifications_reason_not_blank" CHECK (length(btrim("reason_note")) > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "maker_po_send_manual_verifications_event_idx"
  ON "maker_po_send_manual_verifications" ("maker_po_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maker_po_send_manual_verifications_po_idx"
  ON "maker_po_send_manual_verifications" ("maker_purchase_order_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_maker_po_send_manual_verification_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'maker_po_send_manual_verifications are append-only; record a new verification instead of rewriting a human decision';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION kanei_crm_mvp_assert_maker_po_send_manual_verification_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_type maker_po_event_type;
  v_verification_status maker_po_event_verification_status;
  v_po_id uuid;
BEGIN
  SELECT event_type, verification_status, maker_purchase_order_id
    INTO v_event_type, v_verification_status, v_po_id
  FROM maker_po_events
  WHERE id = NEW.maker_po_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual verification references an unknown maker PO event';
  END IF;

  IF v_event_type <> 'SEND_EVIDENCE_REGISTERED' THEN
    RAISE EXCEPTION 'manual verification targets an event that is not a send registration';
  END IF;
  IF v_verification_status IS DISTINCT FROM 'PENDING_MANUAL_VERIFICATION' THEN
    RAISE EXCEPTION 'manual verification targets a send event that is not pending manual verification';
  END IF;
  IF NEW.maker_purchase_order_id IS DISTINCT FROM v_po_id THEN
    RAISE EXCEPTION 'manual verification must name the send event''s own maker purchase order';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS maker_po_send_manual_verifications_no_update ON maker_po_send_manual_verifications;--> statement-breakpoint
CREATE TRIGGER maker_po_send_manual_verifications_no_update
BEFORE UPDATE ON maker_po_send_manual_verifications
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_maker_po_send_manual_verification_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS maker_po_send_manual_verifications_no_delete ON maker_po_send_manual_verifications;--> statement-breakpoint
CREATE TRIGGER maker_po_send_manual_verifications_no_delete
BEFORE DELETE ON maker_po_send_manual_verifications
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_maker_po_send_manual_verification_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS maker_po_send_manual_verifications_target_check ON maker_po_send_manual_verifications;--> statement-breakpoint
CREATE TRIGGER maker_po_send_manual_verifications_target_check
BEFORE INSERT ON maker_po_send_manual_verifications
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_maker_po_send_manual_verification_target();
