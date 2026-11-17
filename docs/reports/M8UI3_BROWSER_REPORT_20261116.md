# M8-UI3 최종 보고서 (브라우저 실측 포함) — 클라이언트 예외 수리 + 案件選択 드롭다운 (2026-11-16)

최종 커밋: **`1f70cec`** (master push 완료, 원격 실측 `1f70cec` 재확인 — d37bc41 수리·보고서 포함)
검증: 격리 test DB + 합성 데이터만 + **playwright(Chromium 헤드리스) 실제 브라우저 실측**. main DB 무변경.

## 1. 최종 검증

| 항목 | 결과 |
|---|---|
| 전체 테스트 (test DB, master merge 상태) | ✅ **243/243 PASS** (기존 239 + projects-list 권한 테스트 4) |
| build·타입 (apps/web) | ✅ — **재빌드·재기동 완료 (localhost:3000 반영)** |
| GitHub push | ✅ `d37bc41` + docs `1f70cec` 원격 실측 |

## 2. 브라우저 실측 (playwright / Chromium 헤드리스 — 대표 요구 「실제 브라우저」 충족)

| 검증 | 실측 결과 |
|---|---|
| 클라이언트 예외 재현 | **미재현** — d37bc41 수리 후 현재 빌드에서 / · /maker-po · /documents · /orders · /approvals 전부 **appError=false, 콘솔·페이지 에러 0건** (수리 전 빌드에서 대표님이 목격한 것으로 추정 — d37bc41의 error.tsx·가드 수리로 해소 추정, 이전 빌드는 보존돼 있지 않아 직접 비교 불가 — 이 점 명시) |
| **案件選択 드롭다운** | ✅ **8옵션 렌더링 실측** (「（選択なし…）」+ DEMO-OPER3 5 + TEST-F1 2, code（name）형식) |
| **프로젝트 선택 동작** | ✅ selectOption → 「案件 …を選択しました」+ 워크스페이스 렌더 + 현재 案件ID 표시 |
| **G6 결제조건 표시** | ✅ 決済条件（G6）의 상태·차단 사유 카드 렌더 (prepaid／on_delivery／undetermined 3종, 「入金確認ではない」 문구) |
| **차단 사유·다음 액션 안내** | ✅ 「作成できる発注（MAKER_PO_READY）はまだありません／ブロック理由: 二重承認不足…／次のアクション: 承認画面で…」 실측 |
| **권한 안내** | ✅ 「作成は代表者だけです（担当者・閲覧者は作成できません）」 |
| **③手動送信記録 폼** | ✅ **APPROVED_FOR_MANUAL_SEND 발주서에서 렌더링 실측** — 送信証跡 텍스트 6건·**EML 수용 파일 인풋 1개**·EML 안내 문구(Thunderbird 원본 필요·PDF/스크린샷 불가) 표시 |

## 3. 미검증 항목 (명시 — 대표 제공 요청)

1. **브라우저 폼에서의 실제 EML 업로드 제출** — 실제 Thunderbird 원본 .eml이 필요 (합성 EML은 API 레벨 E2E로 실측 완료). 대표님이 데모 화면에서 등록 시 이상 동작이 있으면 콘솔 로그·화면 캡처를 공유 주시면 대응합니다.
2. 브라우저 Console 상세 (내 도구는 pageerror·console.error 캡처만 가능 — 네트워크 탭 상세는 대표님 DevTools 확인 필요 시 공유 요청)

## 4. 대표님 체크리스트 (localhost:3000 / arwg / rlarjsdnd)

1. 재접속(Ctrl+F5) → Application error 없음 + **案件選択이 드롭다운**
2. 드롭다운에서 「デモOPER3案件（CEO確認用）」 선택 → /maker-po
3. APPROVED_FOR_MANUAL_SEND 발주서 카드의 **③手動送信記録** → 원본 .eml 선택 + sentAt → 등록
   - 헤더·수신처·첨부 일치 → VERIFIED 진행 / 불일치 → 手動検証待ち → admin 확인 폼으로 확정
4. 受領フォーム 등록 → 生産中 전이 확인

## 5. 대기

§5.10 표본 2~3건 · evidenceIdentifier 기준 확정 · 브라우저 확인 후 합성 계정 정리 · **NAS 배포·실고객 데이터는 별도 승인 대기**
