# KANEI CRM MVP (M0 + M1 + M2)

Isolated M0 foundation with the M1 transaction structure and the M2 document
intake. This repository intentionally does not connect to the legacy
`kanei-crm` or `pouch-clacul` systems.

## Local services

- Web: Next.js 15 App Router, Japanese UI, port `3080`
- API: Hono + TypeScript strict, port `3081`
- DB: isolated PostgreSQL 16, host port `5434`, database `kanei_crm_mvp`

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm test
```

Composite credentials (local development/test only):

| User | Role | Password |
| --- | --- | --- |
| `admin_composite` | `admin` | `composite-admin-pass` |
| `staff_composite` | `staff` | `composite-staff-pass` |
| `viewer_composite` | `viewer` | `composite-viewer-pass` |

## M0 contracts

- Project creation accepts only `route=F1`; `direct_film` and `F2` return 422 and persist nothing.
- Route mutation is rejected; the database additionally constrains projects to F1.
- Session tokens are random values and only SHA-256 hashes are stored.
- Authorization rechecks active user, session expiry, business unit, project assignment, and operation on every request.

## M1 transaction structure

New tables (migration `0002_m1_transaction_structure`): `film_supply_orders`,
`film_supply_order_lines`, `filling_orders`, `filling_order_lines`,
`film_deliveries`, `filling_deliveries`, `commission_readiness`,
`seven_purchase_orders`, `pre_order_references`.

- Units vocabulary (design section 5): film units are `rolls`, `meters`, `sheets`;
  filling units are `pods`, `pieces`. One `measure_unit` enum plus per-table
  CHECK constraints pin each table to one side of the film/filling boundary;
  deliveries additionally carry a composite FK `(order, line, unit)` that must
  match the referenced line. Mixing units across the boundary returns 422
  `UNIT_DOMAIN_MISMATCH` (T-16).
- Deliveries are append-only: split deliveries are new rows with a per-line
  `delivery_sequence`; a recorded quantity is never overwritten, and migration
  `0003_m1_delivery_append_only` blocks UPDATE/DELETE at the database level
  (T-17). Ordered quantities on lines are reference data — a delivery of 95000
  against 100000 ordered persists 95000 in `filling_deliveries` only (T-15).
- A film delivery writes only its delivery row and one audit row; it never
  creates filling deliveries or commission rows (T-14). `commission_readiness`
  is written only by the explicit evaluate endpoint.
- Date separation rule (design section 5.6): `official_registered_at` is the
  only date used by gate checks; `original_received_at` is reference-only and
  can never satisfy a gate. The `SEVEN_PO_VERIFIED` gate returns 422
  `OFFICIAL_REGISTRATION_REQUIRED` when `official_registered_at` is missing.
- Film supply order states (design sections 6.1/6.5): the normal chain runs
  DRAFT → SEVEN_PO_VERIFIED → ARTWORK_RECEIVED → PROOF_READY → APPROVAL_PENDING
  → DUAL_APPROVED → MAKER_PO_READY → APPROVED_FOR_MANUAL_SEND →
  MAKER_PO_SENT_MANUALLY → MAKER_PO_ACCEPTED → FILM_IN_PRODUCTION →
  FILM_SHIPPED → FILM_DELIVERED → FILM_RECEIPT_ASSUMED_NO_ISSUE (terminal), with
  exception states ON_HOLD, CHANGE_REVIEW, and CANCELLATION_REVIEW reachable
  from every non-terminal normal state.
- Every state-changing write inserts its `audit_events` row in the same
  transaction as the write; `audit_events` remain append-only via the M0
  triggers.

M1 endpoints (all composite test data, assignment-scoped authorization):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/projects/:projectId/seven-purchase-orders` | Create a seven purchase order |
| POST | `/api/seven-purchase-orders/:poId/register-official` | Stamp `official_registered_at` |
| POST | `/api/projects/:projectId/pre-order-references` | Create a pre-order reference |
| POST | `/api/pre-order-references/:preOrderId/promote` | Promote to a seven PO (`promoted_at`/`promoted_by`) |
| POST | `/api/projects/:projectId/film-supply-orders` | Create film supply order (optional inline lines) |
| POST | `/api/film-supply-orders/:orderId/lines` | Add a film line (film units only) |
| POST | `/api/film-supply-orders/:orderId/deliveries` | Record a film delivery (split = new row) |
| POST | `/api/film-supply-orders/:orderId/transitions` | State transition with gates |
| POST | `/api/projects/:projectId/filling-orders` | Create filling order (optional inline lines) |
| POST | `/api/filling-orders/:orderId/lines` | Add a filling line (filling units only) |
| POST | `/api/filling-orders/:orderId/deliveries` | Record a filling delivery (split = new row) |
| POST | `/api/projects/:projectId/commission-readiness` | Evaluate commission readiness |

Tests: `tests/m1/core-rules.test.ts` (state machine, date separation, units) and
`tests/m1/m1-transaction.test.ts` (T-14, T-15, T-16, T-17, gate behavior, audit
immutability, commission readiness).

## M2 document intake and PO precedence

New tables (migration `0004_m2_documents`): `documents`, `document_versions`,
plus authenticity-checklist columns on `seven_purchase_orders`. Migration
`0005_m2_document_integrity` extends the M0 `audit_events` immutability pattern:
`document_versions` rows are append-only (a correction is a new version row,
never a rewrite of recorded bytes), and `pre_order_references` are append-only
so `original_received_at` stays immutable reference data.

- `document_versions.sha256` is always computed by the server from the received
  bytes; `storage_path` is a server-generated randomized path inside a private
  storage folder (`DOCUMENT_STORAGE_DIR`, default a `0700` folder under the OS
  temp dir). The client filename is display metadata only and is never part of
  the path. Size and type checks (`DOCUMENT_MAX_BYTES`, an allowlist of
  content types plus magic-byte sniffing) run before anything is persisted, and
  only uploads that pass both checks reach a row.
- Identical bytes always share one physical file: the same document re-uploaded
  resolves to its existing version (T-27 idempotency, no new events/approvals/
  orders), and the same bytes uploaded to another project create a separate
  documents row referencing the same physical file (T-26).
- A PO document uploaded before any verified PO becomes an append-only
  `pre_order_references` row carrying `original_received_at`.
- Two gate axes stay separate (design section 5.6): the date axis reads
  `official_registered_at` ONLY — checklist verification can never substitute
  for the missing registration date (T-06) — and the authenticity axis comes
  from a human record, never from metadata (T-18).
- The seven authenticity checklist items (design section 5.10): issuer name,
  document number and issue date, sending channel, past-transaction
  comparison, quote comparison, tamper-hint notes (advisory only, stored
  verbatim, never deciding the verdict), and a confirmation reply that is
  required exactly when the reviewer marked the document uncertain. A
  quote-vs-PO mismatch stores `verification_status = 'mismatch'` with
  `review_pending = true`, and every precedence gate stays closed (T-19).
- Registering an official artifact (proof / approval / send / acceptance
  evidence) or a supply order against a purchase order requires that PO to be
  both officially registered and checklist-verified; anything else returns 422
  and persists nothing (T-04, T-05). M1 endpoints are unchanged: the film order
  transition gate still reads `official_registered_at` only.

M2 endpoints (composite test data, assignment-scoped authorization):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/projects/:projectId/documents` | Upload a document version (JSON `contentBase64` or multipart `file`) |
| POST | `/api/documents/:documentId/verify` | Record a human document verification (separate from the hash) |
| POST | `/api/seven-purchase-orders/:poId/verification-checklist` | Record the 7-item authenticity checklist (`verified_by`/`verified_at`/`verification_note`) |
| POST | `/api/pre-order-references/:preOrderId/promote-official` | Stamp `official_registered_at` + `promoted_at`/`promoted_by` after checklist verification |
| POST | `/api/seven-purchase-orders/:poId/supply-orders` | Register a film supply order against a verified PO |

Tests: `tests/m2/core-rules.test.ts` (document vocabulary, precedence gate
T-06, checklist T-18/T-19) and `tests/m2/m2-documents.test.ts` (T-04, T-05,
T-18, T-19, T-26, T-27, pre-order immutability, promote-official, size/type
rejections, multipart intake, document verification).
