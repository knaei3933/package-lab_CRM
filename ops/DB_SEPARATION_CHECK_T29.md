# T-29 — 개발/운영 DB 분리 점검 (2026-11-19 초안)

사용 규칙: 배포 승인 전 각 항목을 실측 값·증거 경로와 함께 기록한다. 접속 URL·비밀번호는 기록하지 않는다.

| # | 점검 | 요구 | 방법 | 현재 상태 | 증거/비고 |
|---|---|---|---|---|---|
| 1 | URL 분리 | 운영 `.env`와 개발 `.env` 분리, 기본 URL 없음 | 파일 권한/키 목록 grep | ✅ repo `.env`는 커밋 금지, `DATABASE_URL` 기본 fallback 없음 | `apps/api/src/env.ts`, `.gitignore` |
| 2 | test DB 가드 | vitest setup이 `kanei_crm_mvp_test`만 허용 | setup 강제 실패 시험 | ✅ | `tests/setup.ts` |
| 3 | main 보호 | 백필/운영 스크립트가 main 명시 승인 플래그 없이 차단 | scratch 재현 | ✅ 백필 가드 | `scripts/backfill-film-line-audit-events-20261119.sql` |
| 4 | bind 분리 | 개발 API/Web loopback; 운영은 reverse proxy 경유 | `ss -ltnp`, compose | ✅ API 기본 `127.0.0.1`; Web는 별도 워커 작업 필요 | `apps/api/src/env.ts`, `docker-compose.prod.yml` |
| 5 | credential 처리 | 운영 비밀은 repo/env commit 금지, secret manager/file 사용 | diff scan | ✅ CI scanner 초안 | `scripts/secret-scan.mjs`, `.github/workflows/ci.yml` |
| 6 | audit append-only | update/delete trigger 활성 | `pg_trigger` | ✅ migration 0001/scratch test | `packages/db/drizzle/0001_audit_immutability.sql` |
| 7 | 문서 저장소 | 필수 경로, no symlink, 0700/0600 | startup validation | ✅ | `apps/api/src/document-storage.ts` |
| 8 | 재해복구 | 암호화 백업+격리 restore T-30 | backup/restore script | 🟡 산출물 완료, 실측 T-30은 배포 준비 단계에서 실행 | `scripts/backup-kanei.sh`, `scripts/restore-verification.sh` |
| 9 | Docker Desktop 재발 방지 | 자동 시작/절전 설정 확인, prod는 service manager 사용 | Windows 설정/NAS 배포 시 | 🟡 11-18 원인 미확정; 운영은 컨테이너 restart policy 초안 | `docker-compose.prod.yml` |
| 10 | CI 게이트 | typecheck+tests+secret scan | CI 로그 | 🟡 초안 커밋, branch protection는 GitHub 설정 필요 | `.github/workflows/ci.yml` |

## 배포 승인 전 남은 실측

1. 운영 secret을 repo 밖에서 주입하고 `docker compose --profile production config`의 마스킹 확인.
2. backup 생성→scratch restore→T-30 JSON 저장(RPO/RTO).
3. GitHub main branch protection: 직접 push 금지, PR + CI required.
4. 운영 API/Web/Caddy 헬스와 로그 저장 경로 확정.
