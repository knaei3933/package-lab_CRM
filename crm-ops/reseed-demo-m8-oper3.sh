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

if [ -z "$CUSTOMER_ACCOUNT_ID" ] || [ -z "$SEVEN_ACCOUNT_ID" ] || [ -z "$MAKER_ACCOUNT_ID" ]; then
  echo "使い方: KANEI_DEMO_CUSTOMER_ACCOUNT_ID / KANEI_DEMO_SEVEN_ACCOUNT_ID / KANEI_DEMO_MAKER_ACCOUNT_ID を指定してください"
  echo "  既存IDの一覧: psql \"\$DATABASE_URL\" -c \"select role, id from accounts where deleted_at is null and is_active order by created_at\""
  echo "  空のデータベースなら先に npm run db:seed （COMP-CUST-001 / COMP-SEVEN-001 / COMP-MAKER-001 を作成）"
  exit 2
fi

echo "KANEI M8-OPER3 demo seed — API: $API_BASE / paymentTerms: $PAYMENT_TERMS"

# ---------------------------------------------------------------- session
call GET /api/health
step "GET /api/health" 200 "$STATUS"

call POST /api/auth/login "$(printf '{"username":"%s","password":"%s"}' "$USERNAME" "$PASSWORD")"
step "POST /api/auth/login ($USERNAME)" 201 "$STATUS"

# The representative (admin) may drive every step; no project assignment is
# needed, so the demo project stays self-contained.
call POST /api/projects "$(printf '{"code":"DEMO-OPER3-%s","name":"デモOPER3案件（CEO確認用）","route":"F1","endCustomerAccountId":"%s","sevenAccountId":"%s","makerAccountId":"%s"}' "$STAMP" "$CUSTOMER_ACCOUNT_ID" "$SEVEN_ACCOUNT_ID" "$MAKER_ACCOUNT_ID")"
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

for NEXT_STATE in SEVEN_PO_VERIFIED ARTWORK_RECEIVED PROOF_READY APPROVAL_PENDING; do
  call POST "/api/film-supply-orders/$ORDER_ID/transitions" "{\"to\":\"$NEXT_STATE\"}"
  step "transition → $NEXT_STATE" 200 "$STATUS"
done

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
call POST "/api/film-supply-orders/$ORDER_ID/transitions" '{"to":"MAKER_PO_READY"}'
step "transition → MAKER_PO_READY" 200 "$STATUS"

call POST "/api/film-supply-orders/$ORDER_ID/maker-purchase-orders" \
  '{"recipientAddress":"demo-maker@example.com","amounts":{"currency":"JPY","totalAmount":"480000"}}'
step "POST maker-purchase-orders (dual-approval re-check)" 201 "$STATUS"
MAKER_PO_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "maker purchase order id" "$MAKER_PO_ID"

call POST "/api/maker-purchase-orders/$MAKER_PO_ID/ceo-approval" '{}'
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
