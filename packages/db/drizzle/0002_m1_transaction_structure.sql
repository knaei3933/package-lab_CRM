CREATE TYPE "public"."film_supply_order_status" AS ENUM('DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY', 'APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED', 'FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE', 'ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."measure_unit" AS ENUM('rolls', 'meters', 'sheets', 'pods', 'pieces');--> statement-breakpoint
CREATE TABLE "commission_readiness" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"film_delivery_recorded" boolean DEFAULT false NOT NULL,
	"filling_delivery_recorded" boolean DEFAULT false NOT NULL,
	"seven_po_officially_registered" boolean DEFAULT false NOT NULL,
	"is_ready" boolean DEFAULT false NOT NULL,
	"ready_at" timestamp with time zone,
	"evaluated_at" timestamp with time zone NOT NULL,
	"evaluated_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_readiness_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "commission_readiness_ready_requires_ready_at" CHECK (("commission_readiness"."is_ready" = false) or ("commission_readiness"."ready_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "filling_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"filling_order_id" uuid NOT NULL,
	"filling_order_line_id" uuid NOT NULL,
	"unit" "measure_unit" NOT NULL,
	"delivered_quantity" numeric(14,3) NOT NULL,
	"delivery_sequence" integer NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"carrier_reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "filling_deliveries_line_sequence_unique" UNIQUE("filling_order_line_id","delivery_sequence"),
	CONSTRAINT "filling_deliveries_unit_is_filling" CHECK ("filling_deliveries"."unit" in ('pods', 'pieces')),
	CONSTRAINT "filling_deliveries_quantity_positive" CHECK ("filling_deliveries"."delivered_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "filling_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"filling_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"ordered_quantity" numeric(14,3) NOT NULL,
	"unit" "measure_unit" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "filling_order_lines_order_line_unique" UNIQUE("filling_order_id","line_number"),
	CONSTRAINT "filling_order_lines_order_line_unit_unique" UNIQUE("filling_order_id","id","unit"),
	CONSTRAINT "filling_order_lines_unit_is_filling" CHECK ("filling_order_lines"."unit" in ('pods', 'pieces')),
	CONSTRAINT "filling_order_lines_quantity_positive" CHECK ("filling_order_lines"."ordered_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "filling_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "filling_orders_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "film_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_supply_order_id" uuid NOT NULL,
	"film_supply_order_line_id" uuid NOT NULL,
	"unit" "measure_unit" NOT NULL,
	"delivered_quantity" numeric(14,3) NOT NULL,
	"delivery_sequence" integer NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"carrier_reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "film_deliveries_line_sequence_unique" UNIQUE("film_supply_order_line_id","delivery_sequence"),
	CONSTRAINT "film_deliveries_unit_is_film" CHECK ("film_deliveries"."unit" in ('rolls', 'meters', 'sheets')),
	CONSTRAINT "film_deliveries_quantity_positive" CHECK ("film_deliveries"."delivered_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "film_supply_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_supply_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"ordered_quantity" numeric(14,3) NOT NULL,
	"unit" "measure_unit" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "film_supply_order_lines_order_line_unique" UNIQUE("film_supply_order_id","line_number"),
	CONSTRAINT "film_supply_order_lines_order_line_unit_unique" UNIQUE("film_supply_order_id","id","unit"),
	CONSTRAINT "film_supply_order_lines_unit_is_film" CHECK ("film_supply_order_lines"."unit" in ('rolls', 'meters', 'sheets')),
	CONSTRAINT "film_supply_order_lines_quantity_positive" CHECK ("film_supply_order_lines"."ordered_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "film_supply_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" "film_supply_order_status" DEFAULT 'DRAFT' NOT NULL,
	"seven_purchase_order_id" uuid,
	"hold_reason" text,
	"exception_note" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "film_supply_orders_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "pre_order_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"reference_code" text NOT NULL,
	"note" text,
	"original_received_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pre_order_references_reference_code_unique" UNIQUE("reference_code")
);
--> statement-breakpoint
CREATE TABLE "seven_purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"po_number" text NOT NULL,
	"pre_order_reference_id" uuid,
	"original_received_at" timestamp with time zone,
	"official_registered_at" timestamp with time zone,
	"promoted_at" timestamp with time zone,
	"promoted_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seven_purchase_orders_po_number_unique" UNIQUE("po_number"),
	CONSTRAINT "seven_purchase_orders_promotion_fields_pair" CHECK (("seven_purchase_orders"."promoted_at" is null) = ("seven_purchase_orders"."promoted_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "commission_readiness" ADD CONSTRAINT "commission_readiness_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_readiness" ADD CONSTRAINT "commission_readiness_evaluated_by_user_id_users_id_fk" FOREIGN KEY ("evaluated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filling_deliveries" ADD CONSTRAINT "filling_deliveries_line_fk" FOREIGN KEY ("filling_order_id","filling_order_line_id","unit") REFERENCES "public"."filling_order_lines"("filling_order_id","id","unit") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filling_order_lines" ADD CONSTRAINT "filling_order_lines_filling_order_id_filling_orders_id_fk" FOREIGN KEY ("filling_order_id") REFERENCES "public"."filling_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filling_orders" ADD CONSTRAINT "filling_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filling_orders" ADD CONSTRAINT "filling_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_deliveries" ADD CONSTRAINT "film_deliveries_line_fk" FOREIGN KEY ("film_supply_order_id","film_supply_order_line_id","unit") REFERENCES "public"."film_supply_order_lines"("film_supply_order_id","id","unit") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_supply_order_lines" ADD CONSTRAINT "film_supply_order_lines_film_supply_order_id_film_supply_orders_id_fk" FOREIGN KEY ("film_supply_order_id") REFERENCES "public"."film_supply_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_supply_orders" ADD CONSTRAINT "film_supply_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_supply_orders" ADD CONSTRAINT "film_supply_orders_seven_purchase_order_id_seven_purchase_orders_id_fk" FOREIGN KEY ("seven_purchase_order_id") REFERENCES "public"."seven_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_supply_orders" ADD CONSTRAINT "film_supply_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_order_references" ADD CONSTRAINT "pre_order_references_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_order_references" ADD CONSTRAINT "pre_order_references_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD CONSTRAINT "seven_purchase_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD CONSTRAINT "seven_purchase_orders_pre_order_reference_id_pre_order_references_id_fk" FOREIGN KEY ("pre_order_reference_id") REFERENCES "public"."pre_order_references"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD CONSTRAINT "seven_purchase_orders_promoted_by_user_id_users_id_fk" FOREIGN KEY ("promoted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seven_purchase_orders" ADD CONSTRAINT "seven_purchase_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pre_order_references_project_idx" ON "pre_order_references" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "seven_purchase_orders_project_idx" ON "seven_purchase_orders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "film_supply_orders_project_idx" ON "film_supply_orders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "film_supply_orders_status_idx" ON "film_supply_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "film_supply_order_lines_order_idx" ON "film_supply_order_lines" USING btree ("film_supply_order_id");--> statement-breakpoint
CREATE INDEX "film_deliveries_order_idx" ON "film_deliveries" USING btree ("film_supply_order_id");--> statement-breakpoint
CREATE INDEX "film_deliveries_line_idx" ON "film_deliveries" USING btree ("film_supply_order_line_id");--> statement-breakpoint
CREATE INDEX "filling_orders_project_idx" ON "filling_orders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "filling_order_lines_order_idx" ON "filling_order_lines" USING btree ("filling_order_id");--> statement-breakpoint
CREATE INDEX "filling_deliveries_order_idx" ON "filling_deliveries" USING btree ("filling_order_id");--> statement-breakpoint
CREATE INDEX "filling_deliveries_line_idx" ON "filling_deliveries" USING btree ("filling_order_line_id");
