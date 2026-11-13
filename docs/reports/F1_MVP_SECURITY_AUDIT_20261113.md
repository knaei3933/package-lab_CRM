# F1 MVP 보안·업무규칙 감사 (수정 감사) — 검증 결과 및 수정 계획

작성: 2026-11-13 / 감사 기준 커밋: `64c84ca` (GitHub knaei3933/package-lab_CRM master)
방법: 소스 코드 직접 관찰(읽기 전용) · 운영 환경 변경 없음 · 실DB·실메일·실발주 미실행

## 1. 문제별 판정

| ID | 문제 | 판정 | 코드 근거 |
|---|---|---|---|
| P0-1 | 일반 전이 API 우회 | **🔴 취약 확정** | `/transitions`(app.ts:802)에서 SEVEN_PO_VERIFIED·MAKER_PO_READY에만 게이트 존재. **APPROVED_FOR_MANUAL_SEND·MAKER_PO_SENT_MANUALLY·MAKER_PO_ACCEPTED로는 제조사 발주 스냅샷·CEO 승인 기록·수동발송 증빙·수락 증빙 없이도 전이 가능** — M4 전용 API(maker-purchase-orders)와 별도 통로 |
| P0-2 | 이중 승인 독립성 | **🟠 유력(재현 필요)** | 승인 API(2188)는 조직·decision·evidenceSource·증빙바인딩(order·design) 검증은 존재. 그러나 **같은 증빙 문서 버전으로 customer·seven 두 승인 기록을 만드는 차단이 코드에 없고**, 승인자 신원은 자유 텍스트 — 임의 작성 가능 |
| P0-3 | 감사 응답 정보 노출 | **🔴 취약 확정** | audit-history(1126)가 `audit_history:read` 권한자(할당된 staff·viewer 포함)에게 **beforeState·afterState·requestMetadata 무필터 반환** — maker PO 스냅샷(구매금액·원가)·비공개 영업정보 포함 |
| P0-4 | 세븐 PO 진위 우회 | **🟡 대체로 안전(1건 확인 필요)** | 전이 게이트(app.ts:853~867)가 official_registered_at + verificationStatus(verified) + reviewPending 전부 평가(documents.ts SevenPoPrecedenceGate). checklist 미기록 시 verified 불가. **확인 필요**: register-official·checklist 경로 외에 verificationStatus를 verified로 기록하는 경로 부재 최종 확인 |
| P1-5 | 필수 디자인 누락 발주 | **🟠 확인 필요** | MAKER_PO_READY 게이트가 dualApproved·missingApprovals를 평가하나, **발주 라인의 designKey 전수 ⊆ 승인완료 designKey 집합** 대조는 미확인 — 일부 디자인만 승인된 전이 가능성 |
| P1-6 | 운영자 화면 | **🔴 UI 미구현 확정** | 현재 웹 화면 6개(/, /orders, /documents, /approvals, /deliveries, /status)에 제조사 발주서 생성·대표 승인·수동 발송 증빙·수락 화면 전부 없음 — API 전용 |

## 2. 수정 계획 (승인 후 구현)

| 순서 | 수정 | 대상 파일 | 영향 |
|---|---|---|---|
| S1 | transitions에서 제조사 관련 상태(APPROVED_FOR_MANUAL_SEND·MAKER_PO_SENT_MANUALLY·MAKER_PO_ACCEPTED·MAKER_PO_READY)를 **거부 목록으로 차단** — 해당 전이는 M4 전용 API만 허용 (단일 전이 정책: core 전이표 유지) | apps/api/src/app.ts | 125 테스트 중 해당 경로 사용 케이스 확인 필요 — **테스트 수정 없이** API만 수리. 기존 smoke 재실측 |
| S2 | 승인 독립성: (a) 동일 evidenceDocumentVersionId로 서로 다른 organization 승인 기록 금지 (b) approval_evidence 문서의 issuerEntity가 승인 organization과 일치하는지 강제 (customer 증빙→customer 승인만) | packages/core(신규 규칙) + apps/api | artwork 관련 테스트 전부 회귀 확인 |
| S3 | audit-history 응답 필터: role별 서버측 마스킹 — viewer=요약만(상태·시간), staff=금액·원가·발주금액 필드 마스킹, admin=전체. 마스킹은 응답 직전 1곳에서 일괄 적용 | apps/api/src/app.ts | 감사 관련 테스트 3건 회귀 확인 |
| S4 | P0-4·P1-5 재현 테스트 작성: (a) checklist 없이 verified 불가 확인 (b) 발주 라인 전 designKey ⊆ 승인완료 집합 게이트 신설(P1-5 확정 시) | tests/m7-audit/ 신규 | 테스트 추가만 — 기존 125 무변경 |
| S5 | P1-6: 제조사 운영 화면(발주서 생성·CEO 승인·수동발송 증빙·수락) 신규 화면 — 별도 위임(M7) | apps/web | 화면 추가 — API 무변경 |

각 수정 후 검증: 기존 125 + 신규 재현 테스트 전부 통과 + smoke 46/46 + build 성공 → 커밋·push는 별도 보고 후.

## 3. 영향 범위 요약

- **변경 파일 예상**: apps/api/src/app.ts (S1·S2·S3), packages/core/src/{documents,state-machine}.ts (S2), tests/m7-audit/ (S4 신규), apps/web (S5 별도)
- **영향 없음**: 기존 견적 계산기(pouch-clacul)·운영 DB(NAS :3000)·실메일·실제 제조사 발주 — 전부 미접촉
- **검증 환경**: 격리 test DB(kanei_crm_mvp_test) + 합성 데이터만 사용 (이미 구축됨)

## 4. 진행 방식 (승인 요청)

1. **S1~S4 (보안·규칙 수정 + 재현 테스트)**: 대표님 승인 시 위임 실행
2. **S5 (제조사 운영 화면)**: 별도 건 — 승인 시 M7로 위임
3. 각 단계 완료 시: 테스트 실측 보고 → 커밋·push → 본 보고서 갱신 후 NAS 저장
