# R2 준비물 결과 — 2026-11-19

이 문서는 산출물·로컬 검증 결과만 기록한다. NAS 접속, 실배포, 운영 DB 변경, push는 하지 않았다.

## 산출물

| 항목 | 경로 | 상태 |
|---|---|---|
| R2-1 백업 | `scripts/backup-kanei.sh` | DB custom dump + 문서 tar + manifest + GPG 암호화 + retention + optional alert hook |
| R2-2 격리 복원시험 | `scripts/restore-verification.sh`, `scripts/restore-verification.mjs`, `T30_RESTORE_REPORT.json` | scratch 전용 가드, 스키마/감사/문서 해시·참조·append-only 잠금 검증, RPO/RTO 기록 |
| R2-3 DB 분리 점검 | `ops/DB_SEPARATION_CHECK_T29.md` | 10항목 체크리스트, 현재 상태와 배포 전 실측 항목 명시 |
| R2-4 컨테이너 | `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.prod.yml`, `ops/Caddyfile` | API/Web 이미지, prod profile, 헬스체크, Caddy TLS/reverse proxy 초안 |
| R2-5 CI | `.github/workflows/ci.yml`, `scripts/secret-scan.mjs` | typecheck + 전체 vitest + category secret scan + web build |
| R2-6 Caddy | `ops/Caddyfile` | `PUBLIC_ORIGIN` 기반 reverse proxy, HSTS 등 보안 헤더 초안 |

## 로컬 검증

| 검증 | 결과 | 증거 |
|---|---|---|
| T-30 restore | passed=true; DB tables 24, audit 1, document version 1, 문서 hash match 1/0 fail, audit update/delete trigger 존재, RTO 약 1초 | `/root/company-auto/demo-eml/server-r2-preparation/T30_RESTORE_REPORT.json`, `t30-backup.log`, `t30-restore.log` |
| API image build | passed | `docker-build-api.log`, `docker-image-api.txt` |
| Web image build | passed | `docker-build-web.log`, `docker-image-web.txt` |
| compose production config | parsed; secret는 evidence에서 redact | `compose-config-resolved.txt`, `compose-config-check.txt` |
| secret scan | 0 hits | `working-tree-secret-scan-empty-range.json` |
| 비웹 회귀 | 33 files / 399 tests | `nonweb-serial-vitest-final.log`, `typecheck-final.log` |

## 배포 승인 전 남은 항목

1. 운영 secret 주입 후 실제 compose up은 하지 않음.
2. NAS 접속·포트 개방·Caddy DNS/TLS 실발급은 별도 승인.
3. GitHub main protection 및 required CI는 GitHub 설정 작업.
4. T-30의 운영 규모 실측은 승인된 백업 세트로 재실행.
