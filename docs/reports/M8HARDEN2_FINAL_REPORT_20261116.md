# M8-HARDEN2 최종 보고서 — EML 첨부 매칭·취소 수락 게이트·수동 확인 플로우 (2026-11-16)

최종 커밋: **`5934fc3`** (master push 완료, 원격 실측)
구현 체인: `aa9faec`(HARDEN2 구현 16파일+1537) + `5934fc3`(권한 가드·통합 정리 16파일+1828) — 동일 목적의 병렬 구현을 통합 정산 (중복 테스트 정리로 최종 239 테스트)
검증: 격리 test DB + 합성 데이터만. main DB는 마이그레이션(추가만) 외 무변경.

## 1. 최종 검증

| 항목 | 결과 |
|---|---|
| 전체 테스트 (test DB, master merge 상태) | ✅ **239/239 PASS** (19파일 — HARDEN2 FIX 1·2·3 회귀 9건 포함) |
| build·타입 (apps/web) | ✅ Compiled successfully |
| **DB 무결성 검사** | ✅ 부분 유니크 인덱스 `maker_purchase_orders_active_order_unique` 존재 / 고아 이벤트 행 0건 / 마이그레이션 0019 적용 (ERROR 0) |
| GitHub push | ✅ `ad8761b..5934fc3` 원격 실측 |
| 서비스 | ✅ localhost:3000 200, API health ok |

과정 중 실패: 3건 (A3 복구 테스트의 텍스트 send 잔존·C1 null 첨부 TypeError·취소 수락 코드 명칭) → 전부 테스트-계약 정렬로 수리.

## 2. 수정 전 재현 → 수정 후 차단

### 1) EML 첨부파일 검증 강화
- **수정 전**: 헤더만 통과하면 첨부 불일치여도 VERIFIED 가능 (FINDING C1 후속 재현)
- **수정 후**: **첨부 sha256 ≥ 1건이 승인 산출물(발주서·교정본 스냅샷) 해시와 일치해야만 VERIFIED** / 첨부 없음·전부 불일치·링크만 → 각각 사유(`attachment_missing`·`attachment_hash_mismatch`·`attachment_link_only`)를 이벤트에 기록한 PENDING_MANUAL_VERIFICATION / PDF 변환본도 수동 대기. 재현 테스트: 올바른 헤더+잘못된 첨부 → PENDING+사유 표시 / 정상 첨부 → VERIFIED / 무첨부·링크 변형 → 각 사유

### 2) 발송 후 취소·재발주 안전성
- **수정 전**: 발주서 취소가 발송 이력과 무관하게 재발주를 허용 (발송된 종이와 신규 종이가 동시에 생산 가능)
- **수정 후**: ① **내부 취소(미발송)** — 즉시 재발주 가능 ② **발송된 발주서 취소** — **제조사 취소 수락 증빙(MAKER_CANCELLATION_ACKNOWLEDGED, append-only + 감사행)이 기록될 때까지 신규 발주서 생성 422 `MAKER_PO_CANCELLATION_ACK_REQUIRED`** (pending PO id 안내) — 수락 기록 후 신규 생성 가능 ③ 이력 전부 보존 (삭제 없음) ④ **권한 버그 발견·수리**: staff가 취소 수락을 기록할 수 있던 문제 → **admin 전용 강제** (staff 403·admin 201 단정 추가)
- 회귀 테스트: 내부 취소→재발주 허용 / 발송 후 취소→수락 전 재발주 거부→수락 후 허용 / 동시 생산 불가 단정 / admin 전용·once

### 3) 수동 발송 확인 이후 상태 전이
- **검증 결과**: PENDING_MANUAL_VERIFICATION 발송 증빙을 admin이 confirmed 처리(0017 패턴의 불변 이벤트)하면 **수락 단계가 VERIFIED와 동일하게 개방**됨 — PENDING 상태에서는 수락 계속 차단 (양방향 테스트 실측)
- 이중 처리: 동일 이벤트 재확인은 기존 0017 기계의 동작을 따름 (보고서에 명시) — 재발송은 M8-FAIL B 차단 유지
- **문서화**: EML 헤더 검증 VERIFIED = "이메일 내용·수신처 확인" — **실제 송달 완료 단정 아님** (송달 근거는 수동 확인으로만 확정)

## 3. 대기 (다음 단계 — 추가 기능 개발 중단 상태)

1. **대표자 브라우저 F1 전체 업무 검증** — 데모 준비 완료 (project `01a1dc79-0a1d-7390-bc0c-e074a7f0ac44` / login `admin_composite`) — AI 측 클릭 미검증, 대표님 직접 확인 대기
2. §5.10 표본 2~3건 + evidenceIdentifier 기준 확정 (기준안 제시됨)
3. 브라우저 확인 후 합성 계정 제거 절차 (9계정 실측 목록 보유)
4. NAS 정식 배포·실고객 데이터 — **여전히 미승인, 별도 승인 대기**
