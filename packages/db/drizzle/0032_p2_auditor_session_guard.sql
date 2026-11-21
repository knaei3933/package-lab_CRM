-- P2 review M-3 (2026-11-21): a database-level guard so an API build that does
-- not know the auditor role (P1, 48ea0f1 and earlier) can never hold an
-- auditor session. Such a build treats an unknown role like staff (writes) and
-- answers it admin-shaped views (amounts) — so it must not authenticate one.
--
-- How: an API that knows the auditor role (P2+) stores an auditor's session
-- token hash with the prefix 'p2:'. A session row for an auditor without that
-- prefix is refused here, so
--   * an old build's login of an auditor fails at its session INSERT (no
--     cookie is issued), and
--   * an old build cannot find a P2-issued auditor session (it looks up the
--     bare hash), so an existing auditor cookie answers 401 there.
-- When a user becomes an auditor, every session that user already holds is
-- revoked, so a cookie issued under the old role cannot carry over.
--
-- Additive: two new functions and two new triggers. No existing row changes
-- (no current user holds the role in main; the role trigger fires only on a
-- role change). Existing triggers (0001-0024) are untouched. Rerunnable:
-- CREATE OR REPLACE and DROP TRIGGER IF EXISTS before CREATE TRIGGER.
--
-- Rollback (REPORT2.md §3, its own step after the auditors are deactivated):
--   DROP TRIGGER IF EXISTS "users_auditor_role_revokes_sessions" ON "users";
--   DROP TRIGGER IF EXISTS "sessions_auditor_requires_role_aware_api" ON "sessions";
--   DROP FUNCTION IF EXISTS public.kanei_crm_mvp_users_auditor_role_revokes_sessions();
--   DROP FUNCTION IF EXISTS public.kanei_crm_mvp_sessions_auditor_guard();

CREATE OR REPLACE FUNCTION public.kanei_crm_mvp_sessions_auditor_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF left(NEW.token_hash, 3) <> 'p2:' AND EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.role::text = 'auditor'
  ) THEN
    RAISE EXCEPTION 'auditor sessions are issued only by an API build that knows the auditor role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "sessions_auditor_requires_role_aware_api" ON "sessions";--> statement-breakpoint
CREATE TRIGGER "sessions_auditor_requires_role_aware_api"
  BEFORE INSERT OR UPDATE OF "token_hash", "user_id" ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION public.kanei_crm_mvp_sessions_auditor_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.kanei_crm_mvp_users_auditor_role_revokes_sessions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.sessions
     SET revoked_at = now()
   WHERE user_id = NEW.id
     AND revoked_at IS NULL;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_auditor_role_revokes_sessions" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_auditor_role_revokes_sessions"
  AFTER UPDATE OF "role" ON "users"
  FOR EACH ROW
  WHEN (NEW.role::text = 'auditor' AND OLD.role::text IS DISTINCT FROM 'auditor')
  EXECUTE FUNCTION public.kanei_crm_mvp_users_auditor_role_revokes_sessions();
