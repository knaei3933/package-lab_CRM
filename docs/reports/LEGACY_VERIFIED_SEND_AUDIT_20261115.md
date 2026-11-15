# Legacy VERIFIED send audit — 2026-11-15 (M8-HARDEN STEP 5)

Scope: maker purchase orders and send events whose `verificationStatus='VERIFIED'`
was recorded **without** the email content verification that FIX C1 now requires.

Status: **the query below is ready, but it has NOT been executed here.** `psql`
against the databases requires an approval this unit does not hold (the tool call
was denied, and the same boundary applied to `npm`/`node` runs), and the main DB
may only be read for this audit. The parent should run the two statements below —
they are read-only (`SELECT` only, no writes, no locks beyond a read).

## What counts as "legacy"

Migration `0018_m8_harden_maker_po_active_unique_eml_evidence.sql` adds
`maker_po_events.verification_method`. Every row written before M8-HARDEN has
`verification_method IS NULL`, because before FIX C1 a send became `VERIFIED` on
the strength of *metadata* alone — a cited document of type `send_evidence` whose
content was never read, plus a request-declared recipient list. A plain text
note, a screenshot or a PDF could reach `VERIFIED`.

Two rows are deliberately **not** legacy even when `verification_method` is null:

- `event_type <> 'SEND_EVIDENCE_REGISTERED'` (a CEO approval, a void, a refusal —
  they carry no send evidence at all);
- `verification_status <> 'VERIFIED'` (unverified or pending registrations never
  claimed to prove a send).

## The review list (main DB — SELECT only)

```sql
-- Legacy VERIFIED sends on the main database: read-only.
SELECT
  po.id                                       AS maker_purchase_order_id,
  po.film_supply_order_id,
  po.snapshot -> 'order' ->> 'code'           AS order_code,
  po.status                                   AS po_status_now,
  e.id                                        AS event_id,
  e.verification_status,
  e.verification_method,                      -- NULL on every pre-M8-HARDEN row
  (e.evidence_document_version_id IS NOT NULL) AS had_evidence_document,
  dv.declared_mime_type                       AS evidence_declared_mime_type,
  dv.original_filename                        AS evidence_filename,
  e.sender_address,
  e.recipients,
  e.sent_at,
  e.recorded_at
FROM maker_po_events e
JOIN maker_purchase_orders po ON po.id = e.maker_purchase_order_id
LEFT JOIN document_versions dv ON dv.id = e.evidence_document_version_id
WHERE e.event_type = 'SEND_EVIDENCE_REGISTERED'
  AND e.verification_status = 'VERIFIED'
  AND (e.verification_method IS NULL OR e.verification_method <> 'eml_header_check')
ORDER BY e.recorded_at, e.id;

-- The same list, summarised by evidence type (what the CEO reviews first).
SELECT
  COALESCE(dv.declared_mime_type, '(no evidence document)') AS evidence_type,
  COUNT(*)                                                  AS events,
  MIN(e.recorded_at)                                        AS first_recorded,
  MAX(e.recorded_at)                                        AS last_recorded
FROM maker_po_events e
LEFT JOIN document_versions dv ON dv.id = e.evidence_document_version_id
WHERE e.event_type = 'SEND_EVIDENCE_REGISTERED'
  AND e.verification_status = 'VERIFIED'
  AND (e.verification_method IS NULL OR e.verification_method <> 'eml_header_check')
GROUP BY 1
ORDER BY events DESC;
```

Columns to review per row: the PO and order ids, the dates, and the evidence
type — `(no evidence document)` (a bare timestamp that somehow read VERIFIED is
not possible, so this means the row predates the evidence column), `text/plain`
(a note or a mail text file), `application/pdf` / `image/*` (a scan or
screenshot), `message/rfc822` (a genuine mail export whose content was never
checked). Nothing in this audit is rewritten by M8-HARDEN: the rows stay exactly
as recorded, and the proven-send carve-out keeps every already-shipped paper
readable and un-retroactively blocked.

## Test database confirmation (isolated kanei_crm_mvp_test)

After migration 0018 and the M8-HARDEN code, the test database must hold **no**
legacy row:

```sql
SELECT COUNT(*) AS legacy_verified_sends
FROM maker_po_events
WHERE event_type = 'SEND_EVIDENCE_REGISTERED'
  AND verification_status = 'VERIFIED'
  AND (verification_method IS NULL OR verification_method <> 'eml_header_check');
-- expected: 0
```

Static reading of the suite confirms why: after M8-HARDEN the API can only write
`verification_status='VERIFIED'` through the `.eml` header verification, and it
always stamps `verification_method='eml_header_check'` on that event
(`apps/api/src/app.ts`, the `maker_po:send_evidence` transaction). The tests that
drive a send to `VERIFIED` all go through `tests/helpers/maker-po-evidence.ts`,
which posts an `.eml`; the pending and refused paths are pinned separately in
`tests/m8-fail/m8-fail-scenarios.test.ts` and `tests/m8-harden/`.

Execution was not possible in this unit (see the status line above), so the
`0` is a static conclusion, not an observed row count.
