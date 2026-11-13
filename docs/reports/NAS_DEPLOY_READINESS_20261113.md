# KANEI CRM MVP — NAS 배포 4조건 점검 (읽기 전용 실측)
작성: 2026-11-13 (점검자: Hermes AI 비서, 변경 조치 없음)

## 실측 결과

| 조건 | 실측 | 판정 |
|---|---|---|
| ① 도메인 | Cloudflare Tunnel `chatbot-package-lab` 운영 중 (nas-chatbot-cloudflared-existing, healthy) | ✅ 인프라 있음 — CRM용 서브도메인(예: crm.package-lab.com) 추가는 Cloudflare에서 가능 |
| ② 역방향 프록시 | Caddy 2.10.2 (nas-chatbot-relay, healthy) 실행 중 | ✅ 존재 — Caddyfile에 CRM 라우트 추가 필요 |
| ③ 백업 | AI 사용자 crontab 비어 있음, pg_dump 스크립트 미발견. D04(RPO 24h/RTO 4h) 충족 흔적 SSH에서 미확인 (NAS UI 백업 설정은 별도) | ⚠️ 확인 필요 — Postgres 볼륨 백업 체계 수립 전 배포 불가 |
| ④ 감사 보존 | audit_events append-only(트리거+프록시) 구현 완료, 마이그레이션 0001/0013 | ✅ 코드 측 완료 — 백업 체계에 DB 포함 필요 |

## 리소스 실측

- RAM: 7.5GiB 중 가용 791MiB — **여유 얇음** (MVP 3컨테이너: Next.js+Hono+Postgres, 최소 700MB~1GB 추가 필요)
- 디스크: 7.3T 중 133G 사용(2%) — 여유 풍부
- 기존 CRM(src-web 3000/src-api 3001)과 포트 충돌 없게 신규 포트 지정 필요 (예: web 3080/api 3081)

## 배포 시나리오 옵션

| 옵션 | 내용 | 비고 |
|---|---|---|
| A. NAS 경량 배포 | api+postgres만, web은 사용 안 함 또는 api 단독 서비스 | RAM 여유 시 가능, 컨테이너 정리 선행 권장 |
| B. WSL 유지 + NAS 백업 원장 | 개발기에서 서비스, NAS에 야간 pg_dump 백업 | 리소스 무부담, 백업만 NAS 역할 |
| C. NAS RAM 증설 후 정식 배포 | 하드웨어 조치 | 가장 안정적, 비용 발생 |

## 결론

기술 인프라(도메인·프록시·감사 설계)는 준비 완료. 배포 전 필수 과제는 ③ 백업 체계 확립과 런타임 리소스 확보. 대표님의 옵션 선택 후 진행.
