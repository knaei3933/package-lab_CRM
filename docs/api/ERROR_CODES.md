# API エラーコード一覧（P0 サーバー p0/server + P1 サーバー p1/server）

コード数: 261

API の拒否応答（HTTP 400 以上）は必ず JSON `{ "error": "<日本語の文>", "code": "<CODE>", ...追加項目 }` です（R09）。
`error` には英語の core メッセージ・enum 値・項目名・内部 URL/ポートを入れません。安全でない文はサーバーがこの表の文に置き換えます。
Web はこの `code` で辞書を引いてください。表にないコードを受けたら「予期しないエラーです（コード: X）。画面を再読み込みしても続く場合は代表者へ連絡してください」と表示します。

- 生成元: `apps/api/src/error-codes.ts` の `ERROR_MESSAGES_JA`（`tests/p0-server.test.ts` が API/core の全 `code` リテラルと本表の一致を検査）
- HTTP 列は API ソースで見つかった応答ステータス（複数あり得る）。
- 拒否以外: 遷移応答 `warnings[]`、一覧 `attention[]` にも同じ形式の `{ code, message }` が入ります。
- 新しい要求ヘッダー: `Idempotency-Key`（8〜128 文字 `[A-Za-z0-9_.:-]`、ログイン中の書き込みだけ有効、24 時間・同一 API プロセス内）。再生応答にはヘッダー `Idempotent-Replayed: true`。
- Web 側だけで作るコード（API は返さない）: `API_UNREACHABLE`（Web→API 接続不可）, `SESSION_EXPIRED`（Web の表示用。API は `AUTH_REQUIRED`）。`PROJECT_CONTEXT_MISMATCH` は Web の R03 に加えて P1 から API も返す（`expectedProjectId` 不一致）。

## authentication / authorization / generic

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | ログインが必要です。ログインの有効期限が切れた場合は、もう一度ログインしてください |  |
| `INVALID_CREDENTIALS` | 401 | ユーザー名またはパスワードが正しくありません |  |
| `CREDENTIALS_REQUIRED` | 400 | ユーザー名とパスワードを入力してください |  |
| `LOGIN_TEMPORARILY_LOCKED` | 429 | ログインの試行回数が多いため、しばらく待ってから再試行してください |  |
| `LOGIN_TIMEOUT` | 503 | ログイン処理が時間内に終わりませんでした。数分後にもう一度お試しください | ログインボタンの待機を止めて再試行を案内 |
| `FORBIDDEN` | 403 | この操作を行う権限がありません |  |
| `CEO_ONLY` | 403 | この操作は代表者だけが行えます |  |
| `CSRF_ORIGIN_REJECTED` | 403 | 許可されていない画面からの送信のため受け付けませんでした。画面を再読み込みしてください | 再読み込みを案内 |
| `INVALID_PATH_PARAMETER` | 400 | 指定された対象のIDが正しくありません。画面を再読み込みしてください |  |
| `ROUTE_NOT_FOUND` | 404 | 指定された操作は存在しません |  |
| `BAD_REQUEST` | 400 | 送信内容を読み取れませんでした。入力内容を確認してください |  |
| `VALIDATION_FAILED` | 422 | 入力内容を確認してください |  |
| `NOT_FOUND` | 404 | 対象が見つかりません。削除されたか、別の案件の記録の可能性があります |  |
| `CONFLICT` | 409 | 他の操作と重なったため保存できませんでした。画面を再読み込みしてからやり直してください |  |
| `TOO_MANY_REQUESTS` | 429 | 操作が多すぎます。しばらく待ってから再試行してください |  |
| `PAYLOAD_TOO_LARGE` | 413 | 送信データが大きすぎます。ファイルの大きさを確認してください |  |
| `INTERNAL_ERROR` | 500 | 予期しないエラーが発生しました。画面を再読み込みしても続く場合は代表者へ連絡してください |  |
| `SERVICE_UNAVAILABLE` | 503 | システムが一時的に利用できません。数分後に再読み込みしてください |  |

## R04: outage

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `DB_UNAVAILABLE` | 503 | システムに接続できません（データベース）。入力した内容は保存されていません。数分後に再読み込みしてください | ヘッダー `Retry-After: 30`。障害画面（データベース）を出す |
| `DB_TIMEOUT` | 503 | データベースの応答が時間内に返りませんでした。入力した内容は保存されていません。数分後にもう一度お試しください | ヘッダー `Retry-After: 30`。障害画面（データベース応答なし）を出す |

## R05: duplicates / idempotency

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `DUPLICATE` | 409 | この番号はすでに登録されています。登録済みの記録を確認してください | `field`（poNumber / code / referenceCode / null）, 閲覧できる案件なら `existing: {entityType, id, projectId, projectCode}` |
| `IDEMPOTENCY_KEY_INVALID` | 400 | 送信の識別キーが正しくありません。画面を再読み込みしてからやり直してください |  |
| `IDEMPOTENCY_KEY_REUSED` | 422 | 同じ送信の識別キーで別の内容が送られました。画面を再読み込みしてからやり直してください | 同じ `Idempotency-Key` で別内容。新しいキーで送り直す |

## not found

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 案件が見つかりません |  |
| `FILM_SUPPLY_ORDER_NOT_FOUND` | 404 | フィルム発注が見つかりません |  |
| `MAKER_PO_NOT_FOUND` | 404 | メーカー発注書が見つかりません |  |
| `MAKER_PO_EVENT_NOT_FOUND` | 404 | メーカー発注書の記録が見つかりません |  |
| `SEVEN_PO_NOT_FOUND` | 404, 422 | セブン化学発注書が見つかりません |  |
| `ARTWORK_REVISION_NOT_FOUND` | 404 | 版が見つかりません |  |
| `DOCUMENT_NOT_FOUND` | 404 | 書類が見つかりません |  |
| `DOCUMENT_VERSION_NOT_FOUND` | 404 | 書類のバージョンが見つかりません |  |
| `PRE_ORDER_REFERENCE_NOT_FOUND` | 404, 422 | 先行発注の参照が見つかりません |  |
| `FILLING_ORDER_NOT_FOUND` | 404 | 充填発注が見つかりません |  |
| `DELIVERY_NOT_FOUND` | 404 | 納品の記録が見つかりません |  |
| `APPROVAL_EVENT_NOT_FOUND` | 404 | 承認の記録が見つかりません |  |
| `FILM_ORDER_LINE_NOT_FOUND` | 422 | 発注の明細が見つかりません |  |
| `FILLING_ORDER_LINE_NOT_FOUND` | 422 | 充填発注の明細が見つかりません |  |

## project

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `PROJECT_UPDATE_INVALID` | 422 | 案件名を入力してください |  |
| `PROJECT_FIELDS_REQUIRED` | 422 | 案件コード・案件名・取引先（顧客・セブン化学・メーカー）を入力してください |  |
| `PROJECT_ACCOUNT_ROLE_INVALID` | 422 | 取引先の役割（顧客・セブン化学・メーカー）が正しくありません |  |
| `PROJECT_ACCOUNT_INVALID` | 422 | 選んだ取引先は使用できません（無効または削除済み） |  |
| `PROJECT_ACCOUNTS_REQUIRED` | 422 | 顧客・セブン化学・メーカーの3社を別々に選んでください |  |
| `UNSUPPORTED_ROUTE` | 422 | この案件の種類はまだ作成できません（作成できるのはF1案件だけです） |  |
| `ROUTE_IMMUTABLE` | 422 | 案件の種類はあとから変更できません |  |

## R01: payment terms

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `PAYMENT_TERMS_REQUIRED` | 422 | 支払条件を選んでください（前払い・納品後払い・未定） |  |
| `UNKNOWN_PAYMENT_TERMS` | 422 | 支払条件は「前払い」「納品後払い」「未定」から選んでください |  |
| `PAYMENT_TERMS_LOCKED` | 422 | 代表承認済みのメーカー発注書がある、または保留・見直し中のため、支払条件は変更できません | `reason`: `ceo_approved`（承認済み発注書あり。`makerPurchaseOrderId` 付き）/ `order_frozen`（保留・見直し・取消）, `from`（発注状態） |
| `PAYMENT_TERMS_REASON_TOO_LONG` | 422 | 支払条件の変更理由が長すぎます。1000文字以下にしてください |  |
| `PAYMENT_TERMS_REASON_INVALID` | 422 | 支払条件の変更理由が空です。理由を書くか、欄を空のままにしてください |  |
| `PAYMENT_TERMS_CHANGED` | 409 | 承認画面を開いた後に支払条件が変更されました。最新の支払条件を確認してから、もう一度承認してください |  |
| `PAYMENT_GATE_UNSATISFIED` | 422 | 支払条件が「未定」のため代表承認できません。フィルム発注の支払条件を「前払い」または「納品後払い」に変更してから承認してください | `paymentTerms`。「この画面で支払条件を選ぶ」ボタン（PATCH /api/film-supply-orders/:orderId/payment-terms）を置く |
| `PAYMENT_TERMS_UNDETERMINED` | 200 (warnings / attention) | 支払条件が「未定」です。代表承認の前に「前払い」または「納品後払い」を選んでください | 拒否ではない。遷移応答の `warnings[]` と GET /api/projects/:projectId/film-supply-orders の `attention[]` に入る |

## seven purchase orders / pre-order references

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `PO_NUMBER_REQUIRED` | 422 | 発注番号を入力してください |  |
| `REFERENCE_CODE_REQUIRED` | 422 | 参照コードを入力してください |  |
| `OFFICIAL_REGISTRATION_REQUIRED` | 422 | セブン化学発注書の公式登録日が必要です。原本受領日は参考情報のため代わりになりません |  |
| `OFFICIAL_DATE_ALREADY_REGISTERED` | 409 | 公式登録日が別の操作で先に登録されました。画面を再読み込みしてください |  |
| `SEVEN_PO_REQUIRED` | 422 | 発注にセブン化学発注書（確認済み）を紐付けてください |  |
| `SEVEN_PO_NOT_LINKED` | 422 | この参照に紐付くセブン化学発注書がありません |  |
| `SEVEN_PO_NOT_VERIFIED` | 422 | セブン化学発注書の真正性確認（チェックリスト）が完了していません |  |
| `SEVEN_PO_PROJECT_MISMATCH` | 422 | セブン化学発注書がこの案件に見つかりません |  |
| `PO_REVIEW_PENDING` | 422 | 見積とセブン化学発注書の突合レビューが未解決です。レビューを終えてから進めてください |  |
| `CHECKLIST_INCOMPLETE` | 422 | 真正性確認のチェック項目に未記録のものがあります。すべての項目を記録してください |  |
| `CONFIRMATION_REPLY_REQUIRED` | 422 | 判断に迷う点がある場合は、確認の返信内容を記録してください |  |

## film / filling orders and lines

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `ORDER_CODE_REQUIRED` | 422 | 発注コードを入力してください |  |
| `DESCRIPTION_REQUIRED` | 422 | 明細の内容を入力してください |  |
| `INVALID_LINE_NUMBER` | 422 | 明細の行番号は1以上の整数にしてください |  |
| `INVALID_QUANTITY` | 422 | 数量は0より大きい数値で入力してください |  |
| `UNKNOWN_UNIT` | 422 | 単位を一覧から選んでください |  |
| `UNIT_DOMAIN_MISMATCH` | 422 | この発注では使えない単位です。フィルムと充填の単位を確認してください |  |
| `FILM_ORDER_LINE_REQUIRED` | 422 | 明細を選んでください |  |
| `FILLING_ORDER_LINE_REQUIRED` | 422 | 充填発注の明細を選んでください |  |
| `FILM_SUPPLY_ORDER_PROJECT_MISMATCH` | 422 | 紐付けるフィルム発注がこの案件に見つかりません |  |

## film order state machine

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `UNKNOWN_STATE` | 422 | 進める先の状態が正しくありません。画面を再読み込みしてください |  |
| `INVALID_TRANSITION` | 422 | この状態からは選んだ状態へ進めません。画面を再読み込みして現在の状態を確認してください |  |
| `FILM_ORDER_CANCELLED` | 409 | この発注は取消で終了しているため、変更できません |  |
| `FILM_ORDER_STATE_CHANGED` | 409 | 発注の状態が別の操作で変わりました。画面を再読み込みしてください |  |
| `FILM_ORDER_LOCK_CONFLICT` | 409 | 同じ発注への操作が重なりました。少し待ってからもう一度お試しください |  |
| `MAKER_CHAIN_TRANSITION_FORBIDDEN` | 422 | メーカー発注書の状態は、メーカー発注書の画面（代表承認・送信証跡・受領証跡）からだけ進められます |  |
| `DUAL_APPROVAL_REQUIRED` | 422 | すべてのデザインで顧客とセブン化学の両方の承認が必要です |  |
| `DUAL_APPROVAL_NO_LONGER_VALID` | 422 | 両組織の承認が取り消されたため、この操作は行えません。承認の状況を確認してください |  |
| `HOLD_REASON_REQUIRED` | 422 | 保留にする理由を入力してください |  |
| `HOLD_REASON_TOO_LONG` | 422 | 保留理由が長すぎます。1000文字以下にしてください |  |
| `EVIDENCE_NOTE_TOO_LONG` | 422 | 証跡がないまま進める理由が長すぎます。1000文字以下にしてください |  |
| `ORDER_NOT_ON_HOLD` | 422 | この発注は保留中ではありません。画面を再読み込みしてください |  |
| `HOLD_RELEASE_REASON_REQUIRED` | 422 | 保留を解除する理由を入力してください |  |
| `HOLD_RELEASE_REASON_TOO_LONG` | 422 | 保留を解除する理由が長すぎます。1000文字以下にしてください |  |
| `HOLD_ORIGIN_UNKNOWN` | 422 | 保留前の状態が記録されていないため、戻す先の状態を選んでください |  |
| `HOLD_RELEASE_STATE_CONFLICT` | 409 | 保留の状態が別の操作で変わりました。画面を再読み込みしてください |  |
| `HOLD_RESUME_EVIDENCE_MISMATCH` | 422 | 戻す先の状態に必要なメーカー発注書の証跡がありません |  |
| `HOLD_RESUME_STATUS_INVALID` | 422 | 戻す先として選べるのは保留前の状態だけです |  |
| `ORDER_NOT_IN_CANCELLATION_REVIEW` | 422 | この発注は取消レビュー中ではありません。画面を再読み込みしてください |  |
| `CANCELLATION_REVIEW_RESOLUTION_REQUIRED` | 422 | 取消レビューは、取消レビューの解決操作（代表者）でだけ終了できます |  |
| `CANCELLATION_REVIEW_STATE_CHANGED` | 409 | 取消レビューの状態が別の操作で変わりました。画面を再読み込みしてください |  |
| `CANCELLATION_REASON_REQUIRED` | 422 | 取消レビューを解決する理由を入力してください |  |
| `CANCELLATION_REASON_TOO_LONG` | 422 | 取消レビューを解決する理由が長すぎます。1000文字以下にしてください |  |
| `CANCELLATION_OUTCOME_INVALID` | 422 | 取消レビューの結果は「再開」か「取消で終了」から選んでください |  |
| `CANCELLATION_RESUME_REQUIRED` | 422 | 取消レビュー前の状態が記録されていないため、再開する状態を選んでください |  |
| `CANCELLATION_RESUME_TARGET_INVALID` | 422 | 再開できるのは取消レビュー前の状態だけです |  |
| `CANCELLATION_RESUME_EVIDENCE_MISMATCH` | 422 | 再開する状態に必要なメーカー発注書の証跡がありません |  |
| `PRINTED_CHANGE_ADMIN_APPROVAL_REQUIRED` | 403 | 印刷開始後の変更には代表者の承認が必要です |  |

## change requests

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `CHANGE_REQUEST_REASON_REQUIRED` | 422 | 変更理由を入力してください |  |
| `CHANGE_REQUEST_ORGANIZATION_REQUIRED` | 422 | 変更を依頼した組織（顧客またはセブン化学）を選んでください |  |
| `CHANGE_REQUEST_EVIDENCE_REQUIRED` | 422 | 変更依頼の証跡（書類）を選んでください |  |
| `CHANGE_REQUEST_EVIDENCE_PROJECT_MISMATCH` | 422 | 変更依頼の証跡がこの案件に見つかりません |  |
| `CHANGE_REQUEST_EVIDENCE_BINDING_INVALID` | 422 | 変更依頼の証跡は、この発注・デザインの承認証跡を選んでください |  |
| `CHANGE_REQUEST_IMPACT_SCHEDULE_REQUIRED` | 422 | 納期への影響を入力してください（ない場合は「なし」） |  |
| `CHANGE_REQUEST_LOT_MARKING_REQUIRED` | 422 | ロット変更では新しいロット表示を入力してください |  |
| `CHANGE_REQUEST_NUMERIC_FIELD_REQUIRED` | 422 | 数値の項目を入力してください（ゼロの場合も0と入力） |  |
| `CHANGE_REQUEST_NUMERIC_FIELD_INVALID` | 422 | 数値の項目は0以上にしてください |  |
| `CHANGE_REQUEST_NUMERIC_FIELD_TOO_LARGE` | 422 | 数値が大きすぎます |  |
| `CHANGE_REQUEST_DECIMAL_SCALE_INVALID` | 422 | 小数点以下の桁数が多すぎます |  |

## documents

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `UNKNOWN_DOCUMENT_TYPE` | 422 | 書類の種類を一覧から選んでください |  |
| `UNKNOWN_ISSUER_ENTITY` | 422 | 書類の発行元を一覧から選んでください |  |
| `DOCUMENT_FILE_REQUIRED` | 422 | ファイルを選んでください |  |
| `DOCUMENT_CONTENT_REQUIRED` | 422 | ファイルを選んでください |  |
| `DOCUMENT_FILENAME_REQUIRED` | 422 | ファイル名が必要です |  |
| `DOCUMENT_EMPTY` | 422 | ファイルが空です。中身のあるファイルを選んでください |  |
| `DOCUMENT_TOO_LARGE` | 422 | ファイルが大きすぎます。上限（5MB）以下のファイルを選んでください |  |
| `DOCUMENT_TYPE_REJECTED` | 422 | このファイル形式は登録できません（PDF・画像・EML・テキスト・CSVなど） |  |
| `DOCUMENT_CONTENT_MISMATCH` | 422 | ファイルの中身と選んだ形式が一致しません。正しい形式を選ぶか、元のファイルを選び直してください |  |
| `DOCUMENT_UNREADABLE` | 404 | 保存されている書類ファイルを読み取れません。代表者へ連絡してください |  |
| `DOCUMENT_INTEGRITY_INVALID` | 409 | 書類ファイルが登録時と一致しません。代表者へ連絡してください |  |
| `DOCUMENT_BINDING_CONFLICT` | 422 | 同じ書類がすでに別の発注・デザインに紐付いています。別のファイル名で登録してください |  |
| `INVALID_UPLOAD_PAYLOAD` | 422 | アップロードの内容を読み取れませんでした。もう一度ファイルを選んでください |  |
| `INVALID_VERIFICATION_STATUS` | 422 | 確認結果は「確認済み」か「相違あり」から選んでください |  |
| `DESIGN_KEY_REQUIRED` | 422 | 発注に紐付ける書類にはデザイン（デザインキー）が必要です |  |
| `MAKER_PO_BINDING_MISMATCH` | 422 | 紐付けるメーカー発注書が、この書類の発注に見つかりません |  |

## artwork revisions and approvals

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `ORDER_NOT_PAST_SEVEN_PO_VERIFIED` | 422 | 版はセブン化学発注書の確認が済んだ発注にだけ登録できます |  |
| `INVALID_REVISION_NUMBER` | 422 | 版番号は1以上の整数にしてください |  |
| `REVISION_NUMBER_EXISTS` | 422 | この版番号はすでに登録されています |  |
| `FILE_DOCUMENT_VERSION_REQUIRED` | 422 | 版のファイル（校正ファイル）を選んでください |  |
| `FILE_DOCUMENT_VERSION_INVALID` | 422 | 版のファイルの指定が正しくありません |  |
| `FILE_DOCUMENT_TYPE_INVALID` | 422 | 版のファイルには「校正」の種類の書類を選んでください |  |
| `FILE_DOCUMENT_PROJECT_MISMATCH` | 422 | 版のファイルがこの案件に見つかりません |  |
| `FILE_DOCUMENT_ORDER_MISMATCH` | 422 | 版のファイルは別の発注に紐付いています |  |
| `FILE_DOCUMENT_DESIGN_MISMATCH` | 422 | 版のファイルは別のデザインに紐付いています |  |
| `MAKER_PO_ACTIVE_ARTWORK_REVISION_BLOCKED` | 409 | 有効なメーカー発注書がある間は新しい版を登録できません。発注書を取り消してから版を変更してください |  |
| `UNKNOWN_APPROVAL_ORGANIZATION` | 422 | 承認する組織（顧客またはセブン化学）を選んでください |  |
| `UNKNOWN_APPROVAL_DECISION` | 422 | 承認か承認取消かを選んでください |  |
| `UNKNOWN_EVIDENCE_SOURCE` | 422 | 承認証跡の種類（メール・署名書類・その他確認済み）を選んでください |  |
| `EVIDENCE_DOCUMENT_VERSION_REQUIRED` | 422 | 承認証跡の書類を選んでください |  |
| `EVIDENCE_DOCUMENT_VERSION_INVALID` | 422 | 承認証跡の書類の指定が正しくありません |  |
| `EVIDENCE_DOCUMENT_VERSION_NOT_FOUND` | 422 | 承認証跡の書類が見つかりません |  |
| `EVIDENCE_DOCUMENT_TYPE_INVALID` | 422 | 承認証跡には「承認証跡」の種類の書類を選んでください |  |
| `EVIDENCE_DOCUMENT_UNREADABLE` | 422 | 承認証跡のファイルを読み取れないため確認できません。代表者へ連絡してください |  |
| `EVIDENCE_PROJECT_MISMATCH` | 422 | 承認証跡がこの案件に見つかりません |  |
| `EVIDENCE_ORDER_MISMATCH` | 422 | 承認証跡は別の発注に紐付いています |  |
| `EVIDENCE_DESIGN_MISMATCH` | 422 | 承認証跡は別のデザインに紐付いています |  |
| `EVIDENCE_IDENTIFIER_REQUIRED` | 422 | 承認証跡の識別子（メッセージIDや署名ブロックなど）を入力してください |  |
| `EVIDENCE_IDENTIFIER_TOO_SHORT` | 422 | 承認証跡の識別子は8文字以上で入力してください |  |
| `EVIDENCE_IDENTIFIER_NOT_IN_DOCUMENT` | 422 | 入力した識別子が承認証跡のファイル内に見つかりません。ファイルに実際に書かれている識別子を入力してください |  |
| `EVIDENCE_IDENTIFIER_NOT_EXTRACTABLE` | 422 | 保存されたメール（EML）からメッセージIDを取り出せませんでした |  |
| `EVIDENCE_IDENTIFIER_REUSED_ACROSS_ORGANIZATIONS` | 422 | この識別子はもう一方の組織の承認ですでに使われています。組織ごとに別の識別子を使ってください |  |
| `EVIDENCE_DUPLICATE_REGISTRATION` | 422 | 同じ組織で同じ承認証跡はすでに登録されています。置き換える場合は、置き換える記録を選んでください |  |
| `EVIDENCE_VERSION_NOT_CURRENT` | 422 | メッセージIDを自動で取り出せるのは、承認証跡の最新バージョンだけです |  |
| `EVENT_TIME_REQUIRED` | 422 | 承認された日時を入力してください |  |
| `SUPERSEDED_EVENT_MISMATCH` | 422 | 置き換える承認の記録がこの版に見つかりません |  |
| `EVIDENCE_ISSUER_MISMATCH` | 422 | 承認証跡の発行元が承認する組織と違います。顧客の承認には「顧客作成」、セブン化学の承認には「セブン化学」発行の承認書類を使ってください | `organization`, `evidenceIssuerEntity`, `expectedIssuerEntity`。承認記録時と代表確認（confirmed）時の両方で返る |
| `EVIDENCE_SHARED_ACROSS_ORGANIZATIONS` | 422 | この承認証跡はもう一方の組織の承認にすでに使われています。組織ごとに別の承認書類を登録してください | `organization`, `evidenceIssuerEntity`, `expectedIssuerEntity`。例外は `sharedEvidence: true` + `sharedEvidenceReason` |
| `SHARED_EVIDENCE_ISSUER_INVALID` | 422 | 共有証跡として使えるのは、顧客作成またはセブン化学が発行した承認書類だけです | `organization`, `evidenceIssuerEntity` |
| `SHARED_EVIDENCE_REASON_REQUIRED` | 422 | 両組織で同じ承認証跡を使う理由を入力してください |  |
| `SHARED_EVIDENCE_REASON_TOO_LONG` | 422 | 共有証跡の理由が長すぎます。1000文字以下にしてください |  |
| `SHARED_EVIDENCE_NOT_CITED_BY_OTHER_ORGANIZATION` | 422 | 共有証跡の例外は、もう一方の組織が同じ承認証跡ですでに承認を記録している場合だけ使えます。先にもう一方の組織の承認を記録してください |  |
| `SAME_CONTENT_OTHER_ISSUER` | 401 | 同じ内容の承認証跡が別の発行元ですでに登録されています。組織ごとに別の承認書類を使ってください |  |
| `SHARED_EVIDENCE_FLAG_INVALID` | 422 | 共有証跡の指定が正しくありません。画面を再読み込みしてください |  |

## manual verification (approval evidence / send)

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `UNKNOWN_EVIDENCE_VERIFICATION_RESULT` | 422 | 確認結果は「確認済み」か「相違あり」から選んでください |  |
| `VERIFIER_NAME_REQUIRED` | 422 | 確認者が必要です |  |
| `VERIFIED_AT_REQUIRED` | 422 | 確認日時が必要です |  |
| `VERIFIED_AT_IN_FUTURE` | 422 | 確認日時に未来の時刻は記録できません |  |
| `VERIFIED_AT_OUT_OF_RANGE` | 422 | 確認日時が正しくありません |  |
| `VERIFICATION_REASON_REQUIRED` | 422 | 確認の根拠（原本のどこで何を確認したか）を入力してください |  |
| `EVIDENCE_VERIFICATION_TARGET_INVALID` | 422 | 承認取消の記録は手動確認の対象ではありません |  |
| `EVIDENCE_NOT_PENDING_MANUAL_VERIFICATION` | 422 | この承認は手動確認待ちではありません（確認済みまたは自動確認済み） |  |
| `EVIDENCE_IDENTIFIER_MISSING` | 422 | この承認には識別子が記録されていないため確認できません |  |
| `EVIDENCE_REQUIRES_REPLACEMENT` | 422 | この承認は、もう一方の組織と同じ承認証跡、または別の発行元の証跡で記録されているため数えられません。その組織が発行した承認書類で承認を記録し直してください |  |
| `EVIDENCE_ALREADY_CONFIRMED` | 422 | この承認はすでに確認済みです。訂正する場合は、その組織の承認取消として記録してください |  |
| `EVIDENCE_ALREADY_VERIFIED` | 422 | この承認はすでに手動確認が記録されています。訂正する場合は、その組織の承認取消として記録してください |  |
| `MAKER_PO_SEND_VERIFICATION_TARGET_INVALID` | 422 | 手動確認できるのは送信の記録だけです |  |
| `MAKER_PO_SEND_NOT_PENDING_MANUAL_VERIFICATION` | 422 | この送信は手動確認待ちではありません |  |
| `MAKER_PO_SEND_ALREADY_CONFIRMED` | 422 | この送信はすでに確認済みです。取り消す場合は新しい記録として残してください |  |
| `MAKER_PO_CANCELLED_SEND_CONFIRMATION_BLOCKED` | 422 | 取り消し済みのメーカー発注書の送信は確認できません |  |

## maker purchase orders

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `RECIPIENT_ADDRESS_REQUIRED` | 422 | メーカーの送信先メールアドレスを入力してください |  |
| `RECIPIENT_ADDRESS_INVALID` | 422 | メーカーの送信先はメールアドレスの形式で入力してください（例: order@maker.example.jp）。住所や名前は入力できません | 発注書作成時。R10 以前の発注書は代表承認時にも返る（取り消して作り直す） |
| `INVALID_MAKER_PO_AMOUNTS` | 422 | 金額は通貨と合計金額の両方を入力してください |  |
| `MAKER_PO_NOT_READY` | 422 | メーカー発注書は「メーカー発注準備完了」の発注にだけ作成できます |  |
| `MAKER_PO_ALREADY_EXISTS` | 422 | この発注には有効なメーカー発注書がすでにあります。内容を直す場合は、今の発注書を取り消してから作り直してください | `existingMakerPurchaseOrderId`, `existingStatus`（ある場合） |
| `MAKER_PO_TRANSITION_BLOCKED` | 422 | メーカー発注書の今の状態では、この操作はできません。画面を再読み込みしてください |  |
| `MAKER_PO_STATE_CHANGED` | 422 | メーカー発注書の状態が別の操作で変わりました。画面を再読み込みしてください |  |
| `MAKER_PO_LOCK_CONFLICT` | 409 | 同じ発注への操作が重なりました。少し待ってからもう一度お試しください |  |
| `ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED` | 409 | 保留・見直し中の発注のメーカー発注書は進められません。状態を解決してから記録してください |  |
| `FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED` | 409 | 取消で終了した発注のメーカー発注書は操作できません |  |
| `MAKER_PO_CANCELLATION_ACK_REQUIRED` | 422 | 送信済みのメーカー発注書が取り消されています。新しい発注書を作る前に、メーカーの取消確認を記録してください |  |
| `MAKER_PO_CANCEL_REASON_REQUIRED` | 422 | メーカー発注書を取り消す理由を入力してください |  |
| `MAKER_PO_CANCEL_REASON_TOO_LONG` | 422 | メーカー発注書を取り消す理由が長すぎます。1000文字以下にしてください |  |
| `MAKER_CANCELLATION_ACK_REASON_REQUIRED` | 422 | メーカーの取消確認の内容（メモ）を入力してください |  |
| `MAKER_CANCELLATION_ACK_REASON_TOO_LONG` | 422 | メーカーの取消確認の内容（メモ）が長すぎます。1000文字以下にしてください |  |
| `MAKER_PO_NOT_CANCELLED` | 422 | 取消確認は、取り消し済みのメーカー発注書にだけ記録できます |  |
| `MAKER_CANCELLATION_ACK_ALREADY_RECORDED` | 422 | この発注書の取消確認はすでに記録されています |  |
| `MAKER_CANCELLATION_ACK_EVIDENCE_INVALID` | 422 | 取消確認の証跡の指定が正しくありません |  |
| `MAKER_CANCELLATION_ACK_EVIDENCE_NOT_FOUND` | 422 | 取消確認の証跡が見つかりません |  |
| `MAKER_CANCELLATION_ACK_EVIDENCE_TYPE_INVALID` | 422 | 取消確認の証跡には「受領証跡」の書類を選んでください |  |
| `MAKER_CANCELLATION_ACK_EVIDENCE_NOT_VERIFIED` | 422 | 取消確認の証跡は、先に文書画面で確認済みにしてください |  |
| `MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH` | 422 | 取消確認の証跡は、同じ案件・発注・メーカー発注書のものを選んでください |  |
| `MAKER_CANCELLATION_ACK_TIME_FORMAT_INVALID` | 422 | 取消確認の日時が正しくありません |  |
| `MAKER_CANCELLATION_ACK_TIME_BEFORE_CANCELLATION` | 422 | 取消確認の日時は、取消を記録した日時より後にしてください |  |
| `MAKER_CANCELLATION_ACK_TIME_IN_FUTURE` | 422 | 取消確認の日時に未来の時刻は記録できません |  |
| `MAKER_CANCELLATION_ACK_TIME_OUT_OF_RANGE` | 422 | 取消確認の日時が正しくありません |  |
| `UNKNOWN_MAKER_PO_STATUS` | 422 | メーカー発注書の状態を読み取れません。代表者へ連絡してください |  |
| `UNKNOWN_MAKER_PO_EVENT_TYPE` | 422 | メーカー発注書の記録の種類を読み取れません。代表者へ連絡してください |  |
| `UNKNOWN_MAKER_PO_VERIFICATION_STATUS` | 422 | メーカー発注書の確認状態を読み取れません。代表者へ連絡してください |  |
| `SNAPSHOT_VOIDED` | 422 | 発注の内容が代表承認時から変わったため、承認は無効になりました。もう一度代表承認を受けてください |  |

## send evidence

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `SENDER_ADDRESS_REQUIRED` | 422 | 送信元のメールアドレスが必要です |  |
| `RECIPIENTS_REQUIRED` | 422 | 送信先のメールアドレスが必要です |  |
| `SENT_AT_REQUIRED` | 422 | 送信日時が必要です |  |
| `SENT_AT_IN_FUTURE` | 422 | 送信日時が現在より10分以上先です。メールの送信日時を確認してください |  |
| `INVALID_ATTACHMENT_HASH` | 422 | 添付ファイルの記録が正しくありません。元のEMLを選び直してください |  |
| `SEND_RECIPIENT_MISMATCH` | 422 | 送信メールの宛先に、発注書の送信先メールアドレスが含まれていません。正しい送信メールを選ぶか、代表者に確認を依頼してください |  |
| `SEND_EVIDENCE_CONTENT_REQUIRED` | 422 | 送信証跡のEMLファイルを選んでください |  |
| `SEND_EVIDENCE_CONTENT_INVALID` | 422 | 送信証跡のファイルを読み取れませんでした。元のEMLを選び直してください |  |
| `SEND_EVIDENCE_DOCUMENT_VERSION_INVALID` | 422 | 送信証跡の書類の指定が正しくありません |  |
| `SEND_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND` | 422 | 送信証跡の書類が見つかりません |  |
| `SEND_EVIDENCE_DOCUMENT_TYPE_INVALID` | 422 | 送信証跡には「送信証跡」の種類の書類を選んでください |  |
| `SEND_EVIDENCE_DOCUMENT_UNREADABLE` | 422 | 送信証跡のファイルを読み取れないため確認できません。代表者へ連絡してください |  |
| `SEND_EVIDENCE_PROJECT_MISMATCH` | 422 | 送信証跡がこの案件に見つかりません |  |
| `SEND_EVIDENCE_ORDER_MISMATCH` | 422 | 送信証跡は別の発注に紐付いています |  |
| `SEND_EVIDENCE_FROM_CANCELLED_PO` | 422 | この送信証跡は取り消し済みのメーカー発注書の送信メールです。今の発注書を送信したメールのEMLを登録してください | 候補は GET /api/maker-purchase-orders/:poId/send-evidence-candidates（取消分は除外済み、`excludedCancelledCount`） |

## acceptance / delivery evidence

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `ACCEPT_EVIDENCE_REQUIRED` | 422 | 受領証跡の書類を選んでください |  |
| `ACCEPT_EVIDENCE_DOCUMENT_VERSION_INVALID` | 422 | 受領証跡の書類の指定が正しくありません |  |
| `ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND` | 422 | 受領証跡の書類が見つかりません |  |
| `ACCEPT_EVIDENCE_DOCUMENT_TYPE_INVALID` | 422 | 受領証跡には「受領証跡」の種類の書類を選んでください |  |
| `ACCEPT_EVIDENCE_NOT_VERIFIED` | 422 | 受領証跡を先に文書画面で確認済みにしてください |  |
| `ACCEPT_EVIDENCE_PROJECT_MISMATCH` | 422 | 受領証跡がこの案件に見つかりません |  |
| `ACCEPT_EVIDENCE_ORDER_MISMATCH` | 422 | 受領証跡は別の発注に紐付いています |  |
| `ACCEPT_EVIDENCE_PO_MISMATCH` | 422 | 受領証跡は別のメーカー発注書に紐付いています |  |
| `DELIVERY_EVIDENCE_REQUIRED` | 422 | 納品の証跡（受領証跡）を選んでください |  |
| `DELIVERY_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND` | 422 | 納品の証跡が見つかりません |  |
| `DELIVERY_EVIDENCE_DOCUMENT_TYPE_INVALID` | 422 | 納品の証跡には「受領証跡」の種類の書類を選んでください |  |
| `DELIVERY_EVIDENCE_NOT_VERIFIED` | 422 | 納品の証跡を先に文書画面で確認済みにしてください |  |
| `DELIVERY_EVIDENCE_PROJECT_MISMATCH` | 422 | 納品の証跡がこの案件に見つかりません |  |
| `DELIVERY_EVIDENCE_ORDER_MISMATCH` | 422 | 納品の証跡は別の発注に紐付いています |  |
| `DELIVERY_ALREADY_CONFIRMED` | 422 | この納品はすでに確認済みです |  |
| `DELIVERY_SEQUENCE_EXISTS` | 422 | この納品の連番はすでに登録されています |  |
| `INVALID_DELIVERY_SEQUENCE` | 422 | 納品の連番は1以上の整数にしてください |  |
| `DELIVERY_UNIT_MISMATCH` | 422 | 納品の単位は発注の明細と同じ単位にしてください | `lineUnit`, `deliveredUnit`（単位の値。表示は日本語ラベルに変換） |
| `RECEIPT_ASSUMPTION_ACTION_REQUIRED` | 422 | 「受領確認（問題なしとみなす）」は専用の記録操作でだけ行えます |  |
| `RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED` | 422 | 証跡なしで受領とみなすことへの同意にチェックしてください |  |
| `RECEIPT_ASSUMPTION_NOTE_REQUIRED` | 422 | 問題なしとみなす理由を入力してください |  |
| `RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED` | 422 | 受領確認は「フィルム納品済み」の発注でだけ記録できます |  |
| `RECEIPT_ASSUMPTION_STATE_CHANGED` | 422 | フィルム発注の状態が別の操作で変わりました。画面を再読み込みしてください |  |
| `INVALID_RECEIPT_ASSUMED_AT` | 422 | 受領確認の日付が正しくありません |  |
| `INVALID_DATE` | 422 | 日付が正しくありません。日付の形式を確認してください |  |

## P1 R23: automatic steps

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `AUTO_TRANSITION_ONLY` | 422 | この段階は条件がそろうと自動で進みます。手で進める必要はありません | `from`, `to`, `autoAdvanceEndpoint`。P1 R23: 校正ゲラ準備完了・校了確認待ち・製造先発注準備完了は手で押さない（ボタンを出さない） |
| `ARTWORK_REVISION_REQUIRED` | 200 (blockers) | 校正ゲラ（版）がまだ登録されていません。版を登録すると自動で進みます | 拒否ではない。GET /api/film-supply-orders/:orderId/auto-advance の `nextAutomatic.blockers[]` に入る |
| `PROJECT_CONTEXT_MISMATCH` | 409 | 別のタブで案件が切り替わりました。保存していません。画面を再読み込みしてください | P1 の新しい書き込み（auto-advance, return）で本文 `expectedProjectId` が対象の案件と違うとき。Web 側 R03 と同じ文言 |

## P1 R24: approval card / return

| code | HTTP | 意味（サーバー既定の日本語文） | 追加項目・画面での扱い |
|---|---|---|---|
| `MAKER_PO_RETURN_REASON_REQUIRED` | 422 | 差し戻しの理由を入力してください |  |
| `MAKER_PO_RETURN_REASON_TOO_LONG` | 422 | 差し戻しの理由は1000文字以下にしてください |  |
| `MAKER_PO_RETURN_ONLY_DRAFT` | 422 | 差し戻しできるのは代表承認前のメーカー発注書だけです。承認済みの発注書は取消の手順を使ってください | `from`（発注書の状態） |
| `MAKER_PO_SNAPSHOT_CHANGED` | 409 | 承認画面を開いた後に発注書の内容（明細・版）が変わりました。最新の内容を確認してから、もう一度承認してください | `expectedSnapshotSha256`, `snapshotSha256`。承認カード（GET …/approval-card）を読み直す |
| `EXPECTED_SNAPSHOT_SHA256_INVALID` | 422 | 承認する発注書の確認値が正しくありません。画面を再読み込みしてください | `expectedSnapshotSha256` は 64 文字の小文字 16 進 |
| `MAKER_PO_AMOUNT_MISSING` | 200 (warnings) | メーカー発注書に金額が記載されていません。担当者に金額の入力を依頼してください | 拒否ではない。承認カードの `warnings[]`（現時点でサーバーは金額なしの承認を拒否しない） |
| `MAKER_PO_SNAPSHOT_DRIFTED` | 200 (warnings) | 発注書の作成後に明細または版が変わりました。承認すると最新の内容で確定します | 拒否ではない。承認カードの `warnings[]` |

