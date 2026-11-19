-- R1 review M7: the 0023 lot check allowed a NULL lot marking because
-- length(btrim(NULL)) is NULL rather than false. Replace it with explicit
-- null semantics. Existing rows are not changed.

ALTER TABLE "artwork_revisions"
  DROP CONSTRAINT "artwork_revisions_lot_change_marking_required";--> statement-breakpoint
ALTER TABLE "artwork_revisions"
  ADD CONSTRAINT "artwork_revisions_lot_change_marking_required" CHECK (
    "change_requested_organization" IS NULL
    OR (
      "lot_marking" IS NOT NULL
      AND length(btrim("lot_marking")) > 0
    )
  );
