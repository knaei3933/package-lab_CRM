# M8-OPER2 최종 검증 보고서 — 결제조건 UX·증빙 수동검증 워크플로·완료 이력

작성: 2026-11-14 / 최종 커밋: **`58257b4`** (master push 완료, 원격 실측)
커밋 체인: `30d26c1`(OPER2 본체+마이그레이션 0017) → `2256141`(append-only 프록시) → `58257b4`(게이트 수리)
검증: 격리 test DB(kanei_crm_mvp_test) + 합성 데이터만 사용. 계산기·운영DB·실메일·실발주·NAS 배포 미접촉.

## 1. 자동화 검증

| 검증 | 결과 |
|---|---|
| **전체 테스트 (test DB)** | ✅ **193/193 PASS** (기존 177 + OPER2 신규 16: API 661줄 + core-rules 227줄) |
| build + 타입 (apps/web) | ✅ Compiled successfully |
| localhost:3000 전 화면 | ✅ 200 ( / · /maker-po · /orders · /documents · /approvals · /deliveries · /status ) |
| GitHub push | ✅ `754494d..58257b4` 원격 실측 |

실패 내역: 없음 (도중 43→2→1건 모두 수리 후 0).

## 2. 격리 환경 E2E 실측 (test DB 전용 API :3082, 합성 계정)

**F1 전체 시나리오 — 실측 결과:**

| 단계 | 결과 |
|---|---|
| 합성 프로젝트 생성 (고객·세븐·제조사 3계정 검증) | ✅ 201 |
| 세븐 PO 등록 → 진위 체크리스트 → 공식등록 | ✅ 200×3 |
| 주문 생성 + **paymentTerms 동시 등록** | ✅ `paymentTerms:"prepaid"` 반영 (FIX 1a) |
| **DRAFT 결제조건 PATCH** | ✅ 수정 성공 / 잘못된 값 422 UNKNOWN_PAYMENT_TERMS (prepaid·on_delivery·undetermined만 허용) |
| **payment-gate 조회** | ✅ `gatedOn:"payment_terms_recorded"` + **`paymentConfirmedAt:null`** — prepaid 기록≠입금 확인 실증 (자동 확정 없음) |
| 상태 전이 4단계 → 교정본 업로드 → 교정본 등록 | ✅ 200×4 + 201 |
| **PDF 승인 증빙 고객 승인** | ✅ 등록 (pending_manual_verification 대상) |
| **FIX 2: 수동검증 rejected 등록** | ✅ 별도 불변 이벤트 기록 — **근거(reasonNote) 필수 강제 422 실증** |
| **FIX 2: confirmed 등록** | ✅ 별도 불변 이벤트 — 원본 승인 이벤트 무변경 |
| **FIX 2: 게이트 반영** | ✅ 고객 승인 `valid:true, pendingEvidenceIdentifier:false` → 이중승인 카운트 반영 |
| seven 텍스트 승인 (identifier 포함) | ✅ 201 |
| **이중승인 완성** | ✅ `dualApproved:true → DUAL_APPROVED` |
| DUAL_APPROVED→MAKER_PO_READY | ✅ 200 |
| **제조사 발주서 생성** | ✅ 201 (수취인 주소 필수 422 검증도 실증) |
| **대표 승인 (ceo-approval)** | ✅ 200 |
| 발송 증빙 (증빙 없이 기록) | ✅ SEND_UNVERIFIED 기록 |
| **수락 차단 실증** | ✅ "acceptance follows a proven send only" 422 — 증빙 없는 발송으로는 수락 불가 (업무 순서 강제) |
| **FIX 3: 완료 발주 이력 조회** | ✅ GET /maker-purchase-orders/:poId → `{purchaseOrder, events}` 전체 이력 반환 / 목록 API 정상 |

미실측: 증빙 첨부 send→accept 경로는 위 자동화 테스트(193)가 전부 커버 (E2E에서는 증빙 없는 발송의 차단 규칙을 실증). 실제 브라우저 자동화는 도구가 내부 주소 접속을 차단해 미실행 — 대표님 확인용 체크리스트로 대체.

## 3. 구현 요약 (대표 지시 4건)

1. **G6 입력 (최우선)** — /orders DRAFT 행 결제조건 드롭다운+저장, /maker-po 생성 폼 동일 필드. `prepaid` 기록과 입금 확인(paymentConfirmedAt) 별도 유지.
2. **수동 검증 완료** — admin 전용 POST /artwork-approval-events/:eventId/verification. 검증자·시각·결과·대상 교정본·근거 기록. **별도 불변 이벤트**(마이그레이션 0017 + append-only 트리거 + 클라이언트 프록시 이중 차단). `confirmed` 검증 있을 때만 이중승인 반영, rejected는 게이트 유지.
3. **완료 이력** — /maker-po 목록이 생산·출하·납품 진행 주문도 조회, 완료 단계는 읽기 전용 이력.
4. **검증** — 193/193 + build + E2E 실측 위 표.

## 4. 대표님 확인 절차 (localhost:3000)

1. 로그인: `ceo_test` / 교체된 비번 (재문의 시 재전달)
2. **/orders** → DRAFT 주문 행: 결제조건 드롭다운(prepaid・着荷払い・未定)→저장 확인
3. **/maker-po** → 発注書作成: paymentTerms 선택 필드 확인 / 목록에 완료 발주 이력·재처리 버튼 없음 확인
4. **/approvals** → PDF 증빙 승인의「手動検証待ち」표시 → admin 검증 폼(검証者·時刻·結果·根拠) 등록 → 승인 카운트 반영 확인
5. staff 화면(/staff 권한)은 금액 미표시·임시 수락만 가능한지 별도 계정으로 확인

## 5. 잔여 위험·대기

1. NAS 정식 배포 — 백업 체계 확립 전 불가 (대표 승인 대기)
2. §5.10 진본 체크리스트 표본 2~3건 — 실무 자료 대기
3. evidenceIdentifier 실무 표준 — 운영 표본으로 확정 권장
4. 테스트 실행 후 실DB 계정 소실 시: `bash /root/company-auto/crm-ops/reseed-demo.sh`
