-- P2 R33 minimum (policy P-8, representative approval 2026-11-21): the maker
-- (製造先) master keeps the mail addresses a maker purchase order may be sent
-- to, so the paper's recipient is chosen from a list instead of typed (H5).
--
-- The maker itself is the existing accounts row with role 'maker' (projects
-- already point at it through maker_account_id); this migration only adds the
-- address list. Additive: a new table, no existing row is touched.
-- Rows are never deleted by the API: an address that must not be used any more
-- is deactivated (is_active = false), so a maker PO snapshot that copied it
-- keeps a readable history. Rerunnable (IF NOT EXISTS / catalog guards).
--
-- Rollback (REPORT.md §3):
--   DROP TABLE IF EXISTS "maker_recipient_addresses";
-- Maker PO snapshots keep their copied address text, so nothing else changes.

CREATE TABLE IF NOT EXISTS "maker_recipient_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Same shape the API checks (P0 R10): one @, no spaces, a dot in the domain.
	CONSTRAINT "maker_recipient_addresses_email_format" CHECK ("email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND length("email") <= 254),
	CONSTRAINT "maker_recipient_addresses_email_lowercase" CHECK ("email" = lower("email")),
	CONSTRAINT "maker_recipient_addresses_label_length" CHECK ("label" IS NULL OR (length(btrim("label")) > 0 AND length("label") <= 100)),
	-- Only a usable address can be the default one.
	CONSTRAINT "maker_recipient_addresses_default_is_active" CHECK ("is_default" = false OR "is_active" = true)
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maker_recipient_addresses_account_id_fk' AND conrelid = 'public.maker_recipient_addresses'::regclass) THEN
    ALTER TABLE "maker_recipient_addresses" ADD CONSTRAINT "maker_recipient_addresses_account_id_fk"
      FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maker_recipient_addresses_created_by_user_id_fk' AND conrelid = 'public.maker_recipient_addresses'::regclass) THEN
    ALTER TABLE "maker_recipient_addresses" ADD CONSTRAINT "maker_recipient_addresses_created_by_user_id_fk"
      FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maker_recipient_addresses_updated_by_user_id_fk' AND conrelid = 'public.maker_recipient_addresses'::regclass) THEN
    ALTER TABLE "maker_recipient_addresses" ADD CONSTRAINT "maker_recipient_addresses_updated_by_user_id_fk"
      FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- One address per maker (case already folded by the lowercase check).
CREATE UNIQUE INDEX IF NOT EXISTS "maker_recipient_addresses_account_email_unique"
  ON "maker_recipient_addresses" USING btree ("account_id", "email");--> statement-breakpoint
-- At most one default address per maker, so "the default" is never ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "maker_recipient_addresses_one_default"
  ON "maker_recipient_addresses" USING btree ("account_id") WHERE "is_default" = true;
