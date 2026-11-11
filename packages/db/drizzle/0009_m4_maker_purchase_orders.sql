-- M4: maker purchase orders with manual-send evidence (design section 5.8).
--
-- maker_purchase_orders is the frozen paper: the snapshot jsonb holds the order
-- identity, items with quantities, specs, artwork file hashes, amounts and the
-- recipient address; snapshot_sha256 is computed by the server over the
-- canonical JSON of that snapshot and is what the CEO approves. Status
-- transitions are enforced by the API on top of these rows; the database pins
-- the invariants that survive any writer: the digest format, the approval
-- stamp pair, and the rule that only DRAFT has never been approved.
--
-- maker_po_events is the append-only lifecycle log; migration 0010 blocks
-- UPDATE/DELETE by trigger exactly like the M0 audit_events pattern.
CREATE TYPE "public"."maker_purchase_order_status" AS ENUM('DRAFT', 'APPROVED_FOR_MANUAL_SEND', 'SEND_UNVERIFIED', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED', 'SNAPSHOT_VOIDED');--> statement-breakpoint
CREATE TYPE "public"."maker_po_event_type" AS ENUM('CEO_APPROVED', 'SNAPSHOT_VOIDED', 'SEND_EVIDENCE_REGISTERED', 'ACCEPT_EVIDENCE_REGISTERED', 'SEND_REJECTED');--> statement-breakpoint
CREATE TYPE "public"."maker_po_event_verification_status" AS ENUM('VERIFIED', 'UNVERIFIED');--> statement-breakpoint
CREATE TABLE "maker_purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_supply_order_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"status" "maker_purchase_order_status" DEFAULT 'DRAFT' NOT NULL,
	"ceo_approved_by_user_id" uuid,
	"ceo_approved_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maker_purchase_orders_sha256_format" CHECK ("maker_purchase_orders"."snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "maker_purchase_orders_ceo_approval_pair" CHECK (("maker_purchase_orders"."ceo_approved_at" is null) = ("maker_purchase_orders"."ceo_approved_by_user_id" is null)),
	CONSTRAINT "maker_purchase_orders_status_requires_ceo_approval" CHECK ("maker_purchase_orders"."status" = 'DRAFT' or "maker_purchase_orders"."ceo_approved_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "maker_po_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"maker_purchase_order_id" uuid NOT NULL,
	"event_type" "maker_po_event_type" NOT NULL,
	"evidence_document_version_id" uuid,
	"sender_address" text,
	"recipients" jsonb,
	"sent_at" timestamp with time zone,
	"attachment_hashes" jsonb,
	"verification_status" "maker_po_event_verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maker_purchase_orders" ADD CONSTRAINT "maker_purchase_orders_film_supply_order_id_film_supply_orders_id_fk" FOREIGN KEY ("film_supply_order_id") REFERENCES "public"."film_supply_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_purchase_orders" ADD CONSTRAINT "maker_purchase_orders_ceo_approved_by_user_id_users_id_fk" FOREIGN KEY ("ceo_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_purchase_orders" ADD CONSTRAINT "maker_purchase_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_po_events" ADD CONSTRAINT "maker_po_events_maker_purchase_order_id_maker_purchase_orders_id_fk" FOREIGN KEY ("maker_purchase_order_id") REFERENCES "public"."maker_purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_po_events" ADD CONSTRAINT "maker_po_events_evidence_document_version_id_document_versions_id_fk" FOREIGN KEY ("evidence_document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_po_events" ADD CONSTRAINT "maker_po_events_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maker_purchase_orders_order_idx" ON "maker_purchase_orders" USING btree ("film_supply_order_id");--> statement-breakpoint
CREATE INDEX "maker_purchase_orders_status_idx" ON "maker_purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "maker_po_events_po_idx" ON "maker_po_events" USING btree ("maker_purchase_order_id");--> statement-breakpoint
CREATE INDEX "maker_po_events_type_idx" ON "maker_po_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "maker_po_events_evidence_idx" ON "maker_po_events" USING btree ("evidence_document_version_id");--> statement-breakpoint
-- M4 order-level evidence binding (design section 5.4: documents carry
-- project_id and order_id). Send and acceptance evidence is about the whole
-- maker paper, so it carries the order without naming a design; the M3 artwork
-- pair (order + design) and the unbound input documents both stay valid.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_artwork_binding_pair";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_artwork_binding_pair" CHECK (("documents"."film_supply_order_id" is null and "documents"."design_key" is null) or ("documents"."film_supply_order_id" is not null and "documents"."design_key" is not null) or ("documents"."film_supply_order_id" is not null and "documents"."design_key" is null));
