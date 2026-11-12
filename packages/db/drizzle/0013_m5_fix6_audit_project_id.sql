-- M5 fix 6: audit_events gains the project it belongs to.
--
-- Until now the audit listing resolved a row's project by resolving its entity
-- back to its project at read time: one EXISTS per audited entity family,
-- nested twice for entities that hang off an order. Every new audited entity
-- kind had to extend that read-time resolver, and a fragment written for one
-- alias shape broke the next listing that reused it (the recurring
-- "column scoped.film_supply_order_id does not exist" failures).
--
-- The boundary is a property of the row, not of the query that reads it: the
-- write side already knows the project of everything it records, so it stamps
-- the row. The listing becomes a plain filter on this column and can no longer
-- leak another project's rows, whatever entities are added later.
--
-- Nullable on purpose: rows written before this column existed stay null, and
-- audit_events is append-only (migration 0001), so they cannot be backfilled.
ALTER TABLE "audit_events" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
CREATE INDEX "audit_events_project_idx" ON "audit_events" ("project_id");
