-- P2 re-review N-1 (2026-11-21): close the race in the 0032 auditor session guard.
--
-- 0032's guard read users.role without a lock. When `UPDATE users SET role =
-- 'auditor'` had not committed yet, a login of the same user (an API build that
-- does not know the role) could still insert a bare-hash session: the guard
-- saw the committed role (staff), and the role trigger's revoke ran before that
-- session existed. The user then became an auditor holding a session the old
-- build accepts.
--
-- Fix: the guard reads the user row FOR SHARE (by id, then checks the role).
-- FOR SHARE conflicts with the FOR NO KEY UPDATE an UPDATE of users.role takes,
-- so the two orders serialize:
--   * role change first: the session INSERT waits for it, then sees 'auditor'
--     and is refused;
--   * session INSERT first: the role UPDATE waits for the login to commit, and
--     its revoke trigger (a new statement, a new snapshot) then sees and
--     revokes that session.
-- Only the guard function body changes (CREATE OR REPLACE of the 0032
-- function); the 0032 file and its triggers are untouched. Additive in effect
-- (no table, no row changes) and rerunnable.
--
-- Rollback (REPORT3.md §3; the full P2 rollback step R3 drops the function
-- anyway): restore the 0032 body —
--   CREATE OR REPLACE FUNCTION public.kanei_crm_mvp_sessions_auditor_guard()
--   RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
--   BEGIN
--     IF left(NEW.token_hash, 3) <> 'p2:' AND EXISTS (
--       SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.role::text = 'auditor'
--     ) THEN
--       RAISE EXCEPTION 'auditor sessions are issued only by an API build that knows the auditor role'
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     RETURN NEW;
--   END; $$;

CREATE OR REPLACE FUNCTION public.kanei_crm_mvp_sessions_auditor_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
BEGIN
  IF left(NEW.token_hash, 3) = 'p2:' THEN
    RETURN NEW;
  END IF;
  -- Lock by id (not by role): a pending role change must be waited for, and
  -- the row read after the wait is the committed one.
  SELECT u.role::text INTO v_role FROM public.users u WHERE u.id = NEW.user_id FOR SHARE;
  IF v_role = 'auditor' THEN
    RAISE EXCEPTION 'auditor sessions are issued only by an API build that knows the auditor role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
