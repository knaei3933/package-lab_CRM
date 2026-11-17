# Evidence identifier input standard (adopted) — 2026-11-17

HANDOFF §5 items 2 and 3. Status: adopted on 2026-11-18 (대표 확정 11-18).
Sanitized: this file contains counts, shapes and rules only. The full analysis with
real values stays outside the repository.

## 1. Sample and method

- 127 real mails exchanged with the Seven Chemical production office (raw EML, read only).
  No mail server connection, no sending, no DB writes.
- Classified into 53 threads. Kinds: purchase orders 11 mails, proof completion /
  approval 4, quotes 6, bounces 23, other 83.
- 25 PDF attachments: 12 have a text layer, 13 are scan images only.
  **Every Seven Chemical purchase order and proof instruction PDF is a copier scan
  (single full-page JPEG, zero extractable text).** PDFs issued by our own side
  (quotes, delivery notes, specifications) have a text layer.
- The real CRM checks (`parseEml`, `evaluateMakerPoEmlEvidence`,
  `evaluateApprovalEvidenceIdentifierForBytes`) were called as pure functions on all
  127 mails (parse) and 4 representative mails (evaluation). Temporary script deleted.

## 2. Measured identifiers

| Identifier | What was observed |
|---|---|
| Message-ID, customer mail system | `<51 chars of [A-Za-z0-9+=_-]@mail host>`; mixed case; unique in all 52 mails |
| Message-ID, our mail server | `<UUIDv4@own domain>`; unique in all 46 mails |
| Message-ID, bounce | `<14 digit timestamp.hex@server host>`; no In-Reply-To |
| Uniqueness | 127 mails, 127 distinct Message-IDs, 0 duplicates |
| Stability on reply / resend | A reply or a resend always gets a new Message-ID. The parent's Message-ID appears as text in the reply's In-Reply-To and References (87 of 87 replies). A resent mail keeps the same attachment sha256 |
| Threading headers | 87 replies carry In-Reply-To, all also in References; 2 "Re:" mails carry none |
| Subject codes | Seven purchase order and proof mails: none. Our own forward of a customer order: a code of the shape two letters + two digit year + two letter class + four digits. Quote request tag: a bracket tag plus a date suffix |
| PDF number, Seven purchase order | A six digit order number printed on the page — visible only as an image, not machine readable |
| PDF number, our quote / delivery note | Six digit running number in the text layer, not in the subject |
| PDF number, specification | A management number with a fixed hyphenated shape, in text layer, subject and file name |
| Subject code vs PDF number | One real case where the two disagree in the class letters |
| Attachment sha256 | Stable for the same file; the same signature image recurs on many mails, so a hash match alone can mean only "has the signature logo" |
| Approval wording | The proof approval is body text only, with no attachment; the correction instruction mail carries a scanned PDF |

## 3. Proposed rule per evidence kind

| Evidence kind | Identifier to enter | Reliable? | Verification |
|---|---|---|---|
| Approval / confirmation mail (text only) | The mail's own Message-ID, copied by the system from the stored EML (never typed) | Yes | Automatic, header equality |
| Mail carrying the approved document | Message-ID of that mail + sha256 of the attachment | Yes | Automatic (existing attachment gate) |
| Seven purchase order PDF (scan) | Order number read by a person from the page | No | Manual verification record, status stays pending; sha256 is stored as a tamper check only |
| Proof instruction PDF (scan) | None exists | No | Manual verification; the Message-ID of the carrying mail identifies the event |
| Our own text-layer documents (quote, delivery note, specification) | The printed issue / management number | Yes | Automatic against the PDF text layer |
| Bounce mail | Not an evidence kind | — | Reject as evidence; use only as a send-failure signal |

Rules:
1. For any mail, Message-ID is the identifier and the stored EML is the evidence.
   The identifier must equal the value of the evidence's own `Message-ID` header, not
   merely occur somewhere in the file.
2. For a scanned PDF no identifier is machine verifiable. Record `pending_manual_verification`
   with the hash; never count it toward the dual approval until a person confirms.
3. For a text-layer PDF, the issue number must occur in the extracted text.
4. A resend is a new event: same hash, new Message-ID. Duplicate detection should key on
   (organization, Message-ID), not on the attachment hash alone.
5. The CRM order code should be put in the subject by the operator at send time,
   otherwise the subject check fails for every real mail.

## 4. Code gaps found against the real samples

| # | Where | Gap | Effect on real samples |
|---|---|---|---|
| G1 | `approvals.ts` `isTextLikeEvidence` | Only `text/` counts as text. `message/rfc822`, which is an accepted upload type, is treated as binary | A genuine EML uploaded as approval evidence is always `pending_manual_verification` (4 of 4) even though its Message-ID is machine verifiable | **Status: FIXED in df051a4** (G1: `message/rfc822` is parsed as an email; an unparsable payload stays pending).
| G2 | `approvals.ts` `evaluateApprovalEvidenceIdentifier` | Raw substring match over the whole file | Reply mails quote the parent's Message-ID in two headers, so the parent's ID would be accepted as `verified_in_document` for the reply. Inferred from the code and the 87/87 header finding, not executed as an exploit | **Status: FIXED in df051a4** (an EML identifier must equal the mail's own Message-ID, brackets and domain case normalized; quoted text, In-Reply-To, References and partial ids are refused).
| G3 | `maker-po.ts` subject check | Case-insensitive substring of order code / Seven PO number | No real outbound mail carries either, so real sends would stay pending (reproduced). A short generic code would pass trivially | **Status: IMPLEMENTED 2026-11-18 (대표 확정 11-18)** (the send-record form now derives a copy-ready subject with the frozen order code first; the stored EML and strict `maker-po.ts` header check remain unchanged).
| G4 | `eml.ts` `collectAttachments` | Inline images inside a related multipart are not collected (5 parts in 4 of 127 mails); cause not isolated | PDFs unaffected (25 of 25 found); hash list incomplete for mails with inline images | **Status: FIXED in df051a4** (inline parts of multipart/related and parts with a Content-ID are collected with their sha256).
| G5 | maker PO, scanned order PDF | No machine path to the printed order number | Only a hash and manual confirmation are possible | **Status: KEPT AS DECIDED 2026-11-18 (대표 확정 11-18)** (scans remain on the human/manual path; sha256 remains the tamper check).
| G6 | web/API input | Identifier is a free-text field with an 8 character minimum | Long mixed-case Message-IDs invite copy errors; the system should extract it from the EML | **Status: IMPLEMENTED 2026-11-18 (대표 확정 11-18)** (the server extracts a valid stored EML's own Message-ID; the approval form auto-fills it read-only, and the server replaces client input on the approval event. The 8-character manual rule remains only for non-EML evidence).
| G7 | order code vs document number | No cross check between subject code and the number inside the PDF | A real case exists where they differ | **Status: IMPLEMENTED 2026-11-18 (대표 확정 11-18)** (when a matched PDF has a readable text layer that does not contain the frozen order code, verification becomes `PENDING_MANUAL_VERIFICATION` with the Japanese コード不一致 warning; a text-free scan remains on the G5 manual path).

## 5. Decision requested

1. Adopt the rule table above (Message-ID for mail, issue number for own text PDFs,
   manual verification for scanned PDFs).
2. Order of fixes: G1/G2/G4 are complete; G3/G6/G7 were implemented on 2026-11-18 after
  the representative adopted the rule table.
