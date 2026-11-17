# M8-HARDEN3 완료 보고 — 0020 B2 생성 게이트 DB 레벨 트리거 (2026-11-17)

## 0. 제약 준수 요약

| 제약 | 준수 |
|---|---|
| main DB(`kanei_crm_mvp`) 접속 금지 | ✅ 접속 0회. 모든 psql은 `-d postgres`(유지보수 DB) 또는 `-d kanei_crm_mvp_test`만 사용 |
| test DB 전용 적용·검증 (5434) | ✅ `kanei_crm_mvp_test`에만 적용. DATABASE_URL = DB명 교체 + `kanei_crm_mvp_test` 문자열 가드(테스트 파일 상단에 throw 가드) |
| 수정 범위: 마이그레이션 SQL·저널·트리거 테스트만 | ✅ git status: 저널 +7행, 신규 0020 SQL, 신규 tests/m8-harden3/. apps/web·seed.ts·reseed·layout.tsx 미접촉 |
| 커밋·푸시 금지 (working tree만) | ✅ 커밋 0. step-0 푸시는 작업 시작 전 기존 master 커밋(31e683b, 0694f6d)만 반영 |
| 실메일·실제 제조사 발주·NAS | ✅ 미접촉 |
| 데모 계정 비밀번호 게재 금지 | ✅ 본 보고서에 비밀번호 없음 |

## 1. [0단계] master → origin 푸시

`git push origin master` → `20f0148..0694f6d master -> master` — **성공**.
20f0148은 이미 origin에 존재했고, 31e683b·0694f6d 2개 커밋이 새로 반영. 3개 커밋 모두 origin 반영 완료.

## 2. B2 규칙 (0018에서 파악한 규칙)

한 film 공급 주문당 활성 발주서 1건. 활성 집합 = `deleted_at IS NULL AND status <> 'CANCELLED'`.
행은 삭제되지 않고(CANCELLED가 유일한 탈출, 이력 보존), SEND_UNVERIFIED도 슬롯을 점유하며(T-21),
soft-delete는 0018이 예어한 미래 탈출 경로. 대체는 취소(UPDATE) 후 신규 생성(INSERT).

## 3. 0018 인덱스 vs 0020 트리거 대조

| 항목 | 0018 부분 유니크 인덱스 | 0020 BEFORE INSERT 트리거 |
|---|---|---|
| 객체 | `maker_purchase_orders_active_order_unique` (btree, partial) | `maker_purchase_orders_active_insert_guard` → `kanei_crm_mvp_assert_single_active_maker_po()` |
| 규칙 | UNIQUE(film_supply_order_id) WHERE deleted_at IS NULL AND status <> 'CANCELLED' | 동일 활성 집합 외 행은 무조건 통과(CANCELLED·soft-deleted는 슬롯 미점유), 활성 행은 기존 활성 행 존재 시 거부 |
| 시행 시점 | INSERT·UPDATE (부분 인덱스 대상 행) | INSERT 전용 — 취소/soft-delete(UPDATE)는 인덱스만이 관할, 트리거가 모순 불가 |
| 위반 시 | SQLSTATE 23505, constraint = 인덱스명 | SQLSTATE 23505, constraint 없음 + 규칙·충돌 발주서 ID를 명명하는 메시지 |
| API 처리 | makerPoActiveUniqueViolation 첫 분기 (constraint 일치) | 동일 함수 fallback 분기 (code 23505 + constraint 없음) → 같은 422 MAKER_PO_ALREADY_EXISTS |
| 동시성 | 스냅샷 격리로 직렬화 보장 | READ COMMITTED 스냅샷이라 병렬 미커밋 insert 미관측 → 동시성 직렬화는 인덱스 관할, 트리거는 순차·논리 위반의 결정적 DB 거부 |
| 배치 | friendly path는 API 사전 검사 | 인덱스 유실·우회(raw psql) 상황에서도 규칙이 DB 객체로 존재 |

## 4. 생성·수정 파일

| 파일 | 변경 |
|---|---|
| `packages/db/drizzle/0020_m8_harden3_maker_po_active_insert_guard.sql` | 신규 (74행) |
| `packages/db/drizzle/meta/_journal.json` | idx 20 등록 (when=1795731560000, +7행) |
| `tests/m8-harden3/m8-harden3-maker-po-trigger.test.ts` | 장문 Write 2회 손상 → 청크 단위 재작성, 최종 235행·5테스트 |
| `docs/reports/M8HARDEN3_COMPLETION_REPORT_20261117.md` | 신규 (본 보고서) |

## 7. 미해결 항목

1. **운영(main) DB 적용 대기** — 0020은 test DB에만 적용. main `kanei_crm_mvp`에의 적용은 대표 승인 후 별도 작업 (트리거·저널 idx 20 모두 미적용 상태).
2. **tsc 기존 오류 약 200건 (독립검수 실측 198건)** — HEAD 기준으로도 존재하는 기존 문제(app.ts·m1 테스트 위주). 본 작업 파일은 오류 0건 (임시 worktree에서 HEAD 대조 검증 + 독립검수 재확인). HANDOFF §6이 typecheck을 검증 절차로 명시하므로 별도 과제로 남김.
3. **0016–0019 bookkeeping 누락** — test DB 기록이 idx 15에서 멈춰 있던 것을 본 작업에서 보완(16→20행). main DB의 `__drizzle_migrations` 상태는 미확인(접속 금지).
4. **UPDATE 재활성화 경로** — 트리거는 INSERT 전용(생성 게이트). UPDATE로 활성 집합에 (재)진입하는 경로는 0018 인덱스가 계속 관할(설계 의도대로).

## 4b. 테스트 DB 상태 정리

테스트 DB의 `drizzle.__drizzle_migrations`가 idx 15에서 멈춰 있었고(0016–0019는 스키마 적용됨, 기록 누락), 0016–0019 기록을 실제 파일 sha256으로 보완(16→20행). 이후 drizzle-kit migrate이 **0020만** 적용 → 21행. 0020의 DB 기록 해시 = 파일 sha256 일치 확인.

## 5. Test DB 적용 증거

- `DATABASE_URL=<test> npx drizzle-kit migrate` → `[✓] migrations applied successfully!`
- 적용 후: `__drizzle_migrations` 21행, 마지막 row = 0020 (hash = 파일 sha256 일치)
- 트리거 존재: `maker_purchase_orders_active_insert_guard BEFORE INSERT ON maker_purchase_orders FOR EACH ROW EXECUTE FUNCTION kanei_crm_mvp_assert_single_active_maker_po()`
- 인덱스 공존 확인: `maker_purchase_orders_active_order_unique ... WHERE deleted_at IS NULL AND status <> 'CANCELLED'`

## 6. 테스트 결과

**npx vitest run: 22 파일 / 248/248 통과 (기존 243 + 신규 5), exit 0** — 최종 트리 기준 2회 연속.
