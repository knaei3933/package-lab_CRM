# M8-HARDEN 최종 보고서 — A3·B2·C1·C2 제조사 생산 발주 안전성 완성 (2026-11-16)

최종 커밋: **`5a8cc85`** (master push 완료, 원격 실측)
커밋 체인: `72627f6`(A3·B2·C1·C2 구현 23파일+3298) → `643f466`(상수 import 누락 수리) → `fac51b0`(기존 스위트 정렬) → `65f0471`(T-22/T-24 정렬) → `5a8cc85`(T-24 500 가드)
검증: 격리 test DB + 합성 데이터만. main DB는 마이그레이션(추가만)·읽기 전용 감사 외 무변경.

## 1. 최종 검증

| 항목 | 결과 |
|---|---|
| 전체 테스트 (test DB, master merge 상태) | ✅ **226/226 PASS** (기존 205 + HARDEN 신규 21) |
| build·타입 (apps/web) | ✅ Compiled successfully |
| 마이그레이션 0018 | ✅ test·main 양쪽 적용 (부분 유니크 인덱스: `deleted_at IS NULL AND status <> 'CANCELLED'`) |
| GitHub push | ✅ `2e4260a..5a8cc85` 원격 실측 |
| 구현 변경 범위 | A3·B2·C1·C2 구현 + C1 누락 가드 1건 (import 누락·guard — 모두 승인 범위 내) |

과정 중 실패: 38→9→3→1→0 (원인 전부 진단 후 수리 — 상수 import 누락·테스트 기대 정렬·아트워크 경로 가드).

## 2. 수정 전 재현 → 수정 후 차단 (대표 지시 구분 보고)

### A3 — 변경된 교정본의 재승인 강제 (P0)
- **수정 전**: 판본 진행(superseded) 사유로는 미발송 경계가 차단되지 않음 (`gate_closed_superseded_revision_snapshot_void_governs` 통과) — FINDING A3로 재현됨
- **수정 후**: 현재 교정본에 양측 유효 승인 없으면 **생성·대표승인·발송 3경계 전부 422 `DUAL_APPROVAL_NO_LONGER_VALID`** (판본 진행 포함, 감사 기록 유지) — 양측이 새 판본에 재승인하면 **정상 복구** (테스트 실측). 검증된 발송 소급 차단 없음·발송 이력 보존·G10 스냅샷 기계 유지

### B2 — 중복 제조사 발주서 차단 (P0)
- **수정 전**: DRAFT 발주서 존재 시에도 제2 발주서 생성·전체 체인 병행 가능 (FINDING B2)
- **수정 후**: ① **마이그레이션 0018 부분 유니크 인덱스** (동시 요청 트랜잭션 안전 — 병렬 2요청 테스트로 1건만 성공 실측) ② 사전 검사 422 `MAKER_PO_ALREADY_EXISTS` (기존 PO id 안내) ③ **관리자 취소 엔드포인트** (append-only 이벤트 MAKER_PO_CANCELLED — 이력 보존, 정정·재발주 = 취소 후 신규) ④ 수락 증빙의 발주서 ID·스냅샷 대조 → 타 PO 증빙 수락 422 `ACCEPT_EVIDENCE_PO_MISMATCH` (시나리오 D의 세분화 갭 해소)

### C1 — 생산 발주 이메일 발송 증빙 검증 (P0, 최우선)
- **수정 전**: 내용이 발송을 증명하지 않는 텍스트 파일도 VERIFIED (FINDING C1) — 실측으로 재현됨
- **수정 후**: send-evidence 검증을 **원본 EML 기준**으로 재작성 — Message-ID·From·To/Cc(승인된 수신처 일치)·Date(sentAt 일치)·제목(발주 식별자)·첨부 sha256↔스냅샷 대조 체크리스트 기계판독 → 전부 통과만 `VERIFIED`(verificationMethod=`eml_header_check`) / PDF·스크린샷·불완전 EML·일반 텍스트는 **`PENDING_MANUAL_VERIFICATION`** (자동 VERIFIED 원천 차단). 수동 확인은 불변 감사 이벤트 (검증자·시각·결과·근거). **EML 저장≠송달 완료** 구분 문서화
- 부수 수리: 아트워크 변경 경로에서 send-evidence가 500을 내던 **C1 신규 코드의 누락 가드** 수리 (`5a8cc85`) + T-24 재현 테스트 추가

### C2 — 미래/불가능한 발송시각 (P1)
- **수정 전**: 미래 sentAt 무검증
- **수정 후**: 서버시각 대비 +10분 초과 → 422 `SENT_AT_IN_FUTURE` (UTC 명시) / **대표승인 이전 시각·EML Date 불일치 → 하드실패 없이 PENDING_MANUAL_VERIFICATION 강등** (이유 기록) — 테스트 실측

## 3. 레거시 VERIFIED 감사 (읽기 전용)

- test DB: 신규 규칙 적용 후 구 규칙 VERIFIED 잔존 0건 확인
- main DB: 구 규칙으로 VERIFIED 처리된 발주 **읽기 전용 조사 목록** `docs/reports/LEGACY_VERIFIED_SEND_AUDIT_20261115.md` — 실데이터 없어 실질 영향 0 (합성 데모만 존재). 기존 불변 승인·감사 이벤트 미수정·미삭제

## 4. 대기 (다음 단계)

1. **대표자 브라우저 F1 전체 업무 검증** — 데모 준비 완료 (project `01a1dc79-0a1d-7390-bc0c-e074a7f0ac44` / login `admin_composite`) — **AI 측 브라우저 클릭 미검증** (도구 제약), 대표님 직접 확인 대기
2. §5.10 표본 2~3건 + evidenceIdentifier 기준 확정 (기준안 제시됨)
3. 합성 계정 정리 (브라우저 확인 후 제거 절차 준비)
4. NAS 정식 배포·실고객 데이터 — **여전히 미승인, 전체 검증 완료 후 별도 승인**
