# M8-OPERATOR 완료 보고 — 제조사 발주 운영자 UI + 보안 보완

작성: 2026-11-14 / 커밋: `2627aac`(S5+보안) + `0bfdfb1`(테스트·엔드포인트 수리) — master push 완료 (원격 실측 `0bfdfb1`)
검증: 격리 test DB(kanei_crm_mvp_test) + 합성 데이터만 사용. 계산기·운영DB·실메일·실발주 미접촉.

## 1. 검증 실측

| 검증 | 결과 |
|---|---|
| 전체 테스트 (test DB) | ✅ **177/177 PASS** (기존 165 + M8 신규 12: 권한 매트릭스·원가 노출·G6·증빙 식별자) |
| build + 타입 (apps/web) | ✅ Compiled successfully |
| 브라우저 실측 (localhost:3000) | ✅ 전 화면 200: / · /maker-po · /orders · /documents · /approvals · /deliveries · /status |
| 로그인 실측 | ✅ ceo_test + 교체된 비번 201 (공개된 옛 비번은 401 무효 확인) |

## 2. 구현 내역

### 1) maker-PO API 응답 역할별 분리 (allowlist)
- staff·viewer의 GET maker-purchase-orders 응답에서 금액·원가·스냅샷 본문 제거 (staff=업무 필수 필드, viewer=비민감 상태 요약). admin만 전체 스냅샷. 재현 테스트 선작성 → 차단 확인.

### 2) 역할 권한 매트릭스 API 강제
- admin: 발주서 생성·대표 승인·발송 증빙 관리·**수락 최종 확정**
- staff: 허가 프로젝트의 수동 발송 증빙 등록 + **임시 수락(PROVISIONAL) 기록** — 최종 확정과 구분 (이벤트에 provisional 구분, admin 확정 시 선행 임시 기록 연동 표시)
- viewer: 비민감 상태 조회만. 각 조합 허용/거부 테스트 포함.

### 3) G6 결제조건 (화면+API)
- 발주 생성 시 paymentTerms 등록, DRAFT에서 PATCH /payment-terms 수정 가능 (비DRAFT 422)
- GET /payment-gate: 게이트 충족 여부·차단 사유 반환
- **`prepaid` 기록 ≠ 입금 확인**: payment_confirmed_at 칼럼 신설(마이그레이션 0016) — 현재 자동 설정 경로 없음, 입금 증빙은 별도 수동 확인 단계로만 확정 (UI에도 별도 표시)

### 4) evidenceIdentifier 형식별 처리
- 텍스트형 증빙: 문서 내용 substring 검증 유지
- PDF·이미지 등 바이너리: UTF-8 검사 무의미 → **`pending_manual_verification` 자동 표시** (마이그레이션 0016: evidence_identifier_status)
- 대기 상태는 이중승인 완성 카운트에 불포함 — 승인 자체는 기록되되 플래그만 표시 (자동 승인 없음)

### 5) S5 운영자 화면 (일본어 UI)
- /maker-po: 発注書作成+一覧(admin 금액 표시, staff/viewer는 필터 뷰)·大代表承認(G6 게이트 상태·차단 사유 표시)·手動送信記録(staff 가능)·メーカー受入(staff 임시/admin 최종 구분)·역할별 감사 대시보드(S3 필터 연동)
- 각 단계에 다음 행동과 차단 사유(G6未満·二重承認不足·送信証跡なし)를 화면 표시

## 3. 커밋·재현

| 커밋 | 내용 |
|---|---|
| `2627aac` | M8-OPERATOR (15파일, +2543: 화면 5 + 역할 매트릭스 + 0016 마이그레이션 + 테스트 987줄) |
| `0bfdfb1` | 손상 테스트 재작성 + payment-terms/payment-gate 엔드포인트 구현 |
| `dfe4d50`·`64c84ca` | (이전) M6 빌드 수리·smoke 정비 |

재현: `export DATABASE_URL=<test> && npx vitest run` → 177/177 · `npx vitest run tests/m8-operator/ -t '<테스트명>'` 개별 재현 · 브라우저: localhost:3000 로그인 후 /maker-po

## 4. 미해결 위험·대기

1. smoke-ui 재실행은 새 프로젝트 필요 (상태 충돌) — 자동 생성 단계 추가 권장
2. §5.10 진본 체크리스트 표본 2~3건 — 실무 자료 대기
3. **NAS 정식 배포** — 백업 체계 확립 전 불가 (대표 판단 대기)
4. evidenceIdentifier 실무 표준 확정 — 운영 표본 권장
5. 테스트 실행 후 실DB 재시드 필요 시: `bash /root/company-auto/crm-ops/reseed-demo.sh`
