# 金井貿易 AI CRM MVP — M0~M5 구현 완료 통합 보고서

작성: 2026-11-13 09:21 JST / 검증자: Hermes AI 비서 (대표 승인 하 자동 연속 개발)

## 1. 최종 결과

| 항목 | 결과 |
|---|---|
| 테스트 | **125/125 전부 통과** (11 파일, 8.3초) |
| 구현 범위 | 설계서 v1.1 (§1 DS-01~13, §5 데이터모델, §6 상태전이, §7 G0~G10, §10 T-01~36) |
| 저장소 | https://github.com/knaei3933/package-lab_CRM (origin/master = a509eaa) |
| 구조 | apps/web(Next.js 15) · apps/api(Hono) · packages/core(게이트·상태기계) · packages/db(Drizzle, 마이그레이션 0000~0013) · tests(m0~m5) |

## 2. 커밋 히스토리 (17개)

| 커밋 | 내용 | 실행자 |
|---|---|---|
| b035b95 | 워크스페이스 초기화 | - |
| e7cf01f | M0 기반(F1 단일 원장·감사 불변 트리거) | Codex/GLM |
| 84b368e+2466149 | M1 거래 구조 + 충전 납품 readiness 수정 | Claude GLM |
| b6aef11 | M2 문서 접수·세븐 PO 선행 | Claude GLM |
| 7da8ab5 | M3 교정 리비전·순서 무관 이중 승인 | Claude GLM |
| 563ff6b | M4 메이커 발주·수동 발송 게이트 | Claude GLM |
| d9a2147~dfe5e1a | append-only 이중 방어(DB 트리거+클라이언트 프록시) 등 5건 수정 | Claude GLM |
| 0b63b5f | M5 납품 완료·입고 간주(수동)·일본어 상태 표기·감사 API | Claude GLM |
| ace7b48 | or import·readiness 규칙·감사 접근 제어 | Claude GLM |
| 93dffc2 | 감사 조회 구조 개편(audit_events.project_id — 18개 서브쿼리 제거) | Claude GLM |
| 381a022~a509eaa | 테스트 race 수정 3건 (**대표 승인 A안**) | Hermes 직접 |

## 3. 설계 원칙 준수 (검증 완료)

- F1 단일 원장: film_supply_orders만 (T-01)
- 수수료 40% · 계산은 검증 증빙 완비 시에만 (T-36)
- 승인 순서 무관 이중 승인 (T-07~13)
- 세븐 PDF 발주 선행·진본 체크리스트 §5.10 (T-18~19)
- 승인·이벤트 테이블 append-only: DB 트리거 + 클라이언트 프록시 이중 방어
- CRM은 발송하지 않고 증빙만 원장화 (D01)

## 4. 대표 결정 기록

- 별도 앱 유지 재확정 / kanei-autonomous-verified-iterations 삭제 / 자동 연속 진행
- 2026-11-13 A안 승인: 테스트 코드의 await 누락(race) 5곳·스코프 오류 1곳 수정 — 검증 의도 불변

## 5. 남은 과제 (MVP 이후)

1. **NAS 배포 4조건** 충족 시 배포 (도메인·역방향 프록시·백업·감사 보존)
2. **무통보 입고 대기 기간** 확정 (§13-1 — 수동 기록 방식으로 구현됨, 자동 타이머 없음)
3. **§5.10 진본 체크리스트 표본 2~3건** 확보 후 운영 전환
4. 이메일 자동화·AI 보조·수수료 자동계산은 후속 단계

## 6. 실행 방법

```bash
cd /root/company-auto/kanei-crm-mvp
npm install --include=dev && cp .env.example .env  # DB 접속 설정
npx drizzle-kit migrate && npx vitest run           # 125/125
```
