-- P2 policy P-2 (representative approval 2026-11-21): an audit-only role,
-- separate from viewer. The auditor reads order codes, statuses, who approved
-- what and when, and evidence metadata (file name, hash, issuer); amounts and
-- unit prices stay hidden. The permission table lives in
-- packages/core/src/authorization.ts; this migration only lets the users row
-- hold the role.
--
-- 1. The enum value. Nothing in this migration run casts a literal to it, so it
--    is safe inside Drizzle's single transaction (PostgreSQL forbids using a
--    value added in the same transaction).
-- 2. users_role_valid (0000) listed the three roles. It is replaced by the same
--    rule plus 'auditor', compared as text so the not-yet-committed enum value
--    is not used. Every existing row satisfies both versions.
-- Rerunnable: ADD VALUE IF NOT EXISTS; the constraint is replaced only when it
-- does not already allow 'auditor'.
--
-- Rollback (REPORT.md §3): first make sure no user holds the role
--   (UPDATE users SET role = 'viewer', is_active = false WHERE role::text = 'auditor'
--    — a representative decision), then
--   ALTER TABLE "users" DROP CONSTRAINT "users_role_valid";
--   ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('admin', 'staff', 'viewer'));
-- The enum value itself cannot be dropped (see 0030) and stays unused.
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'auditor';--> statement-breakpoint
DO $$
DECLARE
  current_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_definition
    FROM pg_constraint
   WHERE conname = 'users_role_valid' AND conrelid = 'public.users'::regclass;
  IF current_definition IS NULL OR position('auditor' IN current_definition) = 0 THEN
    ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_valid";
    ALTER TABLE "users" ADD CONSTRAINT "users_role_valid"
      CHECK (("role")::text IN ('admin', 'staff', 'viewer', 'auditor'));
  END IF;
END $$;
