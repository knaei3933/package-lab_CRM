# M8-HARDEN — maker-PO production-order safety (A3 · B2 · C1 · C2) — 2026-11-16

범위: 대표 승인 P0 4건 (A3·B2·C1·C2). 격리 worktree(`agent/m8-harden`) + 격리 test DB만 사용.
운영DB·실메일·실발주·NAS 미접촉. 커밋은 유닛 브랜치에만 — push·merge 없음.

> **검증 상태 (중요).** 이 유닛은 `npm ci` / `npm test` / `npm run build` / `psql` 실행이
> 모두 승인 필요(권한 거부) 환경이다. 따라서 아래의 "테스트 수"와 "빌드 결과", "마이그레이션
> 적용"은 **실행 증거가 아니라 정적 검증(전수 코드 리뷰 + 신규 테스트의 기대값 재계산)** 이다.
> 실행이 필요한 항목은 유닛 결과의 `input_required`에 명시했다.

## 1. A3 — 현재 리비전의 이중승인 상실 시 사전-발송 행위 전면 차단

**Before (재현).** 주문이 MAKER_PO_READY에 있고 메커 발주서가 초안인 상태에서 신규 아트워크
리비전을 등록하면 주문은 CHANGE_REVIEW로 가고 기존 승인은 무효가 된다. 그래도 CEO 승인은
200으로 성공했고, 재-check는 `gate_closed_superseded_revision_snapshot_void_governs` 사유로
"통과"를 기록했다 → 아무 조직도 승인하지 않은 리비전 위에 종이가 인증됨
(`tests/m8-fail` FINDING A3, `docs/reports/M8FAIL_FINAL_REPORT_20261115.md`).

**After.** `dualApprovalRecheck`는 게임이 닫혀 있기만 하면 차단한다 — 철회(REVOKE)든
리비전 교체든. 메커 발주서 생성·CEO 승인·send-evidence가
`422 DUAL_APPROVAL_NO_LONGER_VALID` + `missingApprovals`로 거절되고, 감사에는
`gate_closed_current_revision_missing_dual_approval` 사유의 `blocked` 행이 기록된다.
회복은 두 조직이 **새 리비전**을 다시 승인하는 것 (테스트: 차단 → 재승인 → CHANGE_REVIEW
해제 → 승인 200 → EML 발송 VERIFIED).
유지된 것: 이미 발송이 증명된 종이는 소급 차단하지 않는 carve-out
(`gate_closed_after_proven_send_recorded_not_enforced`), G10 스냅샷-void 기계
(T-23/T-24 스냅샷 불일치 거절은 그대로 — `tests/m4` T-23), 모든 재-check의 감사 행.

파일: `apps/api/src/app.ts` (`dualApprovalRecheck`), `tests/m4/m4-maker-po.test.ts`
(T-24 재승인 시나리오가 이제 차단→재승인→재발송), `tests/m8-fail/…test.ts` A3 2건.

## 2. B2 — 필름 발주 1건당 활성 메커 발주서 1장

**(a) migration 0018.** 부분 UNIQUE 인덱스로 동시성 방어:

```sql
CREATE UNIQUE INDEX maker_purchase_orders_active_order_unique
  ON maker_purchase_orders (film_supply_order_id)
  WHERE deleted_at IS NULL AND status <> 'CANCELLED';
```

* 선택한 술어와 이유는 마이그레이션 머리글에 기록: `CANCELLED`가 유일한 "슬롯을 놓아주는"
  상태다. `state-machine.ts`에는 취소 상태가 없고(필름 발주 상태계), maker PO 어휘의
  다른 닫힌 상태는 슬롯을 유지한다 — SEND_UNVERIFIED는 T-21 의도적 막다른 길,
  MAKER_PO_ACCEPTED는 완결된 종이, SNAPSHOT_VOIDED는 재승인 대기.
  `deleted_at`은 항상 NULL(앱은 행을 지우지 않는다) — 미래의 soft-delete가 유일성 구멍을
  다시 열지 못하도록 술어에 포함했다.
* 함께: enum에 `CANCELLED`·`MAKER_PO_CANCELLED`·`PENDING_MANUAL_VERIFICATION` 추가,
  `deleted_at`·`verification_method`·`verification_checks`·`verification_note` 칼럼,
  `documents.maker_purchase_order_id`, `maker_po_send_manual_verifications` 테이블
  (0017과 같은 append-only 트리거), `status_requires_ceo_approval` CHECK 교체
  (DRAFT·CANCELLED는 승인 없이 가능). 스키마(`packages/db/src/schema.ts`)와 동일하게
  손작성 — **test DB 적용은 `psql -f`로 실행해야 한다(승인 필요)**.

**(b) 사전 검사 + 422.** POST 생성 엔드포인트가 insert 전에 활성 PO를 읽고
`422 MAKER_PO_ALREADY_EXISTS`에 기존 PO id(`existingMakerPurchaseOrderId`)와
안내 일본어 메시지를 담아 돌려준다. 인덱스는 backstop — 유실된 쪽은 같은 코드로 대답.

**(c) 교체 흐름 (정정·재발주 = 취소 후 재생성).** admin 전용
`POST /api/maker-purchase-orders/:poId/cancel` — 본문 `note` 필수. append-only
`MAKER_PO_CANCELLED` 이벤트 + `MAKER_PO_CANCELLED`/`MAKER_PO_STATUS_CHANGED` 감사 행,
status를 CANCELLED로, **행은 절대 삭제하지 않는다.** 취소 가능: DRAFT,
APPROVED_FOR_MANUAL_SEND, MAKER_PO_SENT_MANUALLY, SNAPSHOT_VOIDED. 불가:
SEND_UNVERIFIED(T-21 막다른 길), MAKER_PO_ACCEPTED(완결), 이미 CANCELLED.
취소는 주문을 MAKER_PO_READY로 되돌려 발주 단계를 다시 연다(예외 상태·MAKER_PO_READY는
그대로) — 감사 사유 `maker_po_cancelled_reopens_the_ordering_step`.

**(d) 수입 증적의 PO 결속.** `documents`에 `maker_purchase_order_id` 추가(업로드 때
전달·검증). 수입 증적이 **같은 maker PO id**에 묶여 있지 않으면
`422 ACCEPT_EVIDENCE_PO_MISMATCH` — 시나리오 D의 미세도 결손(주문 단위 결속 하나로 두 장의
종이가 닫히던 것) 수정. 스냅샷의 `order.id`가 주문과 다르면 같은 코드로 거절.
기존 `ACCEPT_EVIDENCE_ORDER_MISMATCH`(다른 주문)·`PROJECT_MISMATCH`는 앞서 그대로.

파일: `packages/db/drizzle/0018_….sql`, `packages/db/src/schema.ts`,
`packages/core/src/maker-po.ts`, `packages/core/src/authorization.ts` (`maker_po:cancel`),
`apps/api/src/app.ts` (생성·취소·accept-evidence·문서 업로드),
`tests/m8-fail/…test.ts` B2 2건, `tests/m8-harden/m8-harden-core-rules.test.ts`.

## 3. C1 — 발송 증적 = 생산발주 EMAIL, 이메일로 검증

**Before (재현).** `send_evidence` 타입 문서 버전만 인용하면 내용과 무관하게 VERIFIED —
일본어 메모 한 장으로 종이가 회사를 떠났다 (FINDING C1).

**After.** `POST /api/maker-purchase-orders/:poId/send-evidence`는
`contentBase64`(원본 .eml, message/rfc822)를 받아 그 바이트를 이 종이의 send_evidence
문서로 저장(문서 1장 + append-only 버전)하고, 인용된 문서 버전 경로는 저장된 바이트를
읽어 같은 검증을 돌린다. 파서는 **의존성 없는 최소 RFC822/MIME 파서**
(`packages/core/src/eml.ts` — postal-mime 등 외부 의존성을 추가하지 않기로 선택;
 Thunderbird 내보내기가 만드는 형태(multipart/mixed + base64, 접힌 헤더, RFC 2047)를
 읽고, 모르는 것은 안전하게 거절. package.json 변경 없음).

검사 목록(이벤트의 `verification_checks`에 기계판독 가능하게 저장):
Message-ID 존재·형식 / From 존재 + 기록된 sender와 일치 / To·Cc가 발주서의 승인된 수신처와
정확히 일치(대소문자 무시) / Date 해석 + sentAt과의 일치(허용 오차 10분) / Subject에 발주서
식별자(스냅샷이 가진 **필름 발주 코드**, sevenPoNumber도 허용 — 문서화된 선택) /
첨부 sha256 vs 스냅샷의 아트워크 해시 — 일치하면 `passed`로 강한 신호를 기록
(불일치는 `not_matched`로 기록만 하고 VERIFIED를 막지 않는다: 정상 내보내기는 첨부가
없을 수 있다 — 문서화된 판단, 잔여 리스크 §8).

결과: 전부 통과 → `VERIFIED` + `verification_method='eml_header_check'`;
하나라도 실패(PDF/스크린샷, Message-ID 없음, 수신처 불일치, 제목 불일치, Date 불일치,
파싱 불가) → `PENDING_MANUAL_VERIFICATION` — **VERIFIED 불가**. 일반 텍스트 파일은 더 이상
VERIFIED에 도달하지 않는다. 요청의 `recipients` 필드가 만드는 기존 하드 게이트
(`SEND_RECIPIENT_MISMATCH` → SEND_REJECTED)는 그대로 유지했다.

수동 검증: 0017의 `evidence_manual_verifications` 패턴을 그대로 딴 새 테이블
`maker_po_send_manual_verifications`(append-only 트리거, 대상은
`SEND_EVIDENCE_REGISTERED` + PENDING인 이벤트, 자기 종이 이름 필수)과 admin 전용 엔드포인트
`POST /api/maker-po-events/:eventId/send-manual-verification`(검증자·시각·결과·사유,
`confirmed`는 최종 — 재확인은 `MAKER_PO_SEND_ALREADY_CONFIRMED`). 새 테이블을 선택한 이유:
maker_po_events는 종이에 대한 외부 사실(승인·발송·무효·거절)이고 이것은 그 이벤트를 향한
내부 인간 확인이며, 이벤트 어휘에는 이를 정직하게 담을 값이 없다.

**기록된 문서화 사항:** EML이 **저장**되는 것은 인도의 증거가 아니다. VERIFIED는
"이메일 내용과 수신처가 검증됨"이고, 인도는 대표의 수동 확인(`delivery_asserted` 감사 필드,
엔드포인트 응답의 `deliveryAssertedByManualVerification`)이 있을 때만 단정된다.

파일: `packages/core/src/eml.ts` (신규), `packages/core/src/maker-po.ts`,
`packages/core/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/document-storage.ts`
(`message/rfc822` 허용), `apps/api/src/maker-po-view.ts`, `apps/web`(라벨·안내 문구),
`tests/helpers/maker-po-evidence.ts` (신규), `tests/m8-harden/…`, `tests/m8-fail/…`.

## 4. C2 — 미래/불가능한 sentAt

* `sentAt > 서버 now + 10분` → `422 SENT_AT_IN_FUTURE` (UTC instant 비교 — 타임존 시프트로
  우회 불가, `serverNow`/`sentAt`을 응답에 포함). 10분은 발송기계–서버 시계 오차 허용.
* `sentAt < ceoApprovedAt`(승인 전 발송 기록) → 하드 실패 없이 `PENDING_MANUAL_VERIFICATION`
  + 사유 노트(`SENT_AT_PRECEDES_CEO_APPROVAL`, `verification_note`에 일본어 사유).
* EML Date 헤더가 sentAt과 충돌(±10분 초과) → 동일하게 PENDING(`EML_DATE_SENT_AT_CONFLICT`).
* 타임스탬프만 있는 등록(증적 없음)은 기존대로 UNVERIFIED → SEND_UNVERIFIED(더 강한 정지).

파일: `packages/core/src/maker-po.ts`(`evaluateMakerPoSentAtCurrency`),
`packages/core/src/eml.ts`(skew), `apps/api/src/app.ts`, `tests/m8-fail` C2.

## 5. STEP 5 — legacy 감사

`docs/reports/LEGACY_VERIFIED_SEND_AUDIT_20261115.md` — 검토 리스트 쿼리(SELECT 전용)·
정의·test DB 확인 쿼리. **실행은 승인 필요(경계 기록)** — `0`은 정적 결론이지 관측치가 아님.
test DB의 신규 경로는 `verification_method='eml_header_check'`를 항상 기록하므로 legacy 행이
생기지 않는다.

## 6. 변경 파일

코드: `packages/core/src/eml.ts`(신규), `maker-po.ts`, `authorization.ts`, `status-labels.ts`,
`index.ts`; `packages/db/src/schema.ts`, `packages/db/drizzle/0018_….sql`(신규);
`apps/api/src/app.ts`, `document-storage.ts`, `maker-po-view.ts`;
`apps/web/src/lib/maker-po-data.ts`, `apps/web/src/app/maker-po/actions.ts`.
테스트: `tests/helpers/maker-po-evidence.ts`(신규), `tests/m8-harden/m8-harden-core-rules.test.ts`(신규),
`tests/m8-fail/m8-fail-scenarios.test.ts`(FINDING 3건 플립 + 신규), 기존 send/accept 경로의
7개 파일(m4·m5·m7-security·m8-oper2·m8-oper3·m8-operator).
문서: 본 보고서 + legacy 감사 보고서.

## 7. STEP 6 — 검증 (정적; 실행은 승인 필요)

| 항목 | 상태 |
|---|---|
| 기존 205 + 신규 테스트 | ⚠️ **미실행** — `npm test` 승인 필요. 정적 검증: FINDING A3·B2·C1 플립, C2 신규, B2 동시성 1건, A3 회복 1건, C1 EML 긍/부정 5케이스, 수동확인 3케이스, 순수 규칙 테스트 20여 단언. 기존 테스트는 EML 경로·accept 결속·(A3로 인한) T-24 재승인 흐름만 갱신 — 하나의 기존 단언도 약화시키지 않음 |
| `npm run build` (apps/web) | ⚠️ 미실행 — 승인 필요. 정적: 라벨 맵은 `Record<string,string>`, switch에 default 존재, 신규 필드는 추가만 |
| migration 0018 → test DB | ⚠️ 미적용 — `psql -f` 승인 필요. 스키마와 1:1 대응을 손작성·대조 완료 |
| 신규 의존성 | 없음 — RFC822 파서를 core에 손작성 (postal-mime 미채택, 이유 §3) |

## 8. 잔여 리스크 / 대표 확인 사항

1. **첨부 해시 불일치는 VERIFIED를 막지 않는다** — 정상 내보내기엔 첨부가 없을 수 있어
   기록만 한다(`not_matched`). 강제하려면 한 줄 변경으로 가능 (대표 판단).
2. **PENDING 이벤트는 종이를 움직이지 않는다** — APPROVED_FOR_MANUAL_SEND에 남아
   수정된 .eml 재등록이 가능. UNVERIFIED(타임스탬프만)의 T-21 막다른 길은 그대로 —
   거기서의 회복 절차는 여전히 별도 과제.
3. **취소 후 주문 되돌림** — 취소가 주문을 MAKER_PO_READY로 되돌린다(재발주 가능하게).
   이미 실제 발송된 종이를 취소하면 감사에 "발주 단계 재개"가 기록된다 — 정책 확인 필요.
4. **legacy VERIFIED 행은 그대로** — 소급 차단/carve-out 유지. 검토 리스트는 STEP 5 쿼리로.
5. **subject 식별자** — 필름 발주 코드(또는 sevenPoNumber)를 채택. 다른 식별자(예: 발주서
   번호 칼럼 추가)를 원하면 스냅샷 확장이 필요.
6. **From = 기록된 sender 일치 검사**는 본 안건 목록에 없던 추가 검사(불일치 → PENDING).
7. 실행(테스트·빌드·마이그레이션·legacy SELECT)은 `input_required`로 승인 대기.
