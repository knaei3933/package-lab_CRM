-- M8-OPER2 FIX 2: the manual verification of a PDF/image approval's evidence
-- identifier.
--
-- M8-OPERATOR FIX 4 made binary evidence (PDF/image) unable to prove its quoted
-- identifier by substring, so its approval event is recorded with
-- evidence_identifier_status='pending_manual_verification' and stays out of the
-- dual-approval gate. This migration adds the record of the human check that
-- lifts that hold:
--
-- - one new table, evidence_manual_verifications. It is deliberately not a new
--   row in artwork_approval_events: an approval event is an external decision
--   (organization, decision, revision hash) and its insert trigger asserts
--   exactly that shape, while a verification is an internal human check OF one
--   approval event. Sentinel organizations and decisions would have weakened
--   the approval table's own integrity rules to make room for it.
-- - the table is append-only by trigger, exactly like artwork_approval_events
--   (migration 0007): UPDATE and DELETE are rejected, a correction is a new
--   row, and the latest row for an approval event is the one the gate reads.
-- - every insert is guarded: the target approval event must exist, must be an
--   APPROVE whose identifier is actually pending manual verification, must cite
--   an evidence identifier, and the verification must name the approval's own
--   revision, evidence version and revision hash — a verification can never
--   confirm a decision about other bytes, and an approval that was already
--   verified (or was never pending) cannot be re-verified into existence.
CREATE TABLE IF NOT EXISTS "evidence_manual_verifications" (
  "id" uuid PRIMARY KEY NOT NULL,
  "approval_event_id" uuid NOT NULL REFERENCES "artwork_approval_events"("id"),
  "artwork_revision_id" uuid NOT NULL REFERENCES "artwork_revisions"("id"),
  "evidence_document_version_id" uuid NOT NULL REFERENCES "document_versions"("id"),
  "approved_file_sha256" text NOT NULL,
  "result" text NOT NULL,
  "verifier_name" text NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "reason_note" text NOT NULL,
  "recorded_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evidence_manual_verifications_result_vocabulary" CHECK ("result" in ('confirmed', 'rejected')),
  CONSTRAINT "evidence_manual_verifications_sha256_format" CHECK ("approved_file_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "evidence_manual_verifications_verifier_name_not_blank" CHECK (length(btrim("verifier_name")) > 0),
  CONSTRAINT "evidence_manual_verifications_reason_not_blank" CHECK (length(btrim("reason_note")) > 0)
);

CREATE INDEX IF NOT EXISTS "evidence_manual_verifications_approval_event_idx"
  ON "evidence_manual_verifications" ("approval_event_id");
CREATE INDEX IF NOT EXISTS "evidence_manual_verifications_revision_idx"
  ON "evidence_manual_verifications" ("artwork_revision_id");

CREATE OR REPLACE FUNCTION kanei_crm_mvp_block_evidence_manual_verification_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evidence_manual_verifications are append-only; record a new verification instead of rewriting a human decision';
END;
$$;

CREATE OR REPLACE FUNCTION kanei_crm_mvp_assert_evidence_manual_verification_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_decision approval_decision;
  v_identifier_status text;
  v_identifier text;
  v_revision_id uuid;
  v_sha256 text;
  v_evidence_version_id uuid;
BEGIN
  SELECT decision, evidence_identifier_status, evidence_identifier,
         artwork_revision_id, approved_file_sha256, evidence_document_version_id
    INTO v_decision, v_identifier_status, v_identifier,
         v_revision_id, v_sha256, v_evidence_version_id
  FROM artwork_approval_events
  WHERE id = NEW.approval_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual verification references an unknown approval event';
  END IF;

  IF v_decision <> 'APPROVE' THEN
    RAISE EXCEPTION 'manual verification targets a decision that never contributes to an approval';
  END IF;
  IF v_identifier_status IS DISTINCT FROM 'pending_manual_verification' THEN
    RAISE EXCEPTION 'manual verification targets an approval whose identifier is not pending manual verification';
  END IF;
  IF v_identifier IS NULL THEN
    RAISE EXCEPTION 'manual verification targets an approval without a recorded evidence identifier';
  END IF;

  IF NEW.artwork_revision_id IS DISTINCT FROM v_revision_id
     OR NEW.evidence_document_version_id IS DISTINCT FROM v_evidence_version_id
     OR NEW.approved_file_sha256 IS DISTINCT FROM v_sha256 THEN
    RAISE EXCEPTION 'manual verification must name the approval event''s own revision, evidence version and revision hash';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evidence_manual_verifications_no_update ON evidence_manual_verifications;
CREATE TRIGGER evidence_manual_verifications_no_update
BEFORE UPDATE ON evidence_manual_verifications
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_evidence_manual_verification_mutation();

DROP TRIGGER IF EXISTS evidence_manual_verifications_no_delete ON evidence_manual_verifications;
CREATE TRIGGER evidence_manual_verifications_no_delete
BEFORE DELETE ON evidence_manual_verifications
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_block_evidence_manual_verification_mutation();

DROP TRIGGER IF EXISTS evidence_manual_verifications_target_check ON evidence_manual_verifications;
CREATE TRIGGER evidence_manual_verifications_target_check
BEFORE INSERT ON evidence_manual_verifications
FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_evidence_manual_verification_target();
