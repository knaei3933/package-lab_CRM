"""Generates ERROR_CODES.md from apps/api/src/error-codes.ts (single source)."""
import re, sys, collections, glob
wt = sys.argv[1]
src = open(f'{wt}/apps/api/src/error-codes.ts', encoding='utf8').read()
body = src[src.index('ERROR_MESSAGES_JA'):src.index('};', src.index('ERROR_MESSAGES_JA'))]
sections = []
for line in body.split('\n'):
    m = re.match(r"\s*// ---- (.*)", line)
    if m: sections.append((m.group(1), [])); continue
    m = re.match(r"\s*([A-Z][A-Z0-9_]+): '(.*)',?$", line)
    if m: sections[-1][1].append((m.group(1), m.group(2)))
# HTTP statuses seen for each code in the API source
statuses = collections.defaultdict(set)
for f in glob.glob(f'{wt}/apps/api/src/*.ts'):
    s = open(f, encoding='utf8').read()
    for m in re.finditer(r"code: '([A-Z][A-Z0-9_]+)'", s):
        tail = s[m.end():m.end()+700]
        st = re.search(r"\}\s*,\s*(\d{3})\s*\)", tail)
        if st: statuses[m.group(1)].add(st.group(1))
fallback = {'BAD_REQUEST':'400','AUTH_REQUIRED':'401','FORBIDDEN':'403','NOT_FOUND':'404','CONFLICT':'409','PAYLOAD_TOO_LARGE':'413',
 'VALIDATION_FAILED':'422','TOO_MANY_REQUESTS':'429','INTERNAL_ERROR':'500','SERVICE_UNAVAILABLE':'503','DB_UNAVAILABLE':'503','DB_TIMEOUT':'503',
 'DUPLICATE':'409','PAYMENT_TERMS_UNDETERMINED':'200 (warnings / attention)','ROUTE_NOT_FOUND':'404'}
extra = {
 'DUPLICATE': '`field`（poNumber / code / referenceCode / null）, 閲覧できる案件なら `existing: {entityType, id, projectId, projectCode}`',
 'DB_UNAVAILABLE': 'ヘッダー `Retry-After: 30`。障害画面（データベース）を出す',
 'DB_TIMEOUT': 'ヘッダー `Retry-After: 30`。障害画面（データベース応答なし）を出す',
 'LOGIN_TIMEOUT': 'ログインボタンの待機を止めて再試行を案内',
 'PAYMENT_TERMS_LOCKED': '`reason`: `ceo_approved`（承認済み発注書あり。`makerPurchaseOrderId` 付き）/ `order_frozen`（保留・見直し・取消）, `from`（発注状態）',
 'PAYMENT_GATE_UNSATISFIED': '`paymentTerms`。「この画面で決済条件を選ぶ」ボタン（PATCH /api/film-supply-orders/:orderId/payment-terms）を置く',
 'PAYMENT_TERMS_UNDETERMINED': '拒否ではない。遷移応答の `warnings[]` と GET /api/projects/:projectId/film-supply-orders の `attention[]` に入る',
 'EVIDENCE_ISSUER_MISMATCH': '`organization`, `evidenceIssuerEntity`, `expectedIssuerEntity`。承認記録時と代表確認（confirmed）時の両方で返る',
 'EVIDENCE_SHARED_ACROSS_ORGANIZATIONS': '`organization`, `evidenceIssuerEntity`, `expectedIssuerEntity`。例外は `sharedEvidence: true` + `sharedEvidenceReason`',
 'SHARED_EVIDENCE_ISSUER_INVALID': '`organization`, `evidenceIssuerEntity`',
 'DELIVERY_UNIT_MISMATCH': '`lineUnit`, `deliveredUnit`（単位の値。表示は日本語ラベルに変換）',
 'IDEMPOTENCY_KEY_REUSED': '同じ `Idempotency-Key` で別内容。新しいキーで送り直す',
 'MAKER_PO_ALREADY_EXISTS': '`existingMakerPurchaseOrderId`, `existingStatus`（ある場合）',
 'SEND_EVIDENCE_FROM_CANCELLED_PO': '候補は GET /api/maker-purchase-orders/:poId/send-evidence-candidates（取消分は除外済み、`excludedCancelledCount`）',
 'RECIPIENT_ADDRESS_INVALID': '発注書作成時。R10 以前の発注書は代表承認時にも返る（取り消して作り直す）',
 'CSRF_ORIGIN_REJECTED': '再読み込みを案内',
}
out = []
out.append('# API エラーコード一覧（P0 サーバー, p0/server）\n')
out.append('API の拒否応答（HTTP 400 以上）は必ず JSON `{ "error": "<日本語の文>", "code": "<CODE>", ...追加項目 }` です（R09）。')
out.append('`error` には英語の core メッセージ・enum 値・項目名・内部 URL/ポートを入れません。安全でない文はサーバーがこの表の文に置き換えます。')
out.append('Web はこの `code` で辞書を引いてください。表にないコードを受けたら「予期しないエラーです（コード: X）。画面を再読み込みしても続く場合は代表者へ連絡してください」と表示します。\n')
out.append('- 生成元: `apps/api/src/error-codes.ts` の `ERROR_MESSAGES_JA`（`tests/p0-server.test.ts` が API/core の全 `code` リテラルと本表の一致を検査）')
out.append('- HTTP 列は API ソースで見つかった応答ステータス（複数あり得る）。')
out.append('- 拒否以外: 遷移応答 `warnings[]`、一覧 `attention[]` にも同じ形式の `{ code, message }` が入ります。')
out.append('- 新しい要求ヘッダー: `Idempotency-Key`（8〜128 文字 `[A-Za-z0-9_.:-]`、ログイン中の書き込みだけ有効、24 時間・同一 API プロセス内）。再生応答にはヘッダー `Idempotent-Replayed: true`。')
out.append('- Web 側だけで作るコード（API は返さない）: `PROJECT_CONTEXT_MISMATCH`（R03 別タブ案件）, `API_UNREACHABLE`（Web→API 接続不可）, `SESSION_EXPIRED`（Web の表示用。API は `AUTH_REQUIRED`）。\n')
total = 0
for title, rows in sections:
    out.append(f'## {title}\n')
    out.append('| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |')
    out.append('|---|---|---|---|')
    for code, msg in rows:
        st = ', '.join(sorted(statuses.get(code, set()))) or fallback.get(code, '422')
        out.append(f"| `{code}` | {st} | {msg.replace('|','／')} | {extra.get(code, '')} |")
        total += 1
    out.append('')
out.insert(1, f'コード数: {total}\n')
open(sys.argv[2], 'w', encoding='utf8').write('\n'.join(out) + '\n')
print(total)
