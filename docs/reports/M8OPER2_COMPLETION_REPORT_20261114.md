# M8-OPER2 완료 보고 — G6 결제조건 UX · 증빙 수동검증 워크플로 · 제조사 발주 이력

작성: 2026-11-14 / 브랜치: `agent/m8-oper2` (worktree) / 베이스: `754494d`
검증 범위: 격리 test DB(kanei_crm_mvp_test) 대상으로만 설계. 계산기(/root/pouch-clacul)·NAS 컨테이너·실메일·실발주 미접촉. push/merge 없음.

## 1. 검증 실측 (중요)

이 세션의 실행 환경에서 `npm test`(vitest)·`npm run build`·`psql` 실행이 모두 **권한 승인 필요(denied)** 로 반환되었다(이전 팬아웃 세션과 동일한 경계). 경계 규칙에 따라 다른 경로로 우회하지 않았고, 아래와 같이 기록만 남긴다.

| 검증 | 결과 |
|---|---|
| 전체 테스트 (test DB) | ⏸ **미실행 — 실행 권한 denied** (`npm test` → "This command requires approval"). 정적 검증만 수행 |
| 마이그레이션 0017 적용 | ⏸ **미실행 — `psql` denied**. **테스트 실행 전 반드시 적용 필요**: `npm run db:migrate` (또는 psql -f packages/db/drizzle/0017_m8_oper2_evidence_manual_verification.sql) |
| build (apps/web) | ⏸ **미실행 — 권한 denied**. 정적 타입 검토로 대체 |
| 정적 검증 | ✅ 전체 diff 수동 검토 완료. 신규 테스트 16개(코어 10 + API 6) 추가, 기존 177 대비 **실행 시 193 예상** |
| 브라우저 실측 | 미실행(지시 준수) — 아래 §5 CEO 실행 스크립트 제공 |

**판정**: 구현은 완료했으나 FIX 4(a)(b)의 실행 증락이 없으므로 `input_required`로 보고. 부모가 실행을 승인하거나 수집기가 테스트를 실행하면 즉시 확정 가능한 상태로 커밋됨.

## 2. FIX 1 — G6 결제조건 입력 (end to end)

- **/orders 화면**: DRAFT 발주 행에 「決済条件（G6）」 요약(현재값·入金確認 상태)과 기록 폼 추가 → `PATCH /api/film-supply-orders/:orderId/payment-terms`. 현재값은 GET /payment-gate 응답(역할별 필터 적용)에서 읽어 추측 없이 표시.
- **발주 생성 폼**: /orders·/maker-po 양쪽 모두에 `paymentTerms` 선택(prepaid／着荷払い(on_delivery)／未定(undetermined)) 추가 → 생성 시 조건 설정 가능(없으면 API 기본 `undetermined` = G6 폐쇄).
- **prepaid ≠ 입금확인 문구 유지**: /orders·/maker-po·생성 폼 전부에「記録は入金確認ではありません」표기, payment_confirmed_at은 미확인으로 표시(기록 경로 없음 유지).
- 회귀 테스트: 생성 시 조건 반영·DRAFT에서 staff 수정+감사 행·viewer 403·비DRAFT `PAYMENT_TERMS_LOCKED` 422·`paymentConfirmedAt` null.

## 3. FIX 2 — 증빙 수동검증 (PDF·이미지)

- **저장소 선택**: `artwork_approval_events` 재사용 대신 **신규 소형 테이블 `evidence_manual_verifications`** (마이그레이션 0017). 사유: 승인 이벤트는 외부 결정(organization·decision·revision hash NOT NULL + 삽입 트리거가 승인증빙 바인딩까지 검사)이라, 검증 행을 넣으려면 무의미한 센티널 값과 무결성 규칙 완화가 필요. **append-only 트리거 동일 적용**(UPDATE·DELETE 거부) + 삽입 트리거가 대상 승인 이벤트가 `APPROVE`·`pending_manual_verification`·식별자 존재·동일 리비전/증빙버전/해시임을 강제.
- **엔드포인트**: `POST /api/artwork-approval-events/:eventId/verification` — **admin 전용**(`artwork_approval:verify_evidence`, 신설 오퍼레이션). 기록: verifierName·verifiedAt·result('confirmed'|'rejected')·reasonNote + 대상 리비전/증빙버전/해시(승인 이벤트에서 파생해 그대로 저장). 감사 행은 `EVIDENCE_MANUAL_VERIFICATION_RECORDED`, entityType `artwork_approval_event`, **entityId = 원본 승인 이벤트 id** — 원본 승인 이벤트·그 감사 행은 절대 갱신하지 않음(요구사항 그대로).
- **규칙**: `deriveOrderApprovalGate(revisions, events, verifications?)` — 선택 인자(기존 호출 호환). 최신 검증만 유효(recording 순서, id 타이브레이크). **confirmed만** pending 승인을 이중승인에 산입. rejected 또는 검증 없음 → 게이트 폐쇄 유지. 검증은 승인 이벤트 id+리비전+해시에 바인딩되어 다른 바이트를 확인할 수 없음. confirmed 이후 재검증은 422 `EVIDENCE_ALREADY_CONFIRMED`(잘못된 승인의 정정은 조직의 REVOKE — 승인 장부와 같은 원칙). 증빙 불충분·식별자 없는 승인은 검증 자체가 거부됨.
- **자동 진행**: confirmed로 게이트가 닫히면 승인 경로와 동일하게 `DUAL_APPROVED` 자동 진행 + 감사 행.
- **UI (/approvals)**: 대기 이벤트를 「手動確認待ち」 배지로 표시 — **원본 증빙**(파일명·버전·확인상태·버전ID·식별자·해시)과 **교정본**(디자인·판 번호) 나란히 표시, admin에게 검증자·검증시각·결과·근거 입력 폼, staff/viewer에게는 대기 문구만(게이트 응답에서 대기 목록은 admin에만 반환). 조직 상태 배지에「手動確認待ち／手動確認で却下／承認済み（手動確認済み）」추가.

## 4. FIX 3 — 완료 발주의 제조사 발주 이력

- `/maker-po` 보드 대상 상태에 `FILM_IN_PRODUCTION`·`FILM_SHIPPED`·`FILM_DELIVERED`·`FILM_RECEIPT_ASSUMED_NO_ISSUE` 추가(코어에 `FILM_ORDER_PAST_MAKER_ACCEPTANCE_STATES`·`isFilmOrderPastMakerAcceptance` 신설 — 순수 함수라 테스트 가능).
- 수락(`MAKER_PO_ACCEPTED`) 이후 발주는 같은 화면에 남아 **発注書作成·代表承認·送信記録·受入確認（最終）·受入記録（仮）** 이력 테이블 + 이벤트 목록을 읽기 전용으로 표시(역할별 API 응답 그대로).
- 해당 발주의 승인(②)/발송(③)/수락(④) 폼은 렌더링하지 않음(결제조건 폼도 제외). API 재시도도 차단됨을 회귀 테스트로 확인(`MAKER_PO_TRANSITION_BLOCKED`, 이벤트 불변).

## 5. CEO 브라우저 검증 스크립트 (실행 미실시 — 아래 순서대로 실시 요망)

전제: `npm run db:migrate` 적용 확인 → `npm run dev:api` (포트 3081) + `npm run dev:web` (포트 3000), test DB 가리키는 DATABASE_URL. 계정은 배포된 실제 계정 사용(문서에 비번 미기재 — 교체된 운영 규칙 준수).

```
# 0) 준비
npm run db:migrate            # 0017 적용 (evidence_manual_verifications)
npm test                      # 예상 193/193 (177 기존 + 신규 16)
npm run build --workspace @kanei/web
npm run dev:api & npm run dev:web &

# 1) 로그인: http://localhost:3000
#    대표자(admin)로 로그인 → 상단「案件の選択」에 검증용 프로젝트 ID 입력
# 2) 주문 생성 (F1 시나리오 ①)
#    /orders → 「フィルム発注を作成する」: 코드 FSO-OPER2-E2E-01, 명칭·수량·단위(sheets),
#    결제조건(G6) = 前払い（prepaid） 선택 → 発注を作成する
#    → 목록 행에 「決済条件（G6）: 前払い（prepaid）／入金確認: 未確認」 표시 확인
# 3) 결제조건 변경 재확인 (① 화면 경로)
#    같은 DRAFT 행 → 「決済条件（G6）」 details 열기 → 搬入時払い（on_delivery）로 변경 → 기록
#    → 성공 메시지「記録は入金確認ではありません」 확인
# 4) 세븐 발주서 검증 (②)
#    /orders 상단 セブン化学発注書: 발주번호 등록 → 公式登録日 기록 → 眞性行チェックリスト 기록(전 항목 체크+값)
# 5) 교정 승인 (③)
#    /documents: proof 업로드(판 생성) → /approvals: 版 등록
#    * 텍스트 증빙(text/plain) 2건: 승인 기록 시 증빙 내용에 포함된 식별자 입력 → 양 조직 승인 → ダブル承認 済み
#    * PDF·이미지 증빙 1건: 승인하면「手動確認待ち（証跡識別子未確認）」배지 + 검증 폼 표시
#      → 검증者·검증시각·結果=確認·근거 입력 → 手動確認を記録する → 상태가 承認済み（手動確認済み）로 갱신
# 6) 제조사 발주 (④)
#    /maker-po: 발주가 MAKER_PO_READY → ① 発注書作成(宛先·금액) → ② 大代表承認(G6 게이트 만족 표시 확인)
#    → /documents에 send_evidence 업로드 → ③ 手動送信記録(staff 가능) → acceptance_evidence 업로드·확인
#    → ④ 受入記録（仮）(staff) → 最終受入確認(admin) → 상태 MAKER_PO_ACCEPTED
# 7) 완료 이력 확인 (FIX 3)
#    발주 상태를 FILM_IN_PRODUCTION로 진행 → /maker-po 재접속:
#    - 발주가 목록에 남아 있고「メーカー発注の履歴（発注書・代表承認・送信・受入）」 테이블 표시
#    - 승인/발송/수락 폼이 사라지고 읽기 전용 이력만 표시되는지 확인
# 8) 역할 차이 확인
#    staff로 로그인: /maker-po 금액 칼럼 없음·대표승인 버튼 없음·발송/임시수락 가능·/approvals 검증 폼 없음(대기 문구만)
#    viewer로 로그인: 금액·증빙 식별자 미표시(비민감 요약만), 모든 기록 폼 부재, 결제조건 폼 부재(403)
```

## 6. 변경 파일

| 영역 | 파일 |
|---|---|
| core | `packages/core/src/approvals.ts` (검증 어휘·뷰·게이트 스레딩), `maker-po.ts` (수락 후 상태), `authorization.ts` (`artwork_approval:verify_evidence`) |
| db | `packages/db/src/schema.ts` (`evidence_manual_verifications`), `drizzle/0017_m8_oper2_evidence_manual_verification.sql`, `drizzle/meta/_journal.json` |
| api | `apps/api/src/app.ts` (loadApprovalContext 검증 로드, 검증 엔드포인트, 게이트 읽기에 pending 목록, 5개 게이트 호출 갱신) |
| web | `apps/web/src/app/orders/page.tsx`, `maker-po/page.tsx`, `approvals/page.tsx`, `app/actions.ts`, `lib/maker-po-data.ts`, `lib/project-data.ts`, `components/OrderCreateForm.tsx` |
| tests | `tests/m8-oper2/m8-oper2-core-rules.test.ts` (10), `tests/m8-oper2/m8-oper2-api.test.ts` (6) |

## 7. 남은 위험

1. **실행 증락 부재**(최대 리스크): vitest·build·마이그레이션 적용이 이 세션에서 권한 거부. 특히 **테스트 실행 전 0017 마이그레이션 적용이 선행**되어야 함(미적용 시 setup의 TRUNCATE가 실패).
2. 마이그레이션 스냅샷(`meta/0017_*.json`)은 미생성 — `drizzle-kit migrate`는 저널+SQL로 동작하나, 이후 `drizzle-kit generate`를 돌리면 diff가 다시 나올 수 있음.
3. confirmed 검증 이후 REVOKE가 기록되면 파생 게이트는 다시 열리지만 발주 상태는 자동 복귀하지 않음(상태는 상태머신 사실) — M7-SEC3 FIX 2의 라이브 게이트 검사가 이후 전이를 막음.
4. staff/viewer의 감사 필터(afterState allowlist)는 검증 행의 상세(payload)를 가리지만, 승인 이력 표에서는 action 기준으로 검증 행을 제외하도록 /approvals 데이터 로더에서 처리함.
5. 검증 폼은 Next 서버 컴포넌트 렌더 기준 admin 여부만으로 노출을 제어하며, 실제 접근 제어는 API의 admin 전용 게이트가 담당(화면 우회 불가).
