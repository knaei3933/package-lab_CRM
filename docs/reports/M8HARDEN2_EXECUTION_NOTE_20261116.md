# M8-HARDEN2 — EML attachment matching · cancellation acknowledgement gate · manual-send confirmation flow

Worktree `agent/m8-harden2c`, base `ad8761b` (M8-HARDEN final report), commit
`db8ae95` — "feat: EML attachment matching, cancellation acknowledgement gate,
manual-send confirmation flow". Three CEO-approved fixes, no other features.

> **Verification status: NOT EXECUTED.** `npm test`, `npm run build` and
> `psql` are denied in this session (permission boundary), so the full suite,
> the web build and the DB integrity check could not be run here. The changes
> are hand-verified against the code and the existing tests (see §5). The
> commands to run, in order, are in §6 — **migration 0019 must be applied to
> the test DB before the suite runs**, otherwise every
> MAKER_CANCELLATION_ACKNOWLEDGED insert fails on the enum.

## 1. FIX 1 — the EML attachment match is the gate (C1, tightened)

**Before** (`packages/core/src/eml.ts`, `evaluateMakerPoEmlEvidence`): the
attachment hashes were recorded but *never blocked* — "recorded, never
blocking" was the documented contract, and the regression test pinned it
(`tests/m8-harden/m8-harden-core-rules.test.ts` "never lets a missing
attachment match block a genuine export"). Reproduction at `ad8761b`: an .eml
with correct headers and an attachment whose bytes match nothing approved came
back `VERIFIED`, moved the paper to MAKER_PO_SENT_MANUALLY and advanced the
order.

**After**: VERIFIED requires the core header checks **and** at least one
attachment whose sha256 is one of the approved artifact hashes the frozen
snapshot names (`snapshot.specs.artworkFiles[].fileSha256` — the approved PO /
artwork revision documents). A header-clean mail that cannot show that is
PENDING_MANUAL_VERIFICATION with a machine-readable reason on the event:

| case | pendingCode | human note (excerpt) |
| --- | --- | --- |
| no attachment, no link in the body | `attachment_missing` | 添付ファイルがないため…一致を確認できませんでした |
| attachments exist, none matches an approved hash | `attachment_hash_mismatch` | 添付ファイルが承認済み成果物…のハッシュと一致しませんでした |
| no attachment, body names a download URL | `attachment_link_only` | ダウンロードリンクのみが記載されているため… |

The gate is the **last** check in evaluation order, so a mail that also fails a
header still surfaces that header as its `pendingCode` (existing pending cases
keep their codes: EML_UNPARSABLE, EML_MESSAGE_ID_MISSING,
EML_RECIPIENT_MISMATCH, EML_SUBJECT_IDENTIFIER_MISSING,
SENT_AT_PRECEDES_CEO_APPROVAL, EML_DATE_SENT_AT_CONFLICT …). The check list
gains an `attachment_gate` row (`passed` / `failed` + detail) beside the
informational `attachment_hash` row. When the snapshot freezes no approved
hashes at all, nothing can match, so the mail stays pending too — the human
decides, never the header check.

**Legitimate conversion cases are not auto-verified**: a PDF re-export of the
approved PO is exactly the `attachment_hash_mismatch` case → manual
verification, never VERIFIED.

Changed: `packages/core/src/eml.ts` (body-text collection in the MIME walk,
`MakerPoAttachmentPendingCode`, the gate), `packages/core/src/maker-po.ts`
(contract comments), `tests/helpers/maker-po-evidence.ts` (bodyText override,
contract comment), `tests/m8-harden/m8-harden-core-rules.test.ts` (the old
"never blocks" test now asserts pending + reason; four new pure cases), and
every send fixture that relied on the attachment-optional VERIFIED now attaches
the approved artwork bytes (m4, m5, m7-security, m8-oper2, m8-oper3,
m8-operator, m8-fail).

## 2. FIX 2 — cancellation / re-order safety after a proven send

**Before**: any cancellable paper (DRAFT, APPROVED_FOR_MANUAL_SEND,
MAKER_PO_SENT_MANUALLY, SNAPSHOT_VOIDED) could be cancelled and the order
immediately accepted a new maker PO — including paper whose send the server had
just verified, i.e. mail the Korean maker may already be working from.

**After** the two cases are distinguished:

* `INTERNAL_CANCEL` — no verified send. Existing behavior unchanged: the same
  append-only `MAKER_PO_CANCELLED` event + audit rows, the order returns to
  MAKER_PO_READY, a new maker PO freezes immediately.
* `MAKER_PO_CANCELLED` (a VERIFIED send exists on the paper) — the **same**
  append-only events are recorded, the response names
  `cancellationKind: "MAKER_PO_CANCELLED"` and
  `newMakerPoRequiresCancellationAcknowledgement: true`, and the ordering step
  stays closed until the representative records the acknowledgement:
  `POST /api/maker-purchase-orders/:poId/cancellation-acknowledgement`
  (admin-only, same `maker_po:cancel` authority as the cancellation; body
  `note` required, optional `acknowledgedAt`, optional
  `evidenceDocumentVersionId` cited as accept-evidence style proof). It writes
  an append-only `MAKER_CANCELLATION_ACKNOWLEDGED` event on that exact paper +
  an audit row (`replacementAllowed: true`), and refuses a second one
  (`MAKER_CANCELLATION_ACK_ALREADY_RECORDED`).

Creating a maker PO for an order that still holds an unacknowledged
sent-and-cancelled paper is refused with **422
`MAKER_PO_CANCELLATION_ACK_REQUIRED`**, a Japanese message containing the
pending PO id, and `pendingMakerPurchaseOrderId`. That refusal is the proof of
the order-level invariant: while the acknowledgement is missing, the audit and
events show exactly one paper for the order (the cancelled one, trail intact)
and no second `MAKER_PO_CREATED` row. Also refused: acknowledging live paper
(`MAKER_PO_NOT_CANCELLED`) and acknowledging paper that was never sent
(`MAKER_PO_CANCELLATION_ACK_NOT_REQUIRED`).

Changed: `packages/core/src/maker-po.ts` (`classifyMakerPoCancellation`,
`evaluateMakerPoCancellationAckGate`, `MAKER_CANCELLATION_ACKNOWLEDGED`
vocabulary), `apps/api/src/app.ts` (classification in the cancel endpoint, the
acknowledgement endpoint, the create gate), `packages/db/src/schema.ts` +
`packages/db/drizzle/0019_m8_harden2_cancellation_acknowledgement.sql` (one
enum value).

## 3. FIX 3 — what happens after a PENDING_MANUAL_VERIFICATION send is confirmed

**Before**: the confirmed manual verification was recorded (append-only row +
audit) and nothing else — the paper stayed APPROVED_FOR_MANUAL_SEND, so
acceptance stayed unreachable forever for that path. Reproduction at
`ad8761b`: pending send → admin confirms → accept-evidence still 422.

**After** (`apps/api/src/app.ts`, `POST /api/maker-po-events/:eventId/send-manual-verification`):

* `result: "confirmed"` carries the paper to **MAKER_PO_SENT_MANUALLY** exactly
  as a VERIFIED send would have (guarded status update + `MAKER_PO_STATUS_CHANGED`
  audit row with `reason: send_manual_verification_confirmed`, plus the film
  order mirror and its audit row). The response reports
  `purchaseOrderStatusChanged: { from, to }`. Acceptance is then reachable with
  normal verified acceptance evidence — the same path a VERIFIED send opens.
* While the send is still PENDING, acceptance stays blocked
  (`MAKER_PO_TRANSITION_BLOCKED` from APPROVED_FOR_MANUAL_SEND) — the mirror of
  the SEND_UNVERIFIED block, asserted explicitly.
* `result: "rejected"` asserts no delivery and moves nothing
  (`purchaseOrderStatusChanged: null`); acceptance stays blocked.
* The move only happens through the legal state machine edge
  (`transitionMakerPurchaseOrder`): paper that moved on since the pending send
  (voided, cancelled, already sent, accepted) is left where it is.
* **Double-processing is refused, not idempotent** — following the existing
  0018 machinery: a second `confirmed` record for the same event is 422
  `MAKER_PO_SEND_ALREADY_CONFIRMED` (the table is append-only by trigger; a
  retraction is a new record, never an edit).
* **Re-send stays blocked** (M8-FAIL B holds): from MAKER_PO_SENT_MANUALLY the
  send endpoint refuses with `MAKER_PO_TRANSITION_BLOCKED`.
* **Delivery semantics** (documented in code and asserted in tests): nowhere
  does the EML header check claim an actual delivery. VERIFIED — and the
  confirmed manual verification — mean *email content + recipient verified*;
  the send endpoint answers `deliveryAssertedByManualVerification: false` and
  the VERIFIED audit row records `deliveryAsserted: not_asserted_by_this_event`;
  the delivery assertion is the representative's manual record alone
  (`deliveryAsserted: true` on the manual verification audit row). The send
  event itself keeps `PENDING_MANUAL_VERIFICATION` (append-only), and the
  human record lives in `maker_po_send_manual_verifications`.

## 4. Migration

`packages/db/drizzle/0019_m8_harden2_cancellation_acknowledgement.sql` — one
statement: `ALTER TYPE "maker_po_event_type" ADD VALUE IF NOT EXISTS
'MAKER_CANCELLATION_ACKNOWLEDGED';`. No column, table or constraint changes; no
existing row is rewritten. Mirrored in `packages/db/src/schema.ts` and in the
core vocabulary. **Not applied to the test DB here** (`psql` denied) — apply it
before running the suite.

## 5. What was verified without execution

* Cross-layer consistency of the new event value (migration ↔ schema ↔ core ↔
  API ↔ tests) — grep above.
* The M8-HARDEN B2 partial unique index
  (`maker_purchase_orders_active_order_unique`, `deleted_at IS NULL AND status
  <> 'CANCELLED'`) is untouched by this change set, so the 0018 state on the
  test DB remains the state the suite expects.
* Brace/paren balance and structure of every edited file (whole-file counts);
  each edited endpoint/transaction block re-read in full.
* Every existing test that asserted a VERIFIED send without an attachment was
  re-pointed at the approved-artwork attachment; every intentional negative
  case keeps its expected `pendingCode` (the gate is evaluated last, so none of
  them moved).
* The two flows the new gates touch in existing tests were followed through:
  m8-fail D1 (cancel of proven paper now records the acknowledgement before the
  replacement freezes) and the cancel-then-create B2 case (no verified send →
  unchanged).

## 6. Commands to run (in this order), and what to expect

```bash
psql "$DATABASE_URL" -f packages/db/drizzle/0019_m8_harden2_cancellation_acknowledgement.sql
npx vitest run            # expect 226 existing + 11 new = 237 passing
npm run typecheck
npm run build --workspace @kanei/web
# DB integrity on the test DB:
psql "$DATABASE_URL" -c "\di maker_purchase_orders_active_order_unique"
psql "$DATABASE_URL" -c "select e.event_type, count(*) from maker_po_events e group by 1;"
psql "$DATABASE_URL" -c "select count(*) from maker_po_events e left join maker_purchase_orders p on p.id = e.maker_purchase_order_id where p.id is null;"
psql "$DATABASE_URL" -c "select count(*) from audit_events a left join projects pr on pr.id = a.project_id where pr.id is null;"
```

## 6b. Second verification attempt (2026-11-16, worktree `agent/m8-ui2`)

The verification pass was re-attempted in a second session on this worktree and
hit the same permission boundary: `npm test`, `npm run build` and `psql` all
require an approval that session does not hold, so §6 remains **outstanding** —
migration 0019 is still not applied to the test DB and the suite/build/integrity
output still does not exist. Two facts worth carrying into that run:

* The drizzle journal (`packages/db/drizzle/meta/_journal.json`) ends at idx 17
  (0017). Both 0018 and 0019 sit outside it, so `drizzle-kit migrate` will skip
  them — apply 0019 (and confirm 0018) with `psql -f` exactly as §6 orders.
* The static re-verification of this session found no gap: the attachment gate
  is the last check in `evaluateMakerPoEmlEvidence`, the create gate reads
  cancelled papers before the insert transaction, the acknowledgement endpoint
  and the send-manual-verification endpoint behave as §2 and §3 describe, and
  every regression case §1–§3 names exists in
  `tests/m8-harden2/m8-harden2-hardening.test.ts`.

## 7. Remaining risks

1. **Unverified by execution** — the suite, the build and the integrity checks
   have not run here (see §0). Static reading is not a substitute for the run.
2. **The FIX 2 create gate is an application check**, read before the insert
   transaction (same shape as the existing active-paper pre-check). Two
   concurrent creates on an order with an unacknowledged sent-and-cancelled
   paper could both pass the read; the 0018 unique index still caps the order at
   one live paper, but the airtight form would be a BEFORE INSERT trigger that
   locks the order row and raises the same error. Deliberately not added here:
   it cannot be tested in this session.
3. `attachment_link_only` is detected by a URL in the message text. A mail that
   attaches nothing and mentions no URL reads `attachment_missing` — the
   decision a human makes either way; only the reason differs.
4. A mail whose snapshot froze no approved hashes at all can never verify
   automatically (documented in the gate). Today every maker PO snapshot freezes
   the approved artwork, so this only bites a snapshot built with no artwork.
5. The mixed-case `pendingCode` values (`attachment_*`) are spelled exactly as
   the brief names them; the pre-existing header codes stay UPPER_SNAKE.
