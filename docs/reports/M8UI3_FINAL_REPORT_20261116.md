# M8-UI3 최종 보고서 — 클라이언트 예외 수리 + 案件選択 드롭다운 전환 (2026-11-16)

최종 커밋: **`d37bc41`** (master push 완료, 원격 실측)
검증: 격리 test DB + SSR HTML 실측. main DB 무변경.

## 1. 최종 검증

| 항목 | 결과 |
|---|---|
| 전체 테스트 (test DB, master merge 상태) | ✅ **243/243 PASS** (기존 239 + 신규 4: projects-list 권한별 가시성) |
| build·타입 (apps/web) | ✅ Compiled successfully — **재빌드·재기동 완료** |
| **SSR HTML 실측** | ✅ 루트 HTML에 "Application error" 문구 **0건** · **`<select name="projectId">` 드롭다운 렌더링 확인** (420px) |
| 화면 상태 | ✅ / · /maker-po · /documents · /orders · /approvals 전부 200 |
| GitHub push | ✅ `9afb634..d37bc41` 원격 실측 |

## 2. 수리 내역

### 1) 클라이언트 예외 (긴급)
- 원인: M8-UI2b의 maker-po 화면 대형 변경에서 데이터 부재 시 undefined 접근 등 런타임 렌더 크래시
- 수리: page.tsx·fields.tsx 최소 가드 (+14/-11) — M8-UI2b 폼 기능 유지

### 2) 案件選択 드롭다운 (대표 요청)
- **GET /api/projects 신설**: admin=전체, staff·viewer=할당된 프로젝트만 (기존 권한 모델 준수, project_assignments 연동) — 반환: id·code·name·status
- 상단 「案件の選択」을 **드롭다운(select, code+name 표시)**으로 전환 — 기존 UUID 직접 입력은 하단 폴백으로 유지
- 권한별 가시성 테스트 신규 추가 (tests/api/m8-ui3-projects-list.test.ts, 150줄)

## 3. 대표님 재확인 절차

1. localhost:3000 **재접속** (브라우저 캐시 무시: Ctrl+F5 권장) — Application error 사라짐
2. 로그인 `arwg` / `rlarjsdnd`
3. 상단 **案件の選択이 드롭다운**으로 표시 — 목록에서 합성 F1 프로젝트(合成F1系) 선택 가능
4. /maker-po → 送信証跡フォーム(EML) → 受領 → 生産中 흐름 재확인

## 4. 대기

- §5.10 표본 2~3건 + evidenceIdentifier 기준 확정
- 브라우저 검증 완료 후 합성 계정 정리
- NAS 정식 배포·실고객 데이터 — **여전히 미승인, 별도 승인 대기**
- 잔여 기술 메모: B2 생성 게이트 BEFORE INSERT 트리거 견고화 (필요 시 별도 승인)
