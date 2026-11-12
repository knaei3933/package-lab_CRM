-- M5: manual film receipt assumption and delivery confirmations (design
-- sections 5.5, 6.1 and 6.4).
--
-- film_supply_orders gains the receipt-assumption stamp written by the manual
-- recording action (design section 13 item 1: the waiting period is not decided
-- yet, so nothing schedules or derives it). The stamp is a pair-plus-note unit
-- and is enforced as such at the database level.
--
-- commission_readiness gains the M5 observation columns: a delivery counts for
-- readiness only once its verified delivery evidence is bound (T-36), and the
-- readiness_state vocabulary carries the explicit MISSING_DATA /
-- PENDING_VERIFICATION / READY surface.
--
-- delivery_confirmations binds one verified evidence document version to one
-- delivery. Deliveries themselves stay append-only (migration 0003), so a
-- confirmation is its own row.
CREATE TYPE "public"."delivery_confirmation_kind" AS ENUM('film', 'filling');

CREATE TYPE "public"."commission_readiness_state" AS ENUM('MISSING_DATA', 'PENDING_VERIFICATION', 'READY');

ALTER TABLE "film_supply_orders" ADD COLUMN "receipt_assumed_at" timestamp with time zone;
ALTER TABLE "film_supply_orders" ADD COLUMN "receipt_assumed_by_user_id" uuid;
ALTER TABLE "film_supply_orders" ADD COLUMN "receipt_assumed_note" text;
ALTER TABLE "film_supply_orders" ADD CONSTRAINT "film_supply_orders_receipt_assumption_pair" CHECK (("film_supply_orders"."receipt_assumed_at" is null) = ("film_supply_orders"."receipt_assumed_by_user_id" is null));
ALTER TABLE "film_supply_orders" ADD CONSTRAINT "film_supply_orders_receipt_assumption_note" CHECK ("film_supply_orders"."receipt_assumed_at" is null or length(btrim("film_supply_orders"."receipt_assumed_note")) > 0);
ALTER TABLE "film_supply_orders" ADD CONSTRAINT "film_supply_orders_receipt_assumed_by_user_id_users_id_fk" FOREIGN KEY ("receipt_assumed_by_user_id") REFERENCES "public"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "commission_readiness" ADD COLUMN "film_delivery_confirmed" boolean NOT NULL DEFAULT false;
ALTER TABLE "commission_readiness" ADD COLUMN "filling_delivery_confirmed" boolean NOT NULL DEFAULT false;
ALTER TABLE "commission_readiness" ADD COLUMN "readiness_state" "commission_readiness_state" NOT NULL DEFAULT 'MISSING_DATA';
-- Rows that reached is_ready before the M5 state vocabulary existed keep it.
UPDATE "commission_readiness" SET "readiness_state" = 'READY' WHERE "is_ready" = true;
ALTER TABLE "commission_readiness" ADD CONSTRAINT "commission_readiness_state_matches_is_ready" CHECK (("commission_readiness"."readiness_state" = 'READY') = ("commission_readiness"."is_ready" = true));

CREATE TABLE "delivery_confirmations" (
  "id" uuid PRIMARY KEY,
  "delivery_kind" "delivery_confirmation_kind" NOT NULL,
  "film_delivery_id" uuid,
  "filling_delivery_id" uuid,
  "evidence_document_version_id" uuid NOT NULL,
  "confirmed_by_user_id" uuid NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "note" text
);
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_single_delivery" CHECK (("delivery_confirmations"."delivery_kind" = 'film' and "delivery_confirmations"."film_delivery_id" is not null and "delivery_confirmations"."filling_delivery_id" is null) or ("delivery_confirmations"."delivery_kind" = 'filling' and "delivery_confirmations"."film_delivery_id" is null and "delivery_confirmations"."filling_delivery_id" is not null));
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_film_delivery_id_film_deliveries_id_fk" FOREIGN KEY ("film_delivery_id") REFERENCES "public"."film_deliveries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_filling_delivery_id_filling_deliveries_id_fk" FOREIGN KEY ("filling_delivery_id") REFERENCES "public"."filling_deliveries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_evidence_document_version_id_document_versions_id_fk" FOREIGN KEY ("evidence_document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "delivery_confirmations" ADD CONSTRAINT "delivery_confirmations_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "delivery_confirmations_film_delivery_unique" ON "delivery_confirmations" ("film_delivery_id");
CREATE UNIQUE INDEX "delivery_confirmations_filling_delivery_unique" ON "delivery_confirmations" ("filling_delivery_id");
CREATE INDEX "delivery_confirmations_film_delivery_idx" ON "delivery_confirmations" ("film_delivery_id");
CREATE INDEX "delivery_confirmations_filling_delivery_idx" ON "delivery_confirmations" ("filling_delivery_id");
CREATE INDEX "delivery_confirmations_evidence_idx" ON "delivery_confirmations" ("evidence_document_version_id");
