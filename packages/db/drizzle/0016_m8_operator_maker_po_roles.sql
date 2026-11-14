-- M8-OPERATOR: maker purchase-order operator UI and role/security hardening.
--
-- Three additive changes, all of them new fields on append-only or already
-- constrained tables. No row is rewritten: the maker PO chain and the approval
-- events stay exactly the facts they were.

-- FIX 2: a provisional acceptance is its own event type, so the record reads as
-- "an acceptance was written down by staff" instead of borrowing the final
-- ACCEPT_EVIDENCE_REGISTERED vocabulary. The value is only added here; the
-- enum's existing values and the append-only triggers of migration 0010 are
-- untouched.
ALTER TYPE "maker_po_event_type" ADD VALUE IF NOT EXISTS 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL';

-- FIX 2: the flag that makes a provisional record impossible to mistake for a
-- confirmed acceptance. Default false, so every pre-existing event reads as a
-- non-provisional fact. The API writes it together with the event type, and the
-- table keeps the pair constrained (see schema).
ALTER TABLE "maker_po_events" ADD COLUMN "provisional" boolean NOT NULL DEFAULT false;
ALTER TABLE "maker_po_events" ADD CONSTRAINT "maker_po_events_provisional_pair" CHECK ("provisional" = false or "event_type" = 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL');

-- FIX 3: 入金確認（檢証）is a human act and is recorded only when a human
-- records it. The column exists so the API can answer "is the money confirmed?"
-- without ever deriving the answer from paymentTerms='prepaid'. Nothing writes
-- it yet; the explicit confirmation action is future work by design.
ALTER TABLE "film_supply_orders" ADD COLUMN "payment_confirmed_at" timestamp with time zone;

-- FIX 4: what the evidence-identifier check did with the cited evidence. Null
-- for rows written before this column (they keep counting, as they always did),
-- 'verified_in_document' when the identifier was found in stored text,
-- 'pending_manual_verification' for binary evidence whose identifier a human
-- must confirm, 'not_applicable' for decisions that never contribute to an
-- approval.
ALTER TABLE "artwork_approval_events" ADD COLUMN "evidence_identifier_status" text;
ALTER TABLE "artwork_approval_events" ADD CONSTRAINT "artwork_approval_events_evidence_identifier_status_vocabulary" CHECK ("evidence_identifier_status" is null or "evidence_identifier_status" in ('verified_in_document', 'pending_manual_verification', 'not_applicable'));
