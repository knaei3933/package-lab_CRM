-- P2 R29 (representative approval 2026-11-21): each user's display language
-- is kept on the server, so the same choice follows the user to every device
-- (P1 kept it in a per-device cookie bound to the user id).
--
-- 'ja' = 日本語, 'ja-ko' = 日本語＋한국어, 'ko' = 한국어. NULL means "not chosen":
-- the screen keeps its role default (representative ja-ko, everyone else ja),
-- which is exactly what every existing user sees today. Additive and
-- rerunnable; existing rows stay NULL.
--
-- Rollback (REPORT.md §3):
--   ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_display_language_vocabulary";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "display_language";
-- Users fall back to the role default (or the P1 cookie) again.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_language" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_display_language_vocabulary' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_display_language_vocabulary"
      CHECK ("display_language" IS NULL OR "display_language" IN ('ja', 'ja-ko', 'ko'));
  END IF;
END $$;
