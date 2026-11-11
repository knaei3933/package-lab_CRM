# KANEI CRM MVP (M0 + M1)

Isolated M0 foundation with the M1 transaction structure. This repository intentionally does not connect to the legacy
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
