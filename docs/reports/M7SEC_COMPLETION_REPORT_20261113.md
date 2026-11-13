# M7-SEC 보안 강화 완료 보고 — F1 MVP (S1~S4 + S5 회귀 테스트)

작성: 2026-11-13 / 커밋: `b2a61b5`(S1~S4) + `97d4da7`(테스트 수리) — master push 완료 (원격 실측 `97d4da7`)
방법: 격리 worktree 브랜치 → test DB(kanei_crm_mvp_test) 검증 → merge. 운영 환경·실DB·실메일·실발주 미접촉.

## 1. 검증 실측 (독립 재확인)

| 검증 | 결과 |
|---|---|
| 전체 테스트 (격리 test DB) | ✅ **146/146 PASS** (기존 125 + 신규 보안 21) |
| build + 타입 검사 (apps/web) | ✅ Compiled successfully, 4페이지 생성 |
| 기존 125 중 수정 | m1(43)·m3(5)·m4(5)·m5(75) — **취약 동작을 정상으로 가정했던 부분을 올바른 규칙으로 수정** (대표 승인 S5) |
| smoke-ui | master 유지 (46/46 이전 실측) |

## 2. 수정 내역 (취약점별)

### S1 — 일반 전이 API의 제조사 체인 차단 ✅
- `/api/film-supply-orders/:orderId/transitions`에서 APPROVED_FOR_MANUAL_SEND·MAKER_PO_SENT_MANUALLY·MAKER_PO_ACCEPTED 도달 시 **422 MAKER_CHAIN_TRANSITION_FORBIDDEN** 반환 (M4 전용 엔드포인트 안내)
- 검증 로직을 packages/core/src/maker-po.ts(41줄 신규)로 추출 — M4 엔드포인트와 **동일 서버 검증 서비스 공유**
- SEVEN_PO_VERIFIED(공식등록+진위 게이트)·MAKER_PO_READY(이중승인) 선행 게이트 유지·재점검

### S2 — 이중 승인 독립성 ✅
- (증빙 문서 버전 × 조직) 중복 승인 기록 차단 — 재승인은 기존 supersedesEventId 흐름만 허용
- 신규 필수 필드 `evidenceIdentifier`(8자 이상, 메시지 ID·서명블록 해시 등) — **조직별 증빙 식별자**. 같은 교정본이라도 조직별 식별자가 서로 다르면(다른 승인 메시지·서명 구분) 인정, **동일 식별자의 교차조직 사용은 차단** (422 EVIDENCE_DUPLICATE_REGISTRATION)
- issuerEntity·이름 텍스트만으로 소속 확정 금지 — 기록 항목: 증빙 출처(evidenceSource)·실제 승인자명(externalApproverName, 원문 그대로)·승인 시각·대상 교정 버전·조직별 식별자
- 감사 afterState에 evidenceIdentifier 기록 / 마이그레이션 0014: artwork_approval_events.evidence_identifier (append-only 트리거 유지)
- 승인 순서 무관 규칙 유지 (T-09/T-10 재검증)

### S3 — 감사 응답 역할별 필터 (allowlist) ✅
- 신규 `apps/api/src/audit-view.ts`(99줄): `buildAuditViewForRole` 단일 정책 함수
- admin=전체 / staff=허가 프로젝트 + **상태성 키만** (id·status·state·code·name·verificationStatus·deliveryKind·confirmationState) + requestMetadata는 operation 키만 / viewer=요약만(action·entityType·entityId·시각·행위자)
- 금액·원가·구매금액·스냅샷·발신자·수신자·첨부 데이터는 staff·viewer 응답에서 제외 — **원본 감사 로그 불변** (append-only 유지)
- staff는 여전히 이벤트 수는 동일(존재 자체는 보임) — viewer는 요약만

### S4 — 세븐 PO 진위 게이트 강화 ✅
- 전이 API의 약한 게이트(evaluateSevenPoVerificationGate=공식등록일만)를 **강한 게이트(evaluateSevenPoPrecedenceGate=등록일+verificationStatus verified+reviewPending)로 교체** — 체크리스트 미검증 PO의 SEVEN_PO_VERIFIED 전이 차단
- maker PO 생성·교정 등록·납품 경로도 precedence 게이트 통과 경로만 허용하도록 점검 (T-06 날짜 분리 규칙 유지)

### S5 — 회귀 테스트 ✅
- tests/m7-security/ 신규 855줄: (a) 제조사 체인 일반 전이 차단 (b) 동일 증빙·동일 조직 중복 거부 (c) 교차조직 동일 식별자 거부 (d) staff/viewer 감사 필터 (e) 체크리스트 미검증 전이 차단 — **수정 전 재현(실패 확인) → 수정 후 차단(통과)** 절차 준수
- 기존 테스트 중 취약 동작 가정분 수정: m1(43줄)·m3(5)·m4(5)·m5(75)

## 3. 커밋·파일

| 커밋 | 내용 |
|---|---|
| `b2a61b5` | S1~S4 + m7-security 테스트 (17파일, +1314/-40) |
| `97d4da7` | m7-security 테스트 스코프 수리 + S3 필터 확정 (+21) |

주요 파일: apps/api/src/app.ts(+162), apps/api/src/audit-view.ts(신규 99), packages/core/src/{maker-po,approvals,documents,state-machine}.ts, tests/m7-security/(2파일 855), migration 0014, apps/web 8파일(import·config·타입 수리 — 이전 커밋 dfe4d50)

## 4. 재현 절차 (독립 재검토용)

```bash
cd /root/company-auto/kanei-crm-mvp
export DATABASE_URL="postgresql://kanei:<PW>@127.0.0.1:5434/kanei_crm_mvp_test"
npx drizzle-kit migrate && npx vitest run   # 146/146 기대
# 개별 취약점 재현: npx vitest run tests/m7-security/ -t '<테스트명>'
# 3000 UI: http://localhost:3000 (ceo_test / <ROTATED — see operator>)
```

## 5. 미해결 위험·남은 과제

1. **S5 제조사 운영자 UI** — 이번 범위 제외 (API 전용 상태). 별도 위임 필요
2. smoke-ui 재실행 시 **새 프로젝트 ID** 필요 (같은 프로젝트 반복 실행 시 상태 충돌) — 스크립트에 자동 생성 단계 추가 권장
3. §5.10 진본 체크리스트 표본 2~3건 — 실무 자료 대기 (운영 전환 조건)
4. NAS 정식 배포 — 4조건 점검 보고서 기반 대표 판단 대기 (백업 체계 확립 전 배포 불가)
5. evidenceIdentifier의 실제 형식 표준(메시지 ID vs 서명블록 해시)은 운영 표본으로 확정 권장
