# M8-UI2 최종 보고서 — 백엔드 기능의 운영자 UI 연결 보완 (2026-11-16)

최종 커밋: **`969879b`** (master push 완료, 원격 실측)
검증: 격리 test DB + 합성 데이터만. main DB는 마이그레이션·데모 시딩(이전 승인분) 외 무변경.

## 1. 최종 검증

| 항목 | 결과 |
|---|---|
| 전체 테스트 (test DB, master merge 상태) | ✅ **239/239 PASS** |
| build·타입 (apps/web) | ✅ Compiled successfully — **재빌드·재기동 완료 (localhost:3000 반영)** |
| GitHub push | ✅ `87e59fd..969879b` 원격 실측 |
| 서비스 | ✅ / · /maker-po · /documents · /orders 전부 200 |

## 2. UI 연결 보완 내역 (7파일 +625)

| 지시 | 구현 |
|---|---|
| 1. /documents EML 인식 | 업로드 폼에 `send_evidence` 타입 + `message/rfc822`·`.eml` 수용 추가 (DocumentUploadForm·vocabulary) |
| 2. /maker-po EML 등록 | **신규 MakerPoSendEvidenceForm** — `.eml` 파일 업로드 + sentAt 입력, API 계약(EML 기반)과 정확히 일치. 발송 증빙 등록을 화면에서 완료 가능 |
| 3. admin 처리 화면 | send-evidence `PENDING_MANUAL_VERIFICATION`의 **admin 수동 확인 폼** (0017 불변 이벤트 연결) + **취소 수락(MAKER_CANCELLATION_ACKNOWLEDGED) 기록 폼** + 활성 발주서의 **취소 버튼** (발송 유무 구분 표시) — 조사 결과 누락분만 추가 |
| 4. 데모 준비 | **데모 PO가 `APPROVED_FOR_MANUAL_SEND`(발송 대기) 상태로 확인 실측** — arwg 계정으로 바로 브라우저 검증 가능 |

## 3. 조사 결과 (기존 vs 누락)

- 기존에 있던 것: 발주서 생성·대표 승인 폼, 감사 대시보드, 결제조건 표시
- 이번에 추가: EML 발송 증빙 폼(신규), 수동 확인 폼, 취소 수락 폼, 취소 버튼, EML 문서 인식
- apps/api 변경: **없음** (UI 연결만 — 지시 준수)

## 4. 대표님 브라우저 체크리스트 (localhost:3000 / arwg / rlarjsdnd)

1. **/maker-po** → 데모 발주서(`01a1dc79-0c1b-72e6-959f-ad6b2f03cf77`, APPROVED_FOR_MANUAL_SEND) 행에서 **送信証跡フォーム** 열기
2. 실제 Thunderbird 보낸 편지에서 내보낸 **원본 .eml** 파일 선택 + sentAt 입력 → 등록
   - 헤더·수신처·제목·첨부 해시가 모두 일치 → VERIFIED로 진행
   - 불일치·누락 시 「手動検証待ち」 표시 → **admin 확인 폼**(검증자·시각·결과·근거)으로 확정 → 진행 개방
3. **受領フォーム**에서 수락 증빙 등록 → **生産中** 상태 전이 확인
4. (선택) REVOKE 기록 시 같은 화면의 경계 조작이 422 차단 표시로 막히는지 확인
5. **/documents** → .eml 파일이 업로드 목록에서 정상 표시되는지 확인

⚠️ 위 1~5는 **AI 측 미검증** (브라우저 도구가 내부 주소 접속 차단) — 준비만 완료된 상태이며 대표님 직접 확인 대기.

## 5. 대기

- §5.10 표본 2~3건 + evidenceIdentifier 기준 확정
- 브라우저 확인 후 합성 계정(arwg 포함) 정리 절차
- NAS 정식 배포·실고객 데이터 — **여전히 미승인, 별도 승인 대기**
- 잔여 기술 메모: B2 생성 게이트는 앱 체크 + 0018 인덱스 이중 방지 (BEFORE INSERT 트리거 견고화는 미적용 — 필요 시 별도 승인)
