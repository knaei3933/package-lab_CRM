#!/usr/bin/env bash
#
# M8-OPER3 demo seeder for the CEO's manual browser check.
#
# Drives the RUNNING API — never a database connection — to build one demo F1
# order that sits exactly where the CEO wants to exercise the maker-PO boundary
# by hand:
#
#   demo project (three demo accounts) -> seven PO intake (official registered
#   + checklist verified) -> film supply order WITH paymentTerms
#   -> proof revision -> one TEXT approval_evidence approval (customer) + one
#   TEXT approval_evidence approval (seven) -> dual approval -> MAKER_PO_READY
#   -> maker purchase order created + CEO approved (APPROVED_FOR_MANUAL_SEND).
#
# What is left for the CEO to do by hand in the UI: send evidence (proven send)
# and the acceptance. The M8-OPER3 dual-approval re-check fires on the boundary
# the CEO reviews: maker-PO create, CEO approval, send evidence, acceptance.
#
# Idempotent re-runs: the demo project carries the FIXED code DEMO-OPER3 (an
# earlier version stamped the code with $(date), so every re-run minted a fresh
# project — the source of the five duplicate demo projects). Before creating
# anything the script lists GET /api/projects and, when a project with that
# code already exists, reuses its id and skips the whole build, so re-running
# never creates a second demo project. To rebuild the demo from scratch, first
# hard-delete the existing project row (projects.code is UNIQUE even for
# soft-deleted rows, so a soft delete leaves the code reserved and the next
# run fails loudly instead of duplicating). The reuse lookup runs before the
# account-id requirement so a plain re-run needs no environment at all.
#
# Run it against the server whose DATABASE_URL points at the database the demo
# belongs in (the script itself holds no credentials and writes only through
# the API):
#
#   npm run db:seed            # fresh database only: creates the demo accounts
#   npm run dev:api            # API on :3081
#   KANEI_DEMO_CUSTOMER_ACCOUNT_ID=<uuid> \
#   KANEI_DEMO_SEVEN_ACCOUNT_ID=<uuid> \
#   KANEI_DEMO_MAKER_ACCOUNT_ID=<uuid> \
#     bash crm-ops/reseed-demo-m8-oper3.sh
#
# List existing account ids (read-only):
#   psql "$DATABASE_URL" -c "select role, id from accounts where deleted_at is null and is_active order by created_at"
#
# Environment:
#   KANEI_API_BASE_URL            API the UI talks to (default http://127.0.0.1:3081)
#   KANEI_DEMO_USERNAME / KANEI_DEMO_PASSWORD   representative (admin) credentials;
#                                 default the composite seed account admin_composite
#   KANEI_DEMO_CUSTOMER_ACCOUNT_ID / KANEI_DEMO_SEVEN_ACCOUNT_ID /
#   KANEI_DEMO_MAKER_ACCOUNT_ID   the three demo accounts to build the project on
set -uo pipefail

API_BASE="${KANEI_API_BASE_URL:-http://127.0.0.1:3081}"
# Fixed demo project code — the idempotency key for re-runs (never stamp it).
DEMO_PROJECT_CODE="DEMO-OPER3"
USERNAME="${KANEI_DEMO_USERNAME:-admin_composite}"
PASSWORD="${KANEI_DEMO_PASSWORD:-composite-admin-pass}"
CUSTOMER_ACCOUNT_ID="${KANEI_DEMO_CUSTOMER_ACCOUNT_ID:-}"
SEVEN_ACCOUNT_ID="${KANEI_DEMO_SEVEN_ACCOUNT_ID:-}"
MAKER_ACCOUNT_ID="${KANEI_DEMO_MAKER_ACCOUNT_ID:-}"

BODY="$(mktemp)"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$BODY" "$COOKIE_JAR"' EXIT

PASSED=0
FAILED=0
STAMP="$(date +%Y%m%d%H%M%S)-$$"
EVENT_TIME="$(date -u +%Y-%m-%dT%H:%M:%S)"
PAYMENT_TERMS="${KANEI_DEMO_PAYMENT_TERMS:-prepaid}"

step() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASSED=$((PASSED + 1))
    printf 'ok   %-58s %s\n' "$label" "$actual"
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL %-58s expected %s, got %s\n' "$label" "$expected" "$actual"
    sed -n '1,3p' "$BODY" | sed 's/^/       body: /'
  fi
}

# call METHOD PATH [json-body] — leaves STATUS and BODY set.
call() {
  local method="$1" path="$2" payload="${3:-}"
  local args=(-s -X "$method" -o "$BODY" -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR"
    -H 'content-type: application/json')
  [ -n "$payload" ] && args+=(-d "$payload")
  STATUS="$(curl "${args[@]}" "$API_BASE$path")"
}

# extract REGEX FIELD — first match of a "key":"value" pattern in the last body.
extract() {
  grep -oE "$1" "$BODY" | head -n 1 | cut -d'"' -f"$2"
}

require_id() {
  local label="$1" value="$2"
  if [ -n "$value" ]; then
    PASSED=$((PASSED + 1))
    printf 'ok   %-58s %s\n' "$label" "$value"
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL %-58s id not found in response\n' "$label"
  fi
}

base64_content() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

echo "KANEI M8-OPER3 demo seed — API: $API_BASE / paymentTerms: $PAYMENT_TERMS"

# ---------------------------------------------------------------- session
call GET /api/health
step "GET /api/health" 200 "$STATUS"

call POST /api/auth/login "$(printf '{"username":"%s","password":"%s"}' "$USERNAME" "$PASSWORD")"
step "POST /api/auth/login ($USERNAME)" 201 "$STATUS"

# ------------------------------------------------- reuse existing demo project
# The list endpoint answers compact JSON {"projects":[{"id":"…","code":"…"}]}
# with id before code; the grep relies on that key order. If the order ever
# changes, EXISTING_PROJECT_ID stays empty and the create below fails on the
# reserved unique code — it fails loudly instead of duplicating.
call GET /api/projects
step "GET /api/projects (demo project lookup)" 200 "$STATUS"
EXISTING_PROJECT_ID="$(grep -oE "\"id\":\"[0-9a-f-]{36}\",\"code\":\"$DEMO_PROJECT_CODE\"" "$BODY" | head -n 1 | cut -d'"' -f4)"

if [ -n "$EXISTING_PROJECT_ID" ]; then
  PASSED=$((PASSED + 1))
  printf 'ok   %-58s %s\n' "existing demo project (code $DEMO_PROJECT_CODE) reuse" "$EXISTING_PROJECT_ID"

  # D2: the project row alone does not prove the demo is complete — a previous
  # run that failed midway leaves the project with no (or an unapproved) maker
  # PO, and a plain reuse would report ok on a half-built demo. The build's
  # final artifact is a maker PO the CEO approved, so the reuse path requires
  # one maker PO of this project at APPROVED_FOR_MANUAL_SEND or a later live
  # status (the CEO's own manual send/acceptance moves it forward). The maker PO
  # ids come from the project's audit history (there is no project-level list
  # endpoint); the current status comes from GET /api/maker-purchase-orders/:id.
  # The audit answer is oldest-first and capped at 500 rows; a demo project
  # holds a handful of maker-PO events, far below the cap.
  call GET "/api/projects/$EXISTING_PROJECT_ID/audit-history?entityType=maker_purchase_order&limit=500"
  step "GET audit-history (demo maker PO lookup)" 200 "$STATUS"
  if [ "$STATUS" != "200" ]; then
    # Auth, permission or network trouble — not proof of an incomplete demo, so
    # never steer toward the destructive rebuild here.
    echo
    echo "デモ案件の完了確認ができませんでした（audit-history HTTP $STATUS）。"
    echo "  認証・権限・API接続を確認してから再実行してください。案件は削除しないでください。"
    echo
    echo "steps passed: $PASSED / failed: $FAILED"
    exit 1
  fi
  COMPLETE_MAKER_PO_ID=""
  COMPLETE_MAKER_PO_STATUS=""
  for CANDIDATE_PO_ID in $(grep -oE '"entityId":"[0-9a-f-]{36}"' "$BODY" | cut -d'"' -f4 | sort -u); do
    call GET "/api/maker-purchase-orders/$CANDIDATE_PO_ID"
    [ "$STATUS" = "200" ] || continue
    # Read the status inside purchaseOrder only: cut the answer at the events
    # array so an event's status can never be taken for the PO's.
    CANDIDATE_STATUS="$(sed 's/"events":.*//' "$BODY" | grep -oE '"status":"[A-Z_]+"' | head -n 1 | cut -d'"' -f4)"
    case "$CANDIDATE_STATUS" in
      APPROVED_FOR_MANUAL_SEND|SEND_UNVERIFIED|MAKER_PO_SENT_MANUALLY|MAKER_PO_ACCEPTED)
        COMPLETE_MAKER_PO_ID="$CANDIDATE_PO_ID"
        COMPLETE_MAKER_PO_STATUS="$CANDIDATE_STATUS"
        break
        ;;
    esac
  done
  if [ -z "$COMPLETE_MAKER_PO_ID" ]; then
    FAILED=$((FAILED + 1))
    printf 'FAIL %-58s %s\n' "existing demo is complete (CEO-approved maker PO)" "not found"
    echo
    echo "既存のデモ案件 (code $DEMO_PROJECT_CODE) は不完全です — 前回の実行が途中で失敗した可能性があります。"
    echo "  CEO承認済みのメーカー発注書がありません。このままではブラウザ確認に使えません。"
    echo "  再構築: 既存の案件行（id $EXISTING_PROJECT_ID）を物理削除してから再実行してください。"
    echo
    echo "steps passed: $PASSED / failed: $FAILED"
    exit 1
  fi
  PASSED=$((PASSED + 1))
  printf 'ok   %-58s %s\n' "existing demo is complete (maker PO $COMPLETE_MAKER_PO_STATUS)" "$COMPLETE_MAKER_PO_ID"
  echo
  echo "既存のデモ案件 (code $DEMO_PROJECT_CODE) を再利用 — 新しいデータは作成しません（冪等再実行）。"
  echo "  再構築したい場合は既存の案件行を物理削除してから再実行してください。"
  echo
  echo "  project id : $EXISTING_PROJECT_ID"
  echo "  maker PO id: $COMPLETE_MAKER_PO_ID ($COMPLETE_MAKER_PO_STATUS)"
  echo
  echo "steps passed: $PASSED / failed: $FAILED"
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

# Creation path: the three demo account ids are required from here on.
if [ -z "$CUSTOMER_ACCOUNT_ID" ] || [ -z "$SEVEN_ACCOUNT_ID" ] || [ -z "$MAKER_ACCOUNT_ID" ]; then
  echo "使い方: KANEI_DEMO_CUSTOMER_ACCOUNT_ID / KANEI_DEMO_SEVEN_ACCOUNT_ID / KANEI_DEMO_MAKER_ACCOUNT_ID を指定してください"
  echo "  既存IDの一覧: psql \"\$DATABASE_URL\" -c \"select role, id from accounts where deleted_at is null and is_active order by created_at\""
  echo "  空のデータベースなら先に npm run db:seed （COMP-CUST-001 / COMP-SEVEN-001 / COMP-MAKER-001 を作成）"
  echo "  既存のデモ案件があれば上の再利用チェックで抜けるため、環境変数なしの再実行は安全です。"
  exit 2
fi

# The representative (admin) may drive every step; no project assignment is
# needed, so the demo project stays self-contained.
call POST /api/projects "$(printf '{"code":"%s","name":"デモOPER3案件（CEO確認用）","route":"F1","endCustomerAccountId":"%s","sevenAccountId":"%s","makerAccountId":"%s"}' "$DEMO_PROJECT_CODE" "$CUSTOMER_ACCOUNT_ID" "$SEVEN_ACCOUNT_ID" "$MAKER_ACCOUNT_ID")"
step "POST /api/projects (demo project)" 201 "$STATUS"
PROJECT_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "demo project id" "$PROJECT_ID"

# ------------------------------------------------- seven purchase order
call POST "/api/projects/$PROJECT_ID/seven-purchase-orders" \
  "$(printf '{"poNumber":"DEMO-OPER3-PO-%s","officialRegisteredAt":"%s"}' "$STAMP" "$EVENT_TIME")"
step "POST /api/projects/:id/seven-purchase-orders" 201 "$STATUS"
PO_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "seven purchase order id" "$PO_ID"

CHECKLIST='{"issuerNameRecorded":true,"issuerName":"デモセブン化学事業","documentNumberRecorded":true,"documentNumber":"DEMO-PO-1",'
CHECKLIST="${CHECKLIST}\"issueDateRecorded\":true,\"issueDate\":\"$(date -u +%Y-%m-%d)\",\"sendingChannelRecorded\":true,"
CHECKLIST="${CHECKLIST}\"sendingChannel\":\"専用ポータル\",\"pastTransactionCompared\":true,\"pastTransactionNote\":\"過去3件と様式一致\","
CHECKLIST="${CHECKLIST}\"quoteCompared\":true,\"quoteMatchesPo\":true,\"quoteComparisonNote\":\"見積と一致\",\"uncertain\":false,"
CHECKLIST="${CHECKLIST}\"confirmationReplyRecorded\":false,\"verificationNote\":\"デモチェックリスト\"}"
call POST "/api/seven-purchase-orders/$PO_ID/verification-checklist" "$CHECKLIST"
step "POST /api/seven-purchase-orders/:id/verification-checklist" 200 "$STATUS"

# ------------------------------------------------------ film supply order
# The seven-PO-linked creation path carries the G6 transaction terms: the CEO
# approval later needs the payment gate open, so the demo records them here.
SUPPLY_PAYLOAD="$(printf '{"code":"DEMO-OPER3-FSO-%s","paymentTerms":"%s","lines":[{"lineNumber":1,"description":"包装フィルム 1000mm","orderedQuantity":5000,"unit":"meters"}]}' "$STAMP" "$PAYMENT_TERMS")"
call POST "/api/seven-purchase-orders/$PO_ID/supply-orders" "$SUPPLY_PAYLOAD"
step "POST /api/seven-purchase-orders/:id/supply-orders (paymentTerms)" 201 "$STATUS"
ORDER_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "film supply order id" "$ORDER_ID"

# P4 H4①: the CEO approval requires 希望納期 (and 金額, set on the maker PO
# below). The demo records a synthetic date right after creating the order.
call PATCH "/api/film-supply-orders/$ORDER_ID/delivery-dates" '{"requestedDeliveryDate":"2027-03-31"}'
step "PATCH /api/film-supply-orders/:id/delivery-dates (希望納期)" 200 "$STATUS"

# P1 R23: SEVEN_PO_VERIFIED (on creation against the verified seven PO),
# PROOF_READY / APPROVAL_PENDING (on the proof revision) and MAKER_PO_READY
# (on the dual approval) are automatic steps the API refuses to take by hand
# (AUTO_TRANSITION_ONLY / INVALID_TRANSITION). Only デザインデータ受領 is a human
# record.
call POST "/api/film-supply-orders/$ORDER_ID/transitions" '{"to":"ARTWORK_RECEIVED"}'
step "transition → ARTWORK_RECEIVED" 200 "$STATUS"

# ------------------------------------------------- proof + artwork revision
PROOF_PAYLOAD="$(printf '{"documentType":"proof","issuerEntity":"maker","filename":"demo-proof-%s.txt","contentType":"text/plain","designKey":"label-front","filmSupplyOrderId":"%s","sevenPurchaseOrderId":"%s","contentBase64":"%s"}' "$STAMP" "$ORDER_ID" "$PO_ID" "$(base64_content "demo proof label-front rev1 $STAMP")")"
call POST "/api/projects/$PROJECT_ID/documents" "$PROOF_PAYLOAD"
step "POST /api/projects/:id/documents (proof)" 201 "$STATUS"
PROOF_DOCUMENT_ID="$(extract '"document":{"id":"[0-9a-f-]{36}"' 6)"
PROOF_VERSION_ID="$(extract '"version":{"id":"[0-9a-f-]{36}"' 6)"
if [ -z "$PROOF_VERSION_ID" ]; then PROOF_VERSION_ID="$PROOF_DOCUMENT_ID"; fi
require_id "proof version id" "$PROOF_VERSION_ID"

call POST "/api/film-supply-orders/$ORDER_ID/artwork-revisions" \
  "{\"designKey\":\"label-front\",\"fileDocumentVersionId\":\"$PROOF_VERSION_ID\"}"
step "POST /api/film-supply-orders/:id/artwork-revisions" 201 "$STATUS"
REVISION_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "artwork revision id" "$REVISION_ID"

# ----------------------------------------------------------- dual approval
# Two TEXT approval_evidence files, one per organization, each quoting its own
# identifier: text-like evidence auto-verifies the identifier, so both approvals
# count immediately and the order closes the dual approval.
record_text_approval() {
  local organization="$1" issuer="$2"
  local identifier="DEMO-MSG-${organization^^}-$STAMP"
  local payload
  payload="$(printf '{"documentType":"approval_evidence","issuerEntity":"%s","filename":"demo-approval-%s-%s.txt","contentType":"text/plain","designKey":"label-front","filmSupplyOrderId":"%s","sevenPurchaseOrderId":"%s","contentBase64":"%s"}' "$issuer" "$organization" "$STAMP" "$ORDER_ID" "$PO_ID" "$(base64_content "demo approval evidence ($organization)
identifier: $identifier")")"
  call POST "/api/projects/$PROJECT_ID/documents" "$payload"
  step "POST /api/projects/:id/documents (approval_evidence $organization)" 201 "$STATUS"
  local version_id
  version_id="$(extract '"version":{"id":"[0-9a-f-]{36}"' 6)"

  call POST "/api/artwork-revisions/$REVISION_ID/approvals" \
    "$(printf '{"organization":"%s","decision":"APPROVE","evidenceSource":"email","eventTime":"%s","evidenceIdentifier":"%s","evidenceDocumentVersionId":"%s"}' "$organization" "$EVENT_TIME" "$identifier" "$version_id")"
  step "POST approval (TEXT, $organization)" 201 "$STATUS"
}

record_text_approval customer customer_generated
record_text_approval seven seven

call GET "/api/film-supply-orders/$ORDER_ID/approval-gate"
step "GET /api/film-supply-orders/:id/approval-gate" 200 "$STATUS"

# -------------------------------------------------- maker purchase order
call POST "/api/film-supply-orders/$ORDER_ID/maker-purchase-orders" \
  '{"recipientAddress":"demo-maker@example.com","amounts":{"currency":"JPY","totalAmount":"480000"}}'
step "POST maker-purchase-orders (dual-approval re-check)" 201 "$STATUS"
MAKER_PO_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "maker purchase order id" "$MAKER_PO_ID"

# P1 integration: the approval pins the snapshot hash the approval card shows;
# P4 H4①: the card's blockers list AMOUNT_REQUIRED / DELIVERY_DATE_REQUIRED when
# 金額 or 希望納期 is missing (both are set above).
call GET "/api/maker-purchase-orders/$MAKER_PO_ID/approval-card"
step "GET maker-PO approval-card" 200 "$STATUS"
APPROVAL_SNAPSHOT_SHA256="$(extract '"approvalSnapshotSha256":"[0-9a-f]{64}"' 4)"
require_id "approval snapshot sha256" "$APPROVAL_SNAPSHOT_SHA256"

call POST "/api/maker-purchase-orders/$MAKER_PO_ID/ceo-approval" \
  "$(printf '{"expectedPaymentTerms":"%s","expectedSnapshotSha256":"%s"}' "$PAYMENT_TERMS" "$APPROVAL_SNAPSHOT_SHA256")"
step "POST maker-PO ceo-approval (dual-approval re-check)" 200 "$STATUS"

# ----------------------------------------------------------------- summary
echo
echo "デモデータの作成結果（CEOがブラウザで確認する用）"
echo "  project id : $PROJECT_ID"
echo "  order id   : $ORDER_ID"
echo "  maker PO id: $MAKER_PO_ID"
echo
echo "ブラウザで localhost:3000 を開き、上記 project の maker 発注書から"
echo "送信証跡（proven send）と受領（acceptance）を手動で記録して確認できます。"
echo "二重承認が取り消された場合の挙動は、REVOKE を記録した後で同じ画面を操作して"
echo "DUAL_APPROVAL_NO_LONGER_VALID（422）を確認してください。"
echo
echo "steps passed: $PASSED / failed: $FAILED"
[ "$FAILED" -eq 0 ] || exit 1
