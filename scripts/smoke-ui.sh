#!/usr/bin/env bash
#
# M6 operator UI smoke check (Playwright-free).
#
# Walks the same F1 flow the browser UI drives, against the API the UI talks
# to (KANEI_API_BASE_URL, default http://127.0.0.1:3081), and asserts the
# expected status codes only:
#
#   login -> seven PO intake (create / official registration / checklist)
#         -> film supply order + line -> transition to SEVEN_PO_VERIFIED
#         -> upload proof -> verify -> register artwork revision
#         -> transition to APPROVAL_PENDING -> upload approval evidence
#         -> customer approval -> seven approval (same evidence version)
#         -> film delivery + upload/verify acceptance evidence + confirmation
#         -> filling order + delivery + confirmation
#         -> commission readiness (READY) -> logout
#
# The API is project-scoped and has no project list endpoint, so the project
# has to be named: pass it as the first argument or set KANEI_SMOKE_PROJECT_ID
# (the seeded project id, e.g. from `npm run db:seed` output or a direct query
# of the projects table).
#
# Usage: bash scripts/smoke-ui.sh [projectId]
#   KANEI_API_BASE_URL   API base the UI talks to (default http://127.0.0.1:3081)
#   KANEI_SMOKE_USERNAME / KANEI_SMOKE_PASSWORD   operator credentials (default
#                        the composite seed user admin_composite)
set -uo pipefail

API_BASE="${KANEI_API_BASE_URL:-http://127.0.0.1:3081}"
USERNAME="${KANEI_SMOKE_USERNAME:-admin_composite}"
PASSWORD="${KANEI_SMOKE_PASSWORD:-composite-admin-pass}"
PROJECT_ID="${1:-${KANEI_SMOKE_PROJECT_ID:-}}"

BODY="$(mktemp)"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$BODY" "$COOKIE_JAR"' EXIT

PASSED=0
FAILED=0
STAMP="$(date +%Y%m%d%H%M%S)-$$"
EVENT_TIME="$(date -u +%Y-%m-%dT%H:%M:%S)"

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
# FIELD is the 1-based position of the value when the match is split on quotes:
#   "id":"<uuid>"            -> 4
#   "document":{"id":"<uuid>"} -> 6
extract() {
  grep -oE "$1" "$BODY" | head -n 1 | cut -d'"' -f"$2"
}

# require_id LABEL VALUE — a missing id fails this run and its steps.
require_id() {
  local label="$1" value="$2"
  if [ -n "$value" ]; then
    PASSED=$((PASSED + 1))
    printf 'ok   %-58s %s\n' "$label" "${value:0:13}…"
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL %-58s id not found in response\n' "$label"
  fi
}

# boolean_check LABEL — expects the last body to contain "…":true.
boolean_check() {
  local label="$1"
  if grep -q '":true' "$BODY"; then
    PASSED=$((PASSED + 1))
    printf 'ok   %-58s true\n' "$label"
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL %-58s expected true in body\n' "$label"
    sed -n '1,3p' "$BODY" | sed 's/^/       body: /'
  fi
}

base64_content() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

if [ -z "$PROJECT_ID" ]; then
  echo "使い方: scripts/smoke-ui.sh <案件ID>"
  echo "  環境変数 KANEI_SMOKE_PROJECT_ID でも指定できます（APIには案件一覧の取得がないためです）。"
  exit 2
fi

echo "KANEI operator UI smoke — API: $API_BASE / project: $PROJECT_ID"

# ---------------------------------------------------------------- session
call GET /api/health
step "GET /api/health" 200 "$STATUS"

call POST /api/auth/login "$(printf '{"username":"%s","password":"%s"}' "$USERNAME" "$PASSWORD")"
step "POST /api/auth/login" 201 "$STATUS"

call GET /api/me
step "GET /api/me (session cookie)" 200 "$STATUS"

call GET /api/status-labels
step "GET /api/status-labels" 200 "$STATUS"

call GET "/api/projects/$PROJECT_ID"
step "GET /api/projects/:projectId" 200 "$STATUS"

# ------------------------------------------------- seven purchase order
call POST "/api/projects/$PROJECT_ID/seven-purchase-orders" \
  "$(printf '{"poNumber":"SMOKE-PO-%s"}' "$STAMP")"
step "POST /api/projects/:id/seven-purchase-orders" 201 "$STATUS"
PO_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "seven purchase order id" "$PO_ID"

call POST "/api/seven-purchase-orders/$PO_ID/register-official" \
  "{\"officialRegisteredAt\":\"$EVENT_TIME\"}"
step "POST /api/seven-purchase-orders/:id/register-official" 200 "$STATUS"

CHECKLIST='{"issuerNameRecorded":true,"issuerName":"SMOKE SEVEN","documentNumberRecorded":true,"documentNumber":"SMOKE-1",'
CHECKLIST="${CHECKLIST}\"issueDateRecorded\":true,\"issueDate\":\"$(date -u +%Y-%m-%d)\",\"sendingChannelRecorded\":true,"
CHECKLIST="${CHECKLIST}\"sendingChannel\":\"mail\",\"pastTransactionCompared\":true,\"pastTransactionNote\":\"ok\","
CHECKLIST="${CHECKLIST}\"quoteCompared\":true,\"quoteMatchesPo\":true,\"quoteComparisonNote\":\"ok\",\"uncertain\":false,"
CHECKLIST="${CHECKLIST}\"confirmationReplyRecorded\":false,\"verificationNote\":\"smoke\"}"
call POST "/api/seven-purchase-orders/$PO_ID/verification-checklist" "$CHECKLIST"
step "POST /api/seven-purchase-orders/:id/verification-checklist" 200 "$STATUS"

# ------------------------------------------------------ film supply order
# The order must carry the seven purchase order from intake: the
# SEVEN_PO_VERIFIED transition reads it (SEVEN_PO_REQUIRED otherwise).
call POST "/api/projects/$PROJECT_ID/film-supply-orders" \
  "$(printf '{"code":"SMOKE-FSO-%s","sevenPurchaseOrderId":"%s","lines":[]}' "$STAMP" "$PO_ID")"
step "POST /api/projects/:id/film-supply-orders" 201 "$STATUS"
ORDER_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "film supply order id" "$ORDER_ID"

call POST "/api/film-supply-orders/$ORDER_ID/lines" \
  '{"lineNumber":1,"description":"包装フィルム 1000mm","orderedQuantity":500,"unit":"meters"}'
step "POST /api/film-supply-orders/:id/lines" 201 "$STATUS"
LINE_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "film supply order line id" "$LINE_ID"

call POST "/api/film-supply-orders/$ORDER_ID/transitions" '{"to":"SEVEN_PO_VERIFIED"}'
step "POST /api/film-supply-orders/:id/transitions (SEVEN_PO_VERIFIED)" 200 "$STATUS"

# ------------------------------------------------- proof + artwork revision
# proof / approval_evidence / acceptance_evidence are official artifacts: every
# upload must cite the officially registered, checklist-verified PO.
PROOF_PAYLOAD="$(printf '{"documentType":"proof","issuerEntity":"maker","filename":"proof-%s.txt","contentType":"text/plain","designKey":"T-35","filmSupplyOrderId":"%s","sevenPurchaseOrderId":"%s","contentBase64":"%s"}' "$STAMP" "$ORDER_ID" "$PO_ID" "$(base64_content "proof T-35 rev1 $STAMP")")"
call POST "/api/projects/$PROJECT_ID/documents" "$PROOF_PAYLOAD"
step "POST /api/projects/:id/documents (proof)" 201 "$STATUS"
PROOF_DOCUMENT_ID="$(extract '"document":{"id":"[0-9a-f-]{36}"' 6)"
PROOF_VERSION_ID="$(extract '"version":{"id":"[0-9a-f-]{36}"' 6)"
if [ -z "$PROOF_VERSION_ID" ]; then PROOF_VERSION_ID="$PROOF_DOCUMENT_ID"; fi
require_id "proof version id" "$PROOF_VERSION_ID"

call POST "/api/documents/$PROOF_DOCUMENT_ID/verify" '{"verificationStatus":"verified","verificationNote":"smoke"}'
step "POST /api/documents/:id/verify (proof)" 200 "$STATUS"

call POST "/api/film-supply-orders/$ORDER_ID/transitions" '{"to":"ARTWORK_RECEIVED"}'
step "POST /api/film-supply-orders/:id/transitions (ARTWORK_RECEIVED)" 200 "$STATUS"
call POST "/api/film-supply-orders/$ORDER_ID/transitions" '{"to":"PROOF_READY"}'
step "POST /api/film-supply-orders/:id/transitions (PROOF_READY)" 200 "$STATUS"

call POST "/api/film-supply-orders/$ORDER_ID/artwork-revisions" \
  "{\"designKey\":\"T-35\",\"fileDocumentVersionId\":\"$PROOF_VERSION_ID\"}"
step "POST /api/film-supply-orders/:id/artwork-revisions" 201 "$STATUS"
REVISION_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "artwork revision id" "$REVISION_ID"

call POST "/api/film-supply-orders/$ORDER_ID/transitions" '{"to":"APPROVAL_PENDING"}'
step "POST /api/film-supply-orders/:id/transitions (APPROVAL_PENDING)" 200 "$STATUS"

call GET "/api/film-supply-orders/$ORDER_ID/approval-gate"
step "GET /api/film-supply-orders/:id/approval-gate" 200 "$STATUS"

# ----------------------------------------------------------- dual approval
APPROVAL_PAYLOAD="$(printf '{"documentType":"approval_evidence","issuerEntity":"customer_generated","filename":"approval-%s.txt","contentType":"text/plain","designKey":"T-35","filmSupplyOrderId":"%s","sevenPurchaseOrderId":"%s","contentBase64":"%s"}' "$STAMP" "$ORDER_ID" "$PO_ID" "$(base64_content "approval evidence T-35 $STAMP")")"
call POST "/api/projects/$PROJECT_ID/documents" "$APPROVAL_PAYLOAD"
step "POST /api/projects/:id/documents (approval_evidence)" 201 "$STATUS"
EVIDENCE_VERSION_ID="$(extract '"version":{"id":"[0-9a-f-]{36}"' 6)"
if [ -z "$EVIDENCE_VERSION_ID" ]; then
  EVIDENCE_VERSION_ID="$(extract '"document":{"id":"[0-9a-f-]{36}"' 6)"
fi
require_id "approval evidence version id" "$EVIDENCE_VERSION_ID"

call POST "/api/artwork-revisions/$REVISION_ID/approvals" \
  "$(printf '{"organization":"customer","decision":"APPROVE","evidenceSource":"email","evidenceDocumentVersionId":"%s","evidenceIdentifier":"smoke-msg-customer-%s","eventTime":"%s"}' "$EVIDENCE_VERSION_ID" "$STAMP" "$EVENT_TIME")"
step "POST /api/artwork-revisions/:id/approvals (customer)" 201 "$STATUS"

call POST "/api/artwork-revisions/$REVISION_ID/approvals" \
  "$(printf '{"organization":"seven","decision":"APPROVE","evidenceSource":"email","evidenceDocumentVersionId":"%s","evidenceIdentifier":"smoke-msg-seven-%s","eventTime":"%s"}' "$EVIDENCE_VERSION_ID" "$STAMP" "$EVENT_TIME")"
step "POST /api/artwork-revisions/:id/approvals (seven, same evidence file, own identifier)" 201 "$STATUS"
boolean_check "second approval closes dual approval"

# -------------------------------------------------- deliveries + readiness
ACCEPT_PAYLOAD="$(printf '{"documentType":"acceptance_evidence","issuerEntity":"kanei","filename":"acceptance-%s.txt","contentType":"text/plain","filmSupplyOrderId":"%s","sevenPurchaseOrderId":"%s","contentBase64":"%s"}' "$STAMP" "$ORDER_ID" "$PO_ID" "$(base64_content "acceptance evidence $STAMP")")"
call POST "/api/projects/$PROJECT_ID/documents" "$ACCEPT_PAYLOAD"
step "POST /api/projects/:id/documents (acceptance_evidence)" 201 "$STATUS"
ACCEPT_DOCUMENT_ID="$(extract '"document":{"id":"[0-9a-f-]{36}"' 6)"
ACCEPT_VERSION_ID="$(extract '"version":{"id":"[0-9a-f-]{36}"' 6)"
if [ -z "$ACCEPT_VERSION_ID" ]; then ACCEPT_VERSION_ID="$ACCEPT_DOCUMENT_ID"; fi
require_id "acceptance evidence version id" "$ACCEPT_VERSION_ID"

call POST "/api/documents/$ACCEPT_DOCUMENT_ID/verify" '{"verificationStatus":"verified","verificationNote":"smoke"}'
step "POST /api/documents/:id/verify (acceptance_evidence)" 200 "$STATUS"

call POST "/api/film-supply-orders/$ORDER_ID/deliveries" \
  "{\"filmSupplyOrderLineId\":\"$LINE_ID\",\"unit\":\"meters\",\"deliveredQuantity\":500,\"deliveredAt\":\"$EVENT_TIME\"}"
step "POST /api/film-supply-orders/:id/deliveries" 201 "$STATUS"
FILM_DELIVERY_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "film delivery id" "$FILM_DELIVERY_ID"

call POST "/api/film-deliveries/$FILM_DELIVERY_ID/confirmation" \
  "{\"evidenceDocumentVersionId\":\"$ACCEPT_VERSION_ID\",\"note\":\"smoke\"}"
step "POST /api/film-deliveries/:id/confirmation" 201 "$STATUS"

call POST "/api/projects/$PROJECT_ID/filling-orders" \
  "$(printf '{"code":"SMOKE-FLO-%s","lines":[]}' "$STAMP")"
step "POST /api/projects/:id/filling-orders" 201 "$STATUS"
FILLING_ORDER_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "filling order id" "$FILLING_ORDER_ID"

call POST "/api/filling-orders/$FILLING_ORDER_ID/lines" \
  '{"lineNumber":1,"description":"充填カプセル","orderedQuantity":1200,"unit":"pods"}'
step "POST /api/filling-orders/:id/lines" 201 "$STATUS"
FILLING_LINE_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "filling order line id" "$FILLING_LINE_ID"

call POST "/api/filling-orders/$FILLING_ORDER_ID/deliveries" \
  "{\"fillingOrderLineId\":\"$FILLING_LINE_ID\",\"unit\":\"pods\",\"deliveredQuantity\":1200,\"deliveredAt\":\"$EVENT_TIME\"}"
step "POST /api/filling-orders/:id/deliveries" 201 "$STATUS"
FILLING_DELIVERY_ID="$(extract '"id":"[0-9a-f-]{36}"' 4)"
require_id "filling delivery id" "$FILLING_DELIVERY_ID"

call POST "/api/filling-deliveries/$FILLING_DELIVERY_ID/confirmation" \
  "{\"evidenceDocumentVersionId\":\"$ACCEPT_VERSION_ID\",\"note\":\"smoke\"}"
step "POST /api/filling-deliveries/:id/confirmation" 201 "$STATUS"

call GET "/api/projects/$PROJECT_ID/audit-history?limit=50"
step "GET /api/projects/:id/audit-history" 200 "$STATUS"

call POST "/api/projects/$PROJECT_ID/commission-readiness" '{}'
step "POST /api/projects/:id/commission-readiness" 201 "$STATUS"
boolean_check "readiness reports isReady"
boolean_check "readiness allows commission calculation"

# ------------------------------------------------------------------ logout
call POST /api/auth/logout
step "POST /api/auth/logout" 200 "$STATUS"

echo
echo "passed: $PASSED / failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
