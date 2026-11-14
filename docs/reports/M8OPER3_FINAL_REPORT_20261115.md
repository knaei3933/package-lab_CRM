# M8-OPER3 최종 검증 보고서 — F1 생산 발주 마지막 안전성 검증 (승인취소 차단·E2E·복원시험)

작성: 2026-11-15 / 최종 커밋: **`c5c40a5`** (master push 완료, 원격 실측)
커밋 체인: `6689154`(실시간 재확인+회귀테스트+데모시더) → `5765392`(m4 기대값 갱신) → `c5c40a5`(시더 수리)
검증: 격리 test DB + 합성 데이터만. 운영DB(스키마 마이그레이션 제외)·실메일·실발주·기존 견적·NAS 배포 미접촉.

## 1. 승인 취소 후 제조사 발주 차단 (대표 지시 1) — ✅ 구현·실측 완료

**수정 전 재현**: maker-PO 생성(~2959행)·대표 승인(~3039)·발송 증빙(~3196)·수락(~3456) 4개 핸들러에 **실시간 승인 게이트 재확인이 0건** — REVOKE 후에도 진행 가능한 상태였음을 회귀 테스트로 재현.

**수리 내용** (6689154):
- 4개 경계 모두 `deriveOrderApprovalGate` **실시간 재판독** → 유효 이중승인 없으면 422 `DUAL_APPROVAL_NO_LONGER_VALID` (일본어 안내: 취소된 조직의 승인을 다시 받은 후 실행)
- **모든 재확인(통과·차단 모두)을 `audit_events`에 append-only 기록** — action `MAKER_PO_DUAL_APPROVAL_RECHECK`, afterState에 stage·result·reason·게이트 스냅샷(조직별 valid/revoked/최신결정)·requestMetadata
- **외부 발송 구분**: `SEND_EVIDENCE_REGISTERED`+`VERIFIED` 이벤트가 존재하는(이미 출하된) PO는 송증기록·수락을 소급 차단하지 않고 기록만 (reason `gate_closed_after_proven_send_recorded_not_enforced`) — **미발송 건만 차단**
- 설계 정합: 상태기계 자체는 미변경(지시 준수), 판본 진행(change review) 경로는 기존 설계(T-24) 보존

**실측 결과** (테스트 197에 포함):
1. REVOKE 직후 생성·대표승인·발송 3건 **전부 422 차단** — PO·이벤트 무기록, 감사 행 4건(통과 1+차단 3)·게이트 스냅샷 검증
2. 취소 조직이 **새 텍스트 승인으로 재승인 → 생성 201** (실시간 판독 증명)
3. **검증된 발송 후 REVOKE → 수락 200 통과** (reason 기록) → `FILM_IN_PRODUCTION` 도달

## 2. 정상 제조사 발주 E2E (지시 2) — ✅

증빙 문서 첨부 발송(verificationStatus=VERIFIED) → 수락 등록 → 수락 완료 → 생산 진행 전이까지 합성 데이터로 통과 (m8-oper3 테스트「SHIPPED-」시나리오). 실메일 발송 없음.

## 3. 브라우저 수동 확인 준비 (지시 3) — ✅ 준비 완료 / 클릭은 미검증

**데모 시딩: 26단계 전부 성공 (failed: 0)** — main DB(운영 데이터 보존 상태에서 추가만):
- **project id**: `01a1dc79-0a1d-7390-bc0c-e074a7f0ac44`
- **order id**: `01a1dc79-0a82-7b0f-b89f-9a58d51fcd6c` (paymentTerms=prepaid, DUAL_APPROVED→MAKER_PO_READY)
- **maker PO id**: `01a1dc79-0c1b-72e6-959f-ad6b2f03cf77` (대표 승인 완료 — 발송·수락 기록 대기 상태)
- 로그인: `admin_composite` / `composite-admin-pass` (합성 데모 계정, 운영과 무관)
- 확인 절차: localhost:3000 → 위 프로젝트의 maker 발주서에서 **送信証跡(proven send)·受領(acceptance) 수동 기록** → REVOKE 기록 후 같은 화면에서 `DUAL_APPROVAL_NO_LONGER_VALID`(422) 표시 확인
- **브라우저 클릭 검증: 미검증** (도구가 내부 주소 접속 차단) — ID·계정·데이터는 준비 완료, 대표님 직접 확인 대기

## 4. 최종 검증 (지시 4)

| 항목 | 결과 |
|---|---|
| 전체 테스트 (test DB, master merge 상태) | ✅ **197/197 PASS** (기존 193 + OPER3 신규 4, 재현→수리→재확인) |
| build·타입 (apps/web) | ✅ 성공 (OPER3는 API 중심, UI 변경 없어 웹 재배포 불필요 확인) |
| DB 마이그레이션 | ✅ test DB: drizzle migrate + main DB: 0014~0017 수동 적용 (ERROR 0 — payment_terms·payment_confirmed_at 칼럼·수동검증 테이블·evidence_identifier 칼럼 추가 확인, 기존 데이터 무변경) |
| **백업 복원 시험** | ✅ **직접 실행 완료** — test DB 전용: `pg_dump kanei_crm_mvp_test` → `kanei_crm_mvp_test_restore` 생성·복원(ERROR 0) → 행수 대조 일치(projects 2=2, audit_events 1=1, users 4=4) → 복원본 DROP. **main DB 미사용** |
| GitHub push | ✅ `e486fdc..c5c40a5` 원격 실측 |

실패 내역: 과정 중 43→2→1→1건 모두 수리 후 최종 0. (m4 기대값 갱신은 "기존 테스트가 구식 동작을 정상으로 가정" 케이스 — 재확인 감사 이벤트는 새 업무 규칙의 정상 기록)

## 5. 운영 환경 반영·주의

- main DB에 스키마 마이그레이션(칼럼·테이블 추가만) 적용 — **기존 운영 데이터·계정·데모 소실 없음 확인**
- localhost:3000 서비스 중 (UI는 58257b4 빌드와 동일 — OPER3 화면 변경 없음)
- 잔여 대기: NAS 정식 배포(대표 승인 대기), §5.10 표본, evidenceIdentifier 실무 표준, 브라우저 클릭 확인(대표님)
