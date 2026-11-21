-- P2 R05 (representative approval 2026-11-21): the Idempotency-Key answers
-- are kept in the database instead of the API process memory, so an API
-- restart or a second API process still replays a completed write (P0 R05 kept
-- them in memory for 24 hours, one process only).
--
-- One row per (user, key). A row is 'pending' while the first request runs and
-- 'completed' once its 2xx answer is stored; a refusal or an outage deletes the
-- row so a corrected or retried submit really runs (same rule as P0). A pending
-- row whose lease ran out (the process died mid-request) may be taken over.
-- Rows expire after 24 hours and are swept by the API.
--
-- Additive: a new table only. The stored body is the API's own answer to that
-- same user (it may include the representative's amounts, exactly as the
-- answer did); nothing outside the API reads this table.
-- Rerunnable (IF NOT EXISTS / catalog guards).
--
-- Rollback (REPORT.md §3): revert the API to the in-memory store, then
--   DROP TABLE IF EXISTS "idempotency_keys";
-- Only the replay memory is lost; DB unique constraints (409 DUPLICATE) stay
-- the durable duplicate guard, as before P2.

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"response_status" smallint,
	"response_body" text,
	"response_content_type" text,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY ("user_id", "idempotency_key"),
	CONSTRAINT "idempotency_keys_key_format" CHECK ("idempotency_key" ~ '^[A-Za-z0-9_.:-]{8,128}$'),
	CONSTRAINT "idempotency_keys_state_vocabulary" CHECK ("state" IN ('pending', 'completed')),
	-- A completed row always carries the 2xx answer it replays; a pending row none.
	CONSTRAINT "idempotency_keys_completed_has_answer" CHECK (
		("state" = 'pending' AND "response_status" IS NULL AND "response_body" IS NULL AND "completed_at" IS NULL)
		OR ("state" = 'completed' AND "response_status" BETWEEN 200 AND 299 AND "response_body" IS NOT NULL AND "completed_at" IS NOT NULL)
	),
	CONSTRAINT "idempotency_keys_body_size" CHECK ("response_body" IS NULL OR octet_length("response_body") <= 262144),
	CONSTRAINT "idempotency_keys_expiry_after_creation" CHECK ("expires_at" > "created_at")
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_user_id_fk' AND conrelid = 'public.idempotency_keys'::regclass) THEN
    ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");
