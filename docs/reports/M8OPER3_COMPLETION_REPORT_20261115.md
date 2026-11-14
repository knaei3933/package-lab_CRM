# M8-OPER3 완료 보고 — 제조사 발주 경계의 실시간 이중승인 재검증 (CEO 최종 안전 게이트)

작성: 2026-11-15 / 브랜치: `agent/m8-oper3` (worktree) / 베이스: `e486fdc` (master)
검증 범위: 격리 test DB(kanei_crm_mvp_test) 대상으로만 설계. 계산기(/root/pouch-clacul)·NAS 컨테이너·실메일·실발주·본 DB(kanei_crm_mvp) 미접촉. push/merge 없음.

## 1. 검증 실측 (중요)

이 세션의 실행 환경에서 `npm`·`psql`·`bash` 스크립트 실행이 모두 **권한 승인 필요(denied)** 로 반환되었다(이전 팬아웃 세션과 동일한 경계: `npm run typecheck`, `psql -h 127.0.0.1 -p 5434 ...`, `bash -n crm-ops/...` 각각 "This command requires approval"). 경계 규칙에 따라 다른 경로로 우회하지 않았고, 아래와 같이 기록만 남긴다.

| 검증 | 결과 |
|---|---|
| 전체 테스트 (test DB) | ⏸ **미실행 — 실행 권한 denied** (`npm test`). 정적 검증만 수행. 신규 4개 추가 → **실행 시 197 예상** (기존 193 + 신규 4) |
| 마이그레이션 적용 | ⏸ **미실행 — `psql` denied.** 본 작업은 **스키마 변경 없음** (신규 테이블·컬럼·마이그레이션 0건). 기존 마이그레이션만으로 동작 |
| build (apps/web) | ⏸ **미실행 — 권한 denied.** 정적 타입 검토로 대체 (아래 §6) |
| backup/restore 훈련 | ⏸ **미실행 — `pg_dump`/`createdb` 권한 denied.** 훈련 절차는 §7에 그대로 준비됨 (test DB 전용) |
| 정적 검증 | ✅ 전체 diff 수동 검토 완료. 게이트 파생 규칙·감사 행·4개 핸들러 배위 재독파 완료 |

**판정**: 구현·회귀 테스트·데모 시더는 완료하여 커밋. 실행 증락(테스트·빌드·복구 훈련)이 없으므로 `input_required`로 보고 — 실행 승인 후 즉시 확정 가능.

## 2. 문제 정의 (CEO 지적 사항)

- 승인 장부는 append-only이고 **REVOKE는 발주 상태를 바꾸지 않는다.** 이중승인으로 `MAKER_PO_READY`에 도달한 발주는 한 조직이 승인을 철회해도 같은 상태에 머문다.
- 베이스 `e486fdc`에서 4개 제조사 발주 엔드포인트(maker-PO 생성 / 대표 승인 / 송증기록 / 수락)는 `deriveOrderApprovalGate`·`dualApproved`를 전혀 읽지 않았다(grep 0건 — 일반 transitions 엔드포인트의 T-13 게이트와 대비).
- 따라서 철회 후에도 종이를 새로 발행하고(201), 대표 승인을 인증하고(200), 증빙이 있으면 **실제 발송까지**(200 `MAKER_PO_SENT_MANUALLY`) 진행할 수 있었다.

### 사전(re-fix) 재현 분석 — STEP 1

이중승인 → `MAKER_PO_READY` → REVOKE 1건 직후의 세 시도에 대한 수정 전 응답(코드 경로 기반):

| 시도 | 수정 전 응답 | 수정 후 응답 |
|---|---|---|
| (a) POST maker-purchase-orders | **201 진행** (creationGate·선행게이트만 통과) | 422 `DUAL_APPROVAL_NO_LONGER_VALID` |
| (b) POST ceo-approval (기존 DRAFT PO) | **200 진행** → `APPROVED_FOR_MANUAL_SEND` | 422 `DUAL_APPROVAL_NO_LONGER_VALID` |
| (c) POST send-evidence | PO가 DRAFT면 422 `MAKER_PO_TRANSITION_BLOCKED`(상태기계). **대표 승인 후라면 200 `MAKER_PO_SENT_MANUALLY`(VERIFIED) — 발송까지 진행** | 미발송 종이는 422 `DUAL_APPROVAL_NO_LONGER_VALID` / 이미 검증발송된 종이는 기록만 하고 통과 |

## 3. 구현 — `dualApprovalRecheck` (apps/api/src/app.ts)

- `loadApprovalContext(orderId)` + `deriveOrderApprovalGate(...)`를 **요청 시점에 DB에서 새로 읽어** 파생. 상태 컬럼을 신뢰하지 않는다.
- **감사 행 무조건 1건** (통과·차단 모두): action `MAKER_PO_DUAL_APPROVAL_RECHECK`, entityType `film_supply_order`(생성) / `maker_purchase_order`(나머지), afterState에 `result('passed'|'blocked')`·`stage`·`reason`·`provenSendExists`·`orderStatus`·**게이트 스냅샷**(design별 양 조직의 valid/revoked/latestDecision/pendingEvidenceIdentifier + missingApprovals)·requestMetadata(operation·발주·PO id).
- **차단 규칙**: `!gate.dualApproved && 승인철회 && !(발송후단계 && 검증발송 존재)` → 422 `DUAL_APPROVAL_NO_LONGER_VALID` (메시지: 「二重承認が無効になっているため、この操作は実行できません。取り消された組織の承認を再取得してから実行してください」) + `missingApprovals`.
  - **승인철회** = 현재 판본에서 필수 조직의 최종 유효 이벤트가 REVOKE이거나, 최신 APPROVE가 산입되지 않는 경우(`revoked` 또는 `pendingEvidenceIdentifier`).
  - **의도적 축소(1)**: 게이트가 닫혀 있어도 철회가 아니라 **판본 진행**(T-11 change review, 승인이 구판본에 남음)뿐이라면 차단하지 않고 기록만 남긴다(reason `gate_closed_superseded_revision_snapshot_void_governs`). 사유: 그 복구 경로의 권위는 스냅샷 소멸 기계(G10·T-23·T-24)이고, 대표 재승인이 그 설계 단계다. 무조건 차단하면 기존 설계 테스트 T-24(아트워크 변경 후 재승인·재발송)가 파리고, "상태기계 자체는 변경하지 않는다"는 지시와 충돌한다. 철회-세탁 경로는 여전히 막혀 있다: 새 판본 등록 시 발주는 `CHANGE_REVIEW`로 이동 → 생성은 `MAKER_PO_NOT_READY`, 송증기록은 스냅샷 소멸(`SNAPSHOT_VOIDED`)로 차단.
  - **의도적 축소(2)** — 이미 출하된 종이: `SEND_EVIDENCE_REGISTERED` + `verificationStatus='VERIFIED'` 이벤트가 있는 PO에 대한 송증기록·수락은 차단하지 않고 **기록만** 남긴다(reason `gate_closed_after_proven_send_recorded_not_enforced`). 요구사항 그대로 — 이미 회사를 떠난 종이를 소급 차단하지 않고, 미발송 종이는 차단한다. (이 규칙의 이벤트명은 브리프의 `SEND_EVIDENCE_VERIFIED`에 해당하는 코드베이스의 실제 표현이다.)
- **배위 위치** (상태기계·전이 규칙 무변경 — 경계에서의 재검증만):
  1. maker-PO 생성: `evaluateMakerPoCreationGate`·seven PO 선행게이트 통과 직후, 요청 본문 해석 전.
  2. 대표 승인: 결제게이트(G6) 통과 직후, 트랜잭션 전.
  3. 송증기록: sentAt 검증 직후, 트랜잭션 전 (차단 시 아무것도 기록되지 않는다 — SEND_UNVERIFIED·SNAPSHOT_VOIDED 경로에 도달하지 않음).
  4. 수락: acceptedAt 검증 직후, 트랜잭션 전.
- 가정(仮)수락(`provisional-acceptance`)은 브리프의 4개 핸들러에 없고, 정의상 검증발송 이후에만 도달 가능하므로(이미 출하된 구간) 그대로 뒀다.

## 4. 회귀·통합 테스트 (tests/m8-oper3/m8-oper3-maker-po-gate.test.ts, 신규 4개)

같은 합성 체인(seven PO + 검증체크리스트 + register-official + supply-order(paymentTerms) + 4전이 + proof 판본 + **식별자를 인용하는 TEXT 승인 2건**)을 사용:

1. **철회 직후 3시도 전부 차단**: REVOKE → (a)생성·(b)대표승인·(c)송증기록이 전부 422 `DUAL_APPROVAL_NO_LONGER_VALID`, **아무것도 기록되지 않음**(PO 1행 유지·DRAFT·ceoApprovedAt null·maker_po_events 0행), 감사 행 4건(철회 전 통과 1 + 차단 3)과 게이트 스냅샷(customer revoked/latestDecision=REVOKE, seven valid/APPROVE)까지 검증.
2. **재승인으로 경계 재개**: 철회 → 생성 422 → 같은 조직의 새 TEXT 승인 → 생성 201. 재검증이 금지목록이 아니라 **실시간 판독**임을 확인. 감사 행 차단 1 + 통과 1.
3. **정상 경로 전 구간**: 유효한 이중승인에서 생성→대표승인→**검증송증(VERIFIED)**→수락→`FILM_IN_PRODUCTION` 전부 성공, 4개 경계 행위의 재검증 전부 `passed`(reason `gate_open`), PO 이벤트는 정확히 CEO_APPROVED/SEND_EVIDENCE_REGISTERED(VERIFIED)/ACCEPT_EVIDENCE_REGISTERED 3건.
4. **출하 후 철회는 소급 차단 아님**: 검증발송 후 REVOKE → 수락은 200으로 통과하고 감사 reason은 `gate_closed_after_proven_send_recorded_not_enforced`(`provenSendExists=true`, `gate.dualApproved=false`) → `FILM_IN_PRODUCTION` 도달.

## 5. 데모 시딩 (STEP 4 — 준비만, 미실행)

- `/root/company-auto/crm-ops/reseed-demo.sh`는 이 세션의 샌드박스 밖이라 **읽기/쓰기 모두 권한 denied** → 저장소 안에 형제 스크립트로 대체: **`crm-ops/reseed-demo-m8-oper3.sh`** (신규).
- DB 연결을 전혀 열지 않고 **실행 중인 API만** 호출(`npm run db:seed`와 같은 원리의 운영 스크립트). 데모 프로젝트 + 데모 계정 3종(project 생성에 필요) → seven PO 체크리스트·공식등록 → **paymentTerms 설정된** 공급발주 → proof 판본 → **TEXT approval_evidence 승인 2건(customer·seven, 각자 식별자 인용)** → `MAKER_PO_READY` → **제조사 발주서 생성 + 대표 승인까지** → 마지막에 **project id / order id / maker PO id 출력**.
- CEO가 수동으로 할 일(송증기록·수락)은 UI에서. REVOKE 후 같은 화면에서 `DUAL_APPROVAL_NO_LONGER_VALID`(422)를 확인하는 절차도 출력에 포함.
- 실행 방법(본 DB 대상 실행은 이번 작업에서 하지 않았다):
  ```
  npm run dev:api     # :3081, DATABASE_URL 이 가리키는 DB가 데모가 쌓일 곳
  KANEI_DEMO_CUSTOMER_ACCOUNT_ID=<uuid> KANEI_DEMO_SEVEN_ACCOUNT_ID=<uuid> \
  KANEI_DEMO_MAKER_ACCOUNT_ID=<uuid> bash crm-ops/reseed-demo-m8-oper3.sh
  # 계정 ID 조회(읽기 전용): psql "$DATABASE_URL" -c "select role, id from accounts where deleted_at is null and is_active order by created_at"
  ```
  대표(admin) 자격으로 전 단계를 수행하므로 프로젝트 할당이 필요 없고, 계정 3종만 있으면 된다(기본값은 합성 시드 계정).

## 6. 정적 타입 검토 (build 대체)

- 신규 코드가 사용하는 심볼 전부 기존 import 범위 내(`deriveOrderApprovalGate`, `ApprovalOrganization`, `makerPoEvents`, `and/eq`, `uuidv7`, `recordAuditEvent(db, …)` — `AuditEventWriter = Pick<AppDatabase,'insert'>`).
- `eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED')`·`verificationStatus 'VERIFIED'`는 pgEnum 멤버 문자열로 스키마 상 `maker_po_event_type`·`maker_po_event_verification_status` 멤버와 정확히 일치.
- 4개 핸들러의 배위 각각에서 변수명 충돌 없음(`creationRecheck`/`approvalRecheck`/`sendRecheck`/`acceptRecheck`), `now` 재선언 없음, 조기 반환은 트랜잭션 시작 전이라 부분기록 없음.
- 신규 감사 action `MAKER_PO_DUAL_APPROVAL_RECHECK`는 기존 테스트가 감사 행을 셀 때 전부 action·entityId로 필터링하므로 기존 카운트 어설션과 무간섭.

## 7. 승인 후 실행 절차 (부모/수집기용 — test DB 전용)

```
# 0) 격리 test DB 지정 (tests/setup.ts 가 127.0.0.1:5434 + /kanei_crm_mvp* 를 요구)
export DATABASE_URL=postgresql://kanei:local_only_dev@127.0.0.1:5434/kanei_crm_mvp_test

# 1) 전체 수트 (기존 193 + 신규 4 = 예상 197/197)
npm test

# 2) 웹 빌드
npm run build --workspace @kanei/web

# 3) 마이그레이션 적용·스키마 확인 (본 작업은 스키마 변경 없음 — 기존 전부 적용 확인용)
npm run db:migrate
psql "$DATABASE_URL" -c "\dt" 2>&1 | head

# 4) 백업/복구 훈련 — test DB 만. 본 kanei_crm_mvp 는 절대 대상 아님
pg_dump "$DATABASE_URL" -Fc -f /tmp/kanei_crm_mvp_test_oper3.dump
createdb -h 127.0.0.1 -p 5434 -U kanei kanei_crm_mvp_test_restore
pg_restore -h 127.0.0.1 -p 5434 -U kanei -d kanei_crm_mvp_test_restore /tmp/kanei_crm_mvp_test_oper3.dump
psql -h 127.0.0.1 -p 5434 -U kanei -d kanei_crm_mvp_test_restore -tAc \
  "select 'projects', count(*) from projects union all select 'film_supply_orders', count(*) from film_supply_orders union all select 'maker_purchase_orders', count(*) from maker_purchase_orders union all select 'audit_events', count(*) from audit_events"
psql -h 127.0.0.1 -p 5434 -U kanei -d kanei_crm_mvp_test -tAc "select 'projects',count(*) from projects union all select 'film_supply_orders',count(*) from film_supply_orders union all select 'maker_purchase_orders',count(*) from maker_purchase_orders union all select 'audit_events',count(*) from audit_events"
dropdb -h 127.0.0.1 -p 5434 -U kanei kanei_crm_mvp_test_restore
```

## 8. 남은 리스크

1. **실행 증락 부재** — 197/197·빌드·복구 훈련은 승인 후 증락 필요(§7). 테스트는 기존 체인을 그대로 재사용해 작성했으나, 실측 없이는 어설션 오차(예: 감사 행 수) 가능성이 남는다.
2. **축소 판단(1)의 경계** — 게이트 폐쇄가 "판본 진행"뿐인 경우 경계는 차단하지 않는다(T-24 유지). 직원이 철회 후 새 판본을 등록해 종이를 재승인·발송하는 경로는 상태기계(CHANGE_REVIEW·SNAPSHOT_VOIDED)와 대표 승인에 의존하며, 이중승인 자체로는 막지 않는다. CEO가 이 경로도 경계에서 막기를 원하면 `approvalWithdrawn` 조건에서 판본 진행 케이스를 포함하도록 한 줄만 바꾸면 되지만, 그 경우 T-24(설계 복구 흐름)도 막힌다 — 별도 의사결정 필요.
3. **`pendingEvidenceIdentifier` 포함** — 최신 APPROVE가 수동확인 대기라면 철회와 같이 차단한다. 수동확인 대기 승인으로 MAKER_PO_READY에 진입한 합성 상태는 없고, 정상 경로에서 도달 불가라 기존 수트와 무간섭으로 판단했으나 실측 전이다.
4. **감사 행 증가** — 4개 경계 호출마다 행 1건이 늘어난다(통과 포함). 감사 이력 화면·테스트는 action 필터라 영향 없음. 운영 데이터량은 미미.
5. **가정(仮)수락 엔드포인트 미포함** — 검증발송 이후에만 도달하므로 이미 출하 구간으로 보아 재검증을 넣지 않았다. CEO가 원하면 동일 헬퍼 한 줄 추가로 가능.
