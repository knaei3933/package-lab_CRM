# KANEI CRM MVP (M0 + M1 + M2 + M3 + M4)

Isolated M0 foundation with the M1 transaction structure, the M2 document
intake, the M3 proof revisions and dual approval, and the M4 maker purchase
orders with manual-send evidence. This repository intentionally does not
connect to the legacy `kanei-crm` or `pouch-clacul` systems.

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

## M3 proof revisions and dual approval

New tables (migration `0006_m3_artwork_approvals`): `artwork_revisions`,
`artwork_approval_events`, plus optional artwork-binding columns
(`film_supply_order_id`, `design_key`) on `documents`. Migration
`0007_m3_approval_event_integrity` extends the M0 `audit_events` immutability
pattern: `artwork_approval_events` are append-only (UPDATE and DELETE are
rejected by trigger, T-12), `artwork_revisions` keep their identity forever
(order, design, revision number and file can never be edited, and a revision is
never deleted — only `lot_marking`/`note` may be corrected), and both tables are
guarded on insert: an event must carry the exact hash of the revision file it
approves, and its evidence document must be bound to the same order, design and
company as that revision (T-35).

- A revision is one registered version of one design of one order:
  `revision_no` is unique per (order, `design_key`) and never reused, and the
  artwork file is an append-only `document_versions` row whose `sha256` is the
  revision hash. Registration is only possible for an order past
  `SEVEN_PO_VERIFIED`.
- An approval event records an external fact: which organization
  (`customer` / `seven`) decided (`APPROVE` / `REVOKE`) about which revision
  hash, decided by whom (`external_approver_name` / `external_approver_org`,
  text only), proven by which evidence document version (required, of type
  `approval_evidence`) from which source (`email` / `signed_document` /
  `other_verified`), decided when (`event_time`, the external time) and written
  down when (`recorded_at`). `recorded_by_user_id` is always the internal user
  who recorded the fact, never the external approver. A re-approval supersedes
  the previous event (`supersedes_event_id`).
- Approval is derived, never stored: a valid approval for an organization
  exists only while the latest effective event for that organization on the
  current revision is an uncanceled APPROVE whose `approved_file_sha256` equals
  the current revision hash. Approval never transfers across revisions — a new
  revision starts with zero approvals (T-11) and prior approvals remain readable
  as audit history. A REVOKE invalidates only that organization (T-13).
- Dual approval is order-independent: customer then seven (T-09) and seven then
  customer (T-10) both reach `DUAL_APPROVED`, while either organization alone
  keeps the gate closed (T-07, T-08). With several designs the order gate stays
  closed until every required design (every design with at least one registered
  revision) holds both approvals (T-34). The gate is read from
  `GET /api/film-supply-orders/:orderId/approval-gate` and is re-checked when
  transitioning to `MAKER_PO_READY`, so a revocation closes a previously
  approved order's path forward.
- Evidence binding is recorded at document intake: uploads may carry
  `filmSupplyOrderId` + `designKey`, which must agree with each other and with
  the project. An approval whose evidence references a different order, design
  or company is rejected and nothing is persisted (T-35).

M3 endpoints (composite test data, assignment-scoped authorization):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/film-supply-orders/:orderId/artwork-revisions` | Register a revision of one design (order must be past `SEVEN_PO_VERIFIED`; a design with prior approvals enters `CHANGE_REVIEW`, T-11) |
| POST | `/api/artwork-revisions/:revisionId/approvals` | Record an APPROVE or REVOKE event for `customer` or `seven`, with required evidence (recorder = logged-in internal user) |
| GET | `/api/film-supply-orders/:orderId/approval-gate` | Derived dual-approval gate per design and for the whole order |

Tests: `tests/m3/core-rules.test.ts` (derived gate rules T-07 to T-11, T-13,
T-34, hash binding, evidence binding, revision gate) and
`tests/m3/m3-approvals.test.ts` (T-07 to T-13, T-34, T-35 against the API and
database, including append-only rejections, revision numbering, the
`MAKER_PO_READY` gate and same-transaction audit rows).

Repair note: migration `0008_m3_fix_append_only_and_order_linkage` re-applies
the M3 append-only trigger definitions verbatim (so a database migrated from an
earlier revision of migration `0007` raises rejections whose message again
contains `append-only`, T-12) and ensures the documents order linkage columns
(`film_supply_order_id`, `design_key`) exist with their foreign key, pair check
and index. A document's first `document_versions` row shares the document's id,
so an evidence record is addressable by the document id or by the version id
that was cited.

## M4 maker purchase orders with manual-send evidence

New tables (migration `0009_m4_maker_purchase_orders`): `maker_purchase_orders`
and `maker_po_events`. Migration `0010_m4_maker_po_event_integrity` extends the
M0 `audit_events` immutability pattern: `maker_po_events` are append-only and
UPDATE/DELETE are rejected by trigger with a message naming the contract.

- `maker_purchase_orders` is the frozen paper (design section 5.8): `snapshot`
  holds the order identity, items with quantities, specs (the approved artwork
  file hashes per design), amounts and the recipient address, and
  `snapshot_sha256` is computed by the server over the canonical JSON of that
  snapshot — never taken from the client. The status enum is `DRAFT`,
  `APPROVED_FOR_MANUAL_SEND`, `SEND_UNVERIFIED`, `MAKER_PO_SENT_MANUALLY`,
  `MAKER_PO_ACCEPTED`, `SNAPSHOT_VOIDED`, with `ceo_approved_by`/`ceo_approved_at`
  stamping who approved which digest. The database pins the invariants: digest
  format, the approval stamp pair, and that only `DRAFT` was never approved.
- Snapshot identity (G10, T-23, T-24): the digest is recomputed from current
  order data at every transition that matters. Registering send evidence on an
  order whose data drifted (a changed line quantity, a new artwork revision)
  refuses the send, voids the snapshot and requires a fresh CEO approval — which
  re-freezes the current data under a new digest. Amounts and recipient are
  request-only parts and are frozen at creation, so only order-side data can
  void the paper.
- CEO approval (G8): only the `admin` role can approve; staff attempts get 403
  (T-31 pattern). Approval is the only exit from `DRAFT` and the only way back
  from `SNAPSHOT_VOIDED`, and it records a `CEO_APPROVED` event. The film supply
  order chain mirrors the maker PO whenever the mirror transition is legal there
  (exception states such as `CHANGE_REVIEW` are left untouched).
- Manual send (G9, T-21): registering send evidence (a `send_evidence` document
  bound to the order plus sender address, recipients, sent time and attachment
  hashes) is verified by the server against the order and the frozen recipient
  and moves the PO to `MAKER_PO_SENT_MANUALLY` as `VERIFIED`. Registering only a
  `sent_at` timestamp moves the PO to `SEND_UNVERIFIED` as `UNVERIFIED`, and
  `SEND_UNVERIFIED` has no outgoing transitions — a send nobody can prove blocks
  the paper. A rejected evidence (wrong type, foreign order or company, or
  recipients not covering the frozen address) is refused and recorded as a
  `SEND_REJECTED` event; a malformed request persists nothing.
- Acceptance (T-22): `MAKER_PO_ACCEPTED` is only reachable from
  `MAKER_PO_SENT_MANUALLY` and only behind an `acceptance_evidence` document of
  the same order and company that a human has verified
  (`ACCEPT_EVIDENCE_REGISTERED`, `VERIFIED`).
- Concurrency (T-25): every transition re-reads the PO row `FOR UPDATE` inside a
  transaction and writes it conditionally on the status it was read with, so two
  simultaneous transitions (two sends, or two approvals) result in exactly one
  effective transition and a consistent audit trail; the loser receives 422
  `MAKER_PO_STATE_CHANGED` (or `MAKER_PO_TRANSITION_BLOCKED`, depending on which
  state its locked read observed).
- Order-level evidence binding (design section 5.4): documents carry
  `project_id` and `film_supply_order_id`. Artwork-bound types (proof, approval
  evidence) additionally name the design (M3 pair), while send and acceptance
  evidence is about the whole maker paper and carries the order alone.

M4 endpoints (composite test data, assignment-scoped authorization):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/film-supply-orders/:orderId/maker-purchase-orders` | Freeze the maker paper (order must be at `MAKER_PO_READY`) |
| POST | `/api/maker-purchase-orders/:poId/ceo-approval` | CEO approves the snapshot digest (admin only) |
| POST | `/api/maker-purchase-orders/:poId/send-evidence` | Register manual-send evidence (verified) or a bare `sent_at` (unverified) |
| POST | `/api/maker-purchase-orders/:poId/accept-evidence` | Register verified acceptance evidence → `MAKER_PO_ACCEPTED` |
| GET | `/api/maker-purchase-orders/:poId` | Read one maker PO with its event log |
| GET | `/api/film-supply-orders/:orderId/maker-purchase-orders` | List the maker POs of an order |

Tests: `tests/m4/core-rules.test.ts` (snapshot canonicalization and digest
sensitivity, the state machine and its dead ends, send-evidence verification,
acceptance requirements) and `tests/m4/m4-maker-po.test.ts` (T-20 to T-25
against the API and database, including the 403 staff approval attempt,
append-only `maker_po_events` and same-transaction audit rows).

## M5 deliveries completion, receipt assumption and Japanese status surface

New tables (migration `0011_m5_receipt_assumption_and_delivery_confirmation`):
`delivery_confirmations` (append-only, migration `0012`), plus
`film_supply_orders.receipt_assumed_at / _by / _note` and the M5
`commission_readiness` columns (`film_delivery_confirmed`,
`filling_delivery_confirmed`, `readiness_state`).

- Manual receipt assumption (design sections 5.5, 6.1 and 13 item 1):
  `FILM_DELIVERED → FILM_RECEIPT_ASSUMED_NO_ISSUE` is a MANUAL recording action.
  Nothing schedules it — the waiting period is not decided by the CEO yet — so
  the only way in is the admin/staff endpoint with a required note and an
  explicit evidence-free acknowledgment (`acknowledgeNoEvidence: true`); the
  audit row is written in the same transaction. The state machine admits the
  transition from `FILM_DELIVERED` only (exception release targets exclude the
  terminal state), and the generic transition endpoint refuses the terminal
  state with 422 `RECEIPT_ASSUMPTION_ACTION_REQUIRED`.
- Delivery confirmation and commission gating (T-36): a recorded delivery row
  alone is never enough. It stays `PENDING_CONFIRMATION` until a *verified*
  `acceptance_evidence` document of the same company is bound to it (film
  deliveries additionally require the order binding), and commission readiness
  stays `MISSING_DATA` or `PENDING_VERIFICATION` while any delivery is
  unconfirmed. `READY` — the only state in which a commission may be calculated
  (`isCommissionCalculationAllowed`) — is reachable only through the explicit
  evaluate endpoint, which writes `commission_readiness` and one audit row and
  never side-effects on any other table.
- Japanese status surface (design section 8): every film supply order state and
  maker PO status carries exactly one Japanese label, defined once in
  `packages/core/src/status-labels.ts` and served verbatim by
  `GET /api/status-labels`; `apps/web` renders a server-rendered Japanese status
  list page (`/status`) from that endpoint.
- Audit history (design section 8 item 6): `GET
  /api/projects/:projectId/audit-history` lists audit events with before/after
  states, actor and time, optionally narrowed with `entityType`/`entityId`.
  `audit_events` has no project column, so the project boundary is enforced by
  resolving every row's entity back to its project at read time; authorization
  is `project:read`-grade (`audit_history:read` for viewers).

M5 endpoints (composite test data, assignment-scoped authorization):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/film-supply-orders/:orderId/receipt-assumption` | Record the manual receipt assumption (note + evidence-free acknowledgment required) |
| POST | `/api/film-deliveries/:deliveryId/confirmation` | Bind verified delivery evidence to a film delivery |
| POST | `/api/filling-deliveries/:deliveryId/confirmation` | Bind verified delivery evidence to a filling delivery |
| POST | `/api/projects/:projectId/commission-readiness` | Explicit evidence-gated readiness evaluation (M1 endpoint, M5 semantics) |
| GET | `/api/status-labels` | The Japanese status surface shared by API and web |
| GET | `/api/projects/:projectId/audit-history` | Read-only audit history for one project/order |

Tests: `tests/m5/core-rules.test.ts` (label completeness, receipt-assumption
gate, T-36 readiness rules, delivery-evidence binding) and
`tests/m5/m5-deliveries.test.ts` (T-36 against the API, evidence validation and
append-only confirmations, receipt assumption from `FILM_DELIVERED` only with
its same-transaction audit row, no scheduling, status-labels completeness,
audit-history access control and project scoping).
