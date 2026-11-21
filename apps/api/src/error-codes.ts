/**
 * P0 R09: every refusal the API sends carries a stable `code`, and its `error`
 * text is Japanese a person can act on — no English core message, no enum or
 * field name, no internal URL or port. The web builds its own dictionary from
 * the same codes (ERROR_CODES.md); this one is the server's fallback text.
 *
 * `ERROR_MESSAGES_JA` is the single list of codes. A test scans every
 * `code: '…'` literal in apps/api/src and packages/core/src and fails when one
 * is missing here, so a new refusal cannot ship without its message.
 */
export const ERROR_MESSAGES_JA: Readonly<Record<string, string>> = {
  // ---- authentication / authorization / generic
  AUTH_REQUIRED: 'ログインが必要です。ログインの有効期限が切れた場合は、もう一度ログインしてください',
  INVALID_CREDENTIALS: 'ユーザー名またはパスワードが正しくありません',
  CREDENTIALS_REQUIRED: 'ユーザー名とパスワードを入力してください',
  LOGIN_TEMPORARILY_LOCKED: 'ログインの試行回数が多いため、しばらく待ってから再試行してください',
  LOGIN_TIMEOUT: 'ログイン処理が時間内に終わりませんでした。数分後にもう一度お試しください',
  FORBIDDEN: 'この操作を行う権限がありません',
  CEO_ONLY: 'この操作は代表者だけが行えます',
  CSRF_ORIGIN_REJECTED: '許可されていない画面からの送信のため受け付けませんでした。画面を再読み込みしてください',
  INVALID_PATH_PARAMETER: '指定された対象のIDが正しくありません。画面を再読み込みしてください',
  ROUTE_NOT_FOUND: '指定された操作は存在しません',
  BAD_REQUEST: '送信内容を読み取れませんでした。入力内容を確認してください',
  VALIDATION_FAILED: '入力内容を確認してください',
  NOT_FOUND: '対象が見つかりません。削除されたか、別の案件の記録の可能性があります',
  CONFLICT: '他の操作と重なったため保存できませんでした。画面を再読み込みしてからやり直してください',
  TOO_MANY_REQUESTS: '操作が多すぎます。しばらく待ってから再試行してください',
  PAYLOAD_TOO_LARGE: '送信データが大きすぎます。ファイルの大きさを確認してください',
  INTERNAL_ERROR: '予期しないエラーが発生しました。画面を再読み込みしても続く場合は代表者へ連絡してください',
  SERVICE_UNAVAILABLE: 'システムが一時的に利用できません。数分後に再読み込みしてください',

  // ---- R04: outage
  DB_UNAVAILABLE: 'システムに接続できません（データベース）。入力した内容は保存されていません。数分後に再読み込みしてください',
  DB_TIMEOUT: 'データベースの応答が時間内に返りませんでした。入力した内容は保存されていません。数分後にもう一度お試しください',

  // ---- R05: duplicates / idempotency
  DUPLICATE: 'この番号はすでに登録されています。登録済みの記録を確認してください',
  IDEMPOTENCY_KEY_INVALID: '送信の識別キーが正しくありません。画面を再読み込みしてからやり直してください',
  IDEMPOTENCY_KEY_REUSED: '同じ送信の識別キーで別の内容が送られました。画面を再読み込みしてからやり直してください',

  // ---- not found
  PROJECT_NOT_FOUND: '案件が見つかりません',
  FILM_SUPPLY_ORDER_NOT_FOUND: 'フィルム発注が見つかりません',
  MAKER_PO_NOT_FOUND: 'メーカー発注書が見つかりません',
  MAKER_PO_EVENT_NOT_FOUND: 'メーカー発注書の記録が見つかりません',
  SEVEN_PO_NOT_FOUND: 'セブン化学発注書が見つかりません',
  ARTWORK_REVISION_NOT_FOUND: '版が見つかりません',
  DOCUMENT_NOT_FOUND: '書類が見つかりません',
  DOCUMENT_VERSION_NOT_FOUND: '書類のバージョンが見つかりません',
  PRE_ORDER_REFERENCE_NOT_FOUND: '先行発注の参照が見つかりません',
  FILLING_ORDER_NOT_FOUND: '充填発注が見つかりません',
  DELIVERY_NOT_FOUND: '納品の記録が見つかりません',
  APPROVAL_EVENT_NOT_FOUND: '承認の記録が見つかりません',
  FILM_ORDER_LINE_NOT_FOUND: '発注の明細が見つかりません',
  FILLING_ORDER_LINE_NOT_FOUND: '充填発注の明細が見つかりません',

  // ---- project
  PROJECT_UPDATE_INVALID: '案件名を入力してください',
  PROJECT_FIELDS_REQUIRED: '案件コード・案件名・取引先（顧客・セブン化学・メーカー）を入力してください',
  PROJECT_ACCOUNT_ROLE_INVALID: '取引先の役割（顧客・セブン化学・メーカー）が正しくありません',
  PROJECT_ACCOUNT_INVALID: '選んだ取引先は使用できません（無効または削除済み）',
  PROJECT_ACCOUNTS_REQUIRED: '顧客・セブン化学・メーカーの3社を別々に選んでください',
  UNSUPPORTED_ROUTE: 'この案件の種類はまだ作成できません（作成できるのはF1案件だけです）',
  ROUTE_IMMUTABLE: '案件の種類はあとから変更できません',

  // ---- R01: payment terms
  PAYMENT_TERMS_REQUIRED: '支払条件を選んでください（前払い・納品後払い・未定）',
  UNKNOWN_PAYMENT_TERMS: '支払条件は「前払い」「納品後払い」「未定」から選んでください',
  PAYMENT_TERMS_LOCKED: '代表承認済みのメーカー発注書がある、または保留・見直し中のため、支払条件は変更できません',
  PAYMENT_TERMS_REASON_TOO_LONG: '支払条件の変更理由が長すぎます。1000文字以下にしてください',
  PAYMENT_TERMS_REASON_INVALID: '支払条件の変更理由が空です。理由を書くか、欄を空のままにしてください',
  PAYMENT_TERMS_CHANGED: '承認画面を開いた後に支払条件が変更されました。最新の支払条件を確認してから、もう一度承認してください',
  PAYMENT_GATE_UNSATISFIED: '支払条件が「未定」のため代表承認できません。フィルム発注の支払条件を「前払い」または「納品後払い」に変更してから承認してください',
  PAYMENT_TERMS_UNDETERMINED: '支払条件が「未定」です。代表承認の前に「前払い」または「納品後払い」を選んでください',

  // ---- seven purchase orders / pre-order references
  PO_NUMBER_REQUIRED: '発注番号を入力してください',
  REFERENCE_CODE_REQUIRED: '参照コードを入力してください',
  OFFICIAL_REGISTRATION_REQUIRED: 'セブン化学発注書の公式登録日が必要です。原本受領日は参考情報のため代わりになりません',
  OFFICIAL_DATE_ALREADY_REGISTERED: '公式登録日が別の操作で先に登録されました。画面を再読み込みしてください',
  SEVEN_PO_REQUIRED: '発注にセブン化学発注書（確認済み）を紐付けてください',
  SEVEN_PO_NOT_LINKED: 'この参照に紐付くセブン化学発注書がありません',
  SEVEN_PO_NOT_VERIFIED: 'セブン化学発注書の真正性確認（チェックリスト）が完了していません',
  SEVEN_PO_PROJECT_MISMATCH: 'セブン化学発注書がこの案件に見つかりません',
  PO_REVIEW_PENDING: '見積とセブン化学発注書の突合レビューが未解決です。レビューを終えてから進めてください',
  CHECKLIST_INCOMPLETE: '真正性確認のチェック項目に未記録のものがあります。すべての項目を記録してください',
  CONFIRMATION_REPLY_REQUIRED: '判断に迷う点がある場合は、確認の返信内容を記録してください',

  // ---- film / filling orders and lines
  ORDER_CODE_REQUIRED: '発注コードを入力してください',
  DESCRIPTION_REQUIRED: '明細の内容を入力してください',
  INVALID_LINE_NUMBER: '明細の行番号は1以上の整数にしてください',
  INVALID_QUANTITY: '数量は0より大きい数値で入力してください',
  UNKNOWN_UNIT: '単位を一覧から選んでください',
  UNIT_DOMAIN_MISMATCH: 'この発注では使えない単位です。フィルムと充填の単位を確認してください',
  FILM_ORDER_LINE_REQUIRED: '明細を選んでください',
  FILLING_ORDER_LINE_REQUIRED: '充填発注の明細を選んでください',
  FILM_SUPPLY_ORDER_PROJECT_MISMATCH: '紐付けるフィルム発注がこの案件に見つかりません',

  // ---- film order state machine
  UNKNOWN_STATE: '進める先の状態が正しくありません。画面を再読み込みしてください',
  INVALID_TRANSITION: 'この状態からは選んだ状態へ進めません。画面を再読み込みして現在の状態を確認してください',
  FILM_ORDER_CANCELLED: 'この発注は取消で終了しているため、変更できません',
  FILM_ORDER_STATE_CHANGED: '発注の状態が別の操作で変わりました。画面を再読み込みしてください',
  FILM_ORDER_LOCK_CONFLICT: '同じ発注への操作が重なりました。少し待ってからもう一度お試しください',
  MAKER_CHAIN_TRANSITION_FORBIDDEN: 'メーカー発注書の状態は、メーカー発注書の画面（代表承認・送信証跡・受領証跡）からだけ進められます',
  DUAL_APPROVAL_REQUIRED: 'すべてのデザインで顧客とセブン化学の両方の承認が必要です',
  DUAL_APPROVAL_NO_LONGER_VALID: '両組織の承認が取り消されたため、この操作は行えません。承認の状況を確認してください',
  HOLD_REASON_REQUIRED: '保留にする理由を入力してください',
  HOLD_REASON_TOO_LONG: '保留理由が長すぎます。1000文字以下にしてください',
  EVIDENCE_NOTE_TOO_LONG: '証跡がないまま進める理由が長すぎます。1000文字以下にしてください',
  ORDER_NOT_ON_HOLD: 'この発注は保留中ではありません。画面を再読み込みしてください',
  HOLD_RELEASE_REASON_REQUIRED: '保留を解除する理由を入力してください',
  HOLD_RELEASE_REASON_TOO_LONG: '保留を解除する理由が長すぎます。1000文字以下にしてください',
  HOLD_ORIGIN_UNKNOWN: '保留前の状態が記録されていないため、戻す先の状態を選んでください',
  HOLD_RELEASE_STATE_CONFLICT: '保留の状態が別の操作で変わりました。画面を再読み込みしてください',
  HOLD_RESUME_EVIDENCE_MISMATCH: '戻す先の状態に必要なメーカー発注書の証跡がありません',
  HOLD_RESUME_STATUS_INVALID: '戻す先として選べるのは保留前の状態だけです',
  ORDER_NOT_IN_CANCELLATION_REVIEW: 'この発注は取消レビュー中ではありません。画面を再読み込みしてください',
  CANCELLATION_REVIEW_RESOLUTION_REQUIRED: '取消レビューは、取消レビューの解決操作（代表者）でだけ終了できます',
  CANCELLATION_REVIEW_STATE_CHANGED: '取消レビューの状態が別の操作で変わりました。画面を再読み込みしてください',
  CANCELLATION_REASON_REQUIRED: '取消レビューを解決する理由を入力してください',
  CANCELLATION_REASON_TOO_LONG: '取消レビューを解決する理由が長すぎます。1000文字以下にしてください',
  CANCELLATION_OUTCOME_INVALID: '取消レビューの結果は「再開」か「取消で終了」から選んでください',
  CANCELLATION_RESUME_REQUIRED: '取消レビュー前の状態が記録されていないため、再開する状態を選んでください',
  CANCELLATION_RESUME_TARGET_INVALID: '再開できるのは取消レビュー前の状態だけです',
  CANCELLATION_RESUME_EVIDENCE_MISMATCH: '再開する状態に必要なメーカー発注書の証跡がありません',
  PRINTED_CHANGE_ADMIN_APPROVAL_REQUIRED: '印刷開始後の変更には代表者の承認が必要です',

  // ---- change requests
  CHANGE_REQUEST_REASON_REQUIRED: '変更理由を入力してください',
  CHANGE_REQUEST_ORGANIZATION_REQUIRED: '変更を依頼した組織（顧客またはセブン化学）を選んでください',
  CHANGE_REQUEST_EVIDENCE_REQUIRED: '変更依頼の証跡（書類）を選んでください',
  CHANGE_REQUEST_EVIDENCE_PROJECT_MISMATCH: '変更依頼の証跡がこの案件に見つかりません',
  CHANGE_REQUEST_EVIDENCE_BINDING_INVALID: '変更依頼の証跡は、この発注・デザインの承認証跡を選んでください',
  CHANGE_REQUEST_IMPACT_SCHEDULE_REQUIRED: '納期への影響を入力してください（ない場合は「なし」）',
  CHANGE_REQUEST_LOT_MARKING_REQUIRED: 'ロット変更では新しいロット表示を入力してください',
  CHANGE_REQUEST_NUMERIC_FIELD_REQUIRED: '数値の項目を入力してください（ゼロの場合も0と入力）',
  CHANGE_REQUEST_NUMERIC_FIELD_INVALID: '数値の項目は0以上にしてください',
  CHANGE_REQUEST_NUMERIC_FIELD_TOO_LARGE: '数値が大きすぎます',
  CHANGE_REQUEST_DECIMAL_SCALE_INVALID: '小数点以下の桁数が多すぎます',

  // ---- documents
  UNKNOWN_DOCUMENT_TYPE: '書類の種類を一覧から選んでください',
  UNKNOWN_ISSUER_ENTITY: '書類の発行元を一覧から選んでください',
  DOCUMENT_FILE_REQUIRED: 'ファイルを選んでください',
  DOCUMENT_CONTENT_REQUIRED: 'ファイルを選んでください',
  DOCUMENT_FILENAME_REQUIRED: 'ファイル名が必要です',
  DOCUMENT_EMPTY: 'ファイルが空です。中身のあるファイルを選んでください',
  DOCUMENT_TOO_LARGE: 'ファイルが大きすぎます。上限（5MB）以下のファイルを選んでください',
  DOCUMENT_TYPE_REJECTED: 'このファイル形式は登録できません（PDF・画像・EML・テキスト・CSVなど）',
  DOCUMENT_CONTENT_MISMATCH: 'ファイルの中身と選んだ形式が一致しません。正しい形式を選ぶか、元のファイルを選び直してください',
  DOCUMENT_UNREADABLE: '保存されている書類ファイルを読み取れません。代表者へ連絡してください',
  DOCUMENT_INTEGRITY_INVALID: '書類ファイルが登録時と一致しません。代表者へ連絡してください',
  DOCUMENT_BINDING_CONFLICT: '同じ書類がすでに別の発注・デザインに紐付いています。別のファイル名で登録してください',
  INVALID_UPLOAD_PAYLOAD: 'アップロードの内容を読み取れませんでした。もう一度ファイルを選んでください',
  INVALID_VERIFICATION_STATUS: '確認結果は「確認済み」か「相違あり」から選んでください',
  DESIGN_KEY_REQUIRED: '発注に紐付ける書類にはデザイン（デザインキー）が必要です',
  MAKER_PO_BINDING_MISMATCH: '紐付けるメーカー発注書が、この書類の発注に見つかりません',

  // ---- artwork revisions and approvals
  ORDER_NOT_PAST_SEVEN_PO_VERIFIED: '版はセブン化学発注書の確認が済んだ発注にだけ登録できます',
  INVALID_REVISION_NUMBER: '版番号は1以上の整数にしてください',
  REVISION_NUMBER_EXISTS: 'この版番号はすでに登録されています',
  FILE_DOCUMENT_VERSION_REQUIRED: '版のファイル（校正ファイル）を選んでください',
  FILE_DOCUMENT_VERSION_INVALID: '版のファイルの指定が正しくありません',
  FILE_DOCUMENT_TYPE_INVALID: '版のファイルには「校正」の種類の書類を選んでください',
  FILE_DOCUMENT_PROJECT_MISMATCH: '版のファイルがこの案件に見つかりません',
  FILE_DOCUMENT_ORDER_MISMATCH: '版のファイルは別の発注に紐付いています',
  FILE_DOCUMENT_DESIGN_MISMATCH: '版のファイルは別のデザインに紐付いています',
  MAKER_PO_ACTIVE_ARTWORK_REVISION_BLOCKED: '有効なメーカー発注書がある間は新しい版を登録できません。発注書を取り消してから版を変更してください',
  UNKNOWN_APPROVAL_ORGANIZATION: '承認する組織（顧客またはセブン化学）を選んでください',
  UNKNOWN_APPROVAL_DECISION: '承認か承認取消かを選んでください',
  UNKNOWN_EVIDENCE_SOURCE: '承認証跡の種類（メール・署名書類・その他確認済み）を選んでください',
  EVIDENCE_DOCUMENT_VERSION_REQUIRED: '承認証跡の書類を選んでください',
  EVIDENCE_DOCUMENT_VERSION_INVALID: '承認証跡の書類の指定が正しくありません',
  EVIDENCE_DOCUMENT_VERSION_NOT_FOUND: '承認証跡の書類が見つかりません',
  EVIDENCE_DOCUMENT_TYPE_INVALID: '承認証跡には「承認証跡」の種類の書類を選んでください',
  EVIDENCE_DOCUMENT_UNREADABLE: '承認証跡のファイルを読み取れないため確認できません。代表者へ連絡してください',
  EVIDENCE_PROJECT_MISMATCH: '承認証跡がこの案件に見つかりません',
  EVIDENCE_ORDER_MISMATCH: '承認証跡は別の発注に紐付いています',
  EVIDENCE_DESIGN_MISMATCH: '承認証跡は別のデザインに紐付いています',
  EVIDENCE_IDENTIFIER_REQUIRED: '承認証跡の識別子（メッセージIDや署名ブロックなど）を入力してください',
  EVIDENCE_IDENTIFIER_TOO_SHORT: '承認証跡の識別子は8文字以上で入力してください',
  EVIDENCE_IDENTIFIER_NOT_IN_DOCUMENT: '入力した識別子が承認証跡のファイル内に見つかりません。ファイルに実際に書かれている識別子を入力してください',
  EVIDENCE_IDENTIFIER_NOT_EXTRACTABLE: '保存されたメール（EML）からメッセージIDを取り出せませんでした',
  EVIDENCE_IDENTIFIER_REUSED_ACROSS_ORGANIZATIONS: 'この識別子はもう一方の組織の承認ですでに使われています。組織ごとに別の識別子を使ってください',
  EVIDENCE_DUPLICATE_REGISTRATION: '同じ組織で同じ承認証跡はすでに登録されています。置き換える場合は、置き換える記録を選んでください',
  EVIDENCE_VERSION_NOT_CURRENT: 'メッセージIDを自動で取り出せるのは、承認証跡の最新バージョンだけです',
  EVENT_TIME_REQUIRED: '承認された日時を入力してください',
  SUPERSEDED_EVENT_MISMATCH: '置き換える承認の記録がこの版に見つかりません',
  EVIDENCE_ISSUER_MISMATCH: '承認証跡の発行元が承認する組織と違います。顧客の承認には「顧客作成」、セブン化学の承認には「セブン化学」発行の承認書類を使ってください',
  EVIDENCE_SHARED_ACROSS_ORGANIZATIONS: 'この承認証跡はもう一方の組織の承認にすでに使われています。組織ごとに別の承認書類を登録してください',
  SHARED_EVIDENCE_ISSUER_INVALID: '共有証跡として使えるのは、顧客作成またはセブン化学が発行した承認書類だけです',
  SHARED_EVIDENCE_REASON_REQUIRED: '両組織で同じ承認証跡を使う理由を入力してください',
  SHARED_EVIDENCE_REASON_TOO_LONG: '共有証跡の理由が長すぎます。1000文字以下にしてください',
  SHARED_EVIDENCE_NOT_CITED_BY_OTHER_ORGANIZATION: '共有証跡の例外は、もう一方の組織が同じ承認証跡ですでに承認を記録している場合だけ使えます。先にもう一方の組織の承認を記録してください',
  SAME_CONTENT_OTHER_ISSUER: '同じ内容の承認証跡が別の発行元ですでに登録されています。組織ごとに別の承認書類を使ってください',
  SHARED_EVIDENCE_FLAG_INVALID: '共有証跡の指定が正しくありません。画面を再読み込みしてください',

  // ---- manual verification (approval evidence / send)
  UNKNOWN_EVIDENCE_VERIFICATION_RESULT: '確認結果は「確認済み」か「相違あり」から選んでください',
  VERIFIER_NAME_REQUIRED: '確認者が必要です',
  VERIFIED_AT_REQUIRED: '確認日時が必要です',
  VERIFIED_AT_IN_FUTURE: '確認日時に未来の時刻は記録できません',
  VERIFIED_AT_OUT_OF_RANGE: '確認日時が正しくありません',
  VERIFICATION_REASON_REQUIRED: '確認の根拠（原本のどこで何を確認したか）を入力してください',
  EVIDENCE_VERIFICATION_TARGET_INVALID: '承認取消の記録は手動確認の対象ではありません',
  EVIDENCE_NOT_PENDING_MANUAL_VERIFICATION: 'この承認は手動確認待ちではありません（確認済みまたは自動確認済み）',
  EVIDENCE_IDENTIFIER_MISSING: 'この承認には識別子が記録されていないため確認できません',
  EVIDENCE_REQUIRES_REPLACEMENT: 'この承認は、もう一方の組織と同じ承認証跡、または別の発行元の証跡で記録されているため数えられません。その組織が発行した承認書類で承認を記録し直してください',
  EVIDENCE_ALREADY_CONFIRMED: 'この承認はすでに確認済みです。訂正する場合は、その組織の承認取消として記録してください',
  EVIDENCE_ALREADY_VERIFIED: 'この承認はすでに手動確認が記録されています。訂正する場合は、その組織の承認取消として記録してください',
  MAKER_PO_SEND_VERIFICATION_TARGET_INVALID: '手動確認できるのは送信の記録だけです',
  MAKER_PO_SEND_NOT_PENDING_MANUAL_VERIFICATION: 'この送信は手動確認待ちではありません',
  MAKER_PO_SEND_ALREADY_CONFIRMED: 'この送信はすでに確認済みです。取り消す場合は新しい記録として残してください',
  MAKER_PO_CANCELLED_SEND_CONFIRMATION_BLOCKED: '取り消し済みのメーカー発注書の送信は確認できません',

  // ---- maker purchase orders
  RECIPIENT_ADDRESS_REQUIRED: 'メーカーの送信先メールアドレスを入力してください',
  RECIPIENT_ADDRESS_INVALID: 'メーカーの送信先はメールアドレスの形式で入力してください（例: order@maker.example.jp）。住所や名前は入力できません',
  INVALID_MAKER_PO_AMOUNTS: '金額は通貨と合計金額の両方を入力してください',
  MAKER_PO_NOT_READY: 'メーカー発注書は「メーカー発注準備完了」の発注にだけ作成できます',
  MAKER_PO_ALREADY_EXISTS: 'この発注には有効なメーカー発注書がすでにあります。内容を直す場合は、今の発注書を取り消してから作り直してください',
  MAKER_PO_TRANSITION_BLOCKED: 'メーカー発注書の今の状態では、この操作はできません。画面を再読み込みしてください',
  MAKER_PO_STATE_CHANGED: 'メーカー発注書の状態が別の操作で変わりました。画面を再読み込みしてください',
  MAKER_PO_LOCK_CONFLICT: '同じ発注への操作が重なりました。少し待ってからもう一度お試しください',
  ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED: '保留・見直し中の発注のメーカー発注書は進められません。状態を解決してから記録してください',
  FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED: '取消で終了した発注のメーカー発注書は操作できません',
  MAKER_PO_CANCELLATION_ACK_REQUIRED: '送信済みのメーカー発注書が取り消されています。新しい発注書を作る前に、メーカーの取消確認を記録してください',
  MAKER_PO_CANCEL_REASON_REQUIRED: 'メーカー発注書を取り消す理由を入力してください',
  MAKER_PO_CANCEL_REASON_TOO_LONG: 'メーカー発注書を取り消す理由が長すぎます。1000文字以下にしてください',
  MAKER_CANCELLATION_ACK_REASON_REQUIRED: 'メーカーの取消確認の内容（メモ）を入力してください',
  MAKER_CANCELLATION_ACK_REASON_TOO_LONG: 'メーカーの取消確認の内容（メモ）が長すぎます。1000文字以下にしてください',
  MAKER_PO_NOT_CANCELLED: '取消確認は、取り消し済みのメーカー発注書にだけ記録できます',
  MAKER_CANCELLATION_ACK_ALREADY_RECORDED: 'この発注書の取消確認はすでに記録されています',
  MAKER_CANCELLATION_ACK_EVIDENCE_INVALID: '取消確認の証跡の指定が正しくありません',
  MAKER_CANCELLATION_ACK_EVIDENCE_NOT_FOUND: '取消確認の証跡が見つかりません',
  MAKER_CANCELLATION_ACK_EVIDENCE_TYPE_INVALID: '取消確認の証跡には「受領証跡」の書類を選んでください',
  MAKER_CANCELLATION_ACK_EVIDENCE_NOT_VERIFIED: '取消確認の証跡は、先に文書画面で確認済みにしてください',
  MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH: '取消確認の証跡は、同じ案件・発注・メーカー発注書のものを選んでください',
  MAKER_CANCELLATION_ACK_TIME_FORMAT_INVALID: '取消確認の日時が正しくありません',
  MAKER_CANCELLATION_ACK_TIME_BEFORE_CANCELLATION: '取消確認の日時は、取消を記録した日時より後にしてください',
  MAKER_CANCELLATION_ACK_TIME_IN_FUTURE: '取消確認の日時に未来の時刻は記録できません',
  MAKER_CANCELLATION_ACK_TIME_OUT_OF_RANGE: '取消確認の日時が正しくありません',
  UNKNOWN_MAKER_PO_STATUS: 'メーカー発注書の状態を読み取れません。代表者へ連絡してください',
  UNKNOWN_MAKER_PO_EVENT_TYPE: 'メーカー発注書の記録の種類を読み取れません。代表者へ連絡してください',
  UNKNOWN_MAKER_PO_VERIFICATION_STATUS: 'メーカー発注書の確認状態を読み取れません。代表者へ連絡してください',
  SNAPSHOT_VOIDED: '発注の内容が代表承認時から変わったため、承認は無効になりました。もう一度代表承認を受けてください',

  // ---- send evidence
  SENDER_ADDRESS_REQUIRED: '送信元のメールアドレスが必要です',
  RECIPIENTS_REQUIRED: '送信先のメールアドレスが必要です',
  SENT_AT_REQUIRED: '送信日時が必要です',
  SENT_AT_IN_FUTURE: '送信日時が現在より10分以上先です。メールの送信日時を確認してください',
  INVALID_ATTACHMENT_HASH: '添付ファイルの記録が正しくありません。元のEMLを選び直してください',
  SEND_RECIPIENT_MISMATCH: '送信メールの宛先に、発注書の送信先メールアドレスが含まれていません。正しい送信メールを選ぶか、代表者に確認を依頼してください',
  SEND_EVIDENCE_CONTENT_REQUIRED: '送信証跡のEMLファイルを選んでください',
  SEND_EVIDENCE_CONTENT_INVALID: '送信証跡のファイルを読み取れませんでした。元のEMLを選び直してください',
  SEND_EVIDENCE_DOCUMENT_VERSION_INVALID: '送信証跡の書類の指定が正しくありません',
  SEND_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND: '送信証跡の書類が見つかりません',
  SEND_EVIDENCE_DOCUMENT_TYPE_INVALID: '送信証跡には「送信証跡」の種類の書類を選んでください',
  SEND_EVIDENCE_DOCUMENT_UNREADABLE: '送信証跡のファイルを読み取れないため確認できません。代表者へ連絡してください',
  SEND_EVIDENCE_PROJECT_MISMATCH: '送信証跡がこの案件に見つかりません',
  SEND_EVIDENCE_ORDER_MISMATCH: '送信証跡は別の発注に紐付いています',
  SEND_EVIDENCE_FROM_CANCELLED_PO: 'この送信証跡は取り消し済みのメーカー発注書の送信メールです。今の発注書を送信したメールのEMLを登録してください',

  // ---- acceptance / delivery evidence
  ACCEPT_EVIDENCE_REQUIRED: '受領証跡の書類を選んでください',
  ACCEPT_EVIDENCE_DOCUMENT_VERSION_INVALID: '受領証跡の書類の指定が正しくありません',
  ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND: '受領証跡の書類が見つかりません',
  ACCEPT_EVIDENCE_DOCUMENT_TYPE_INVALID: '受領証跡には「受領証跡」の種類の書類を選んでください',
  ACCEPT_EVIDENCE_NOT_VERIFIED: '受領証跡を先に文書画面で確認済みにしてください',
  ACCEPT_EVIDENCE_PROJECT_MISMATCH: '受領証跡がこの案件に見つかりません',
  ACCEPT_EVIDENCE_ORDER_MISMATCH: '受領証跡は別の発注に紐付いています',
  ACCEPT_EVIDENCE_PO_MISMATCH: '受領証跡は別のメーカー発注書に紐付いています',
  DELIVERY_EVIDENCE_REQUIRED: '納品の証跡（受領証跡）を選んでください',
  DELIVERY_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND: '納品の証跡が見つかりません',
  DELIVERY_EVIDENCE_DOCUMENT_TYPE_INVALID: '納品の証跡には「受領証跡」の種類の書類を選んでください',
  DELIVERY_EVIDENCE_NOT_VERIFIED: '納品の証跡を先に文書画面で確認済みにしてください',
  DELIVERY_EVIDENCE_PROJECT_MISMATCH: '納品の証跡がこの案件に見つかりません',
  DELIVERY_EVIDENCE_ORDER_MISMATCH: '納品の証跡は別の発注に紐付いています',
  DELIVERY_ALREADY_CONFIRMED: 'この納品はすでに確認済みです',
  DELIVERY_SEQUENCE_EXISTS: 'この納品の連番はすでに登録されています',
  INVALID_DELIVERY_SEQUENCE: '納品の連番は1以上の整数にしてください',
  DELIVERY_UNIT_MISMATCH: '納品の単位は発注の明細と同じ単位にしてください',
  RECEIPT_ASSUMPTION_ACTION_REQUIRED: '「受領確認（問題なしとみなす）」は専用の記録操作でだけ行えます',
  RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED: '証跡なしで受領とみなすことへの同意にチェックしてください',
  RECEIPT_ASSUMPTION_NOTE_REQUIRED: '問題なしとみなす理由を入力してください',
  RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED: '受領確認は「フィルム納品済み」の発注でだけ記録できます',
  RECEIPT_ASSUMPTION_STATE_CHANGED: 'フィルム発注の状態が別の操作で変わりました。画面を再読み込みしてください',
  INVALID_RECEIPT_ASSUMED_AT: '受領確認の日付が正しくありません',
  INVALID_DATE: '日付が正しくありません。日付の形式を確認してください',
  // ---- P1 R23: automatic steps
  AUTO_TRANSITION_ONLY: 'この段階は条件がそろうと自動で進みます。手で進める必要はありません',
  ARTWORK_REVISION_REQUIRED: '校正ゲラ（版）がまだ登録されていません。版を登録すると自動で進みます',
  PROJECT_CONTEXT_MISMATCH: '別のタブで案件が切り替わりました。保存していません。画面を再読み込みしてください',

  // ---- P1 R24: approval card / return
  MAKER_PO_RETURN_REASON_REQUIRED: '差し戻しの理由を入力してください',
  MAKER_PO_RETURN_REASON_TOO_LONG: '差し戻しの理由は1000文字以下にしてください',
  MAKER_PO_RETURN_ONLY_DRAFT: '差し戻しできるのは代表承認前のメーカー発注書だけです。承認済みの発注書は取消の手順を使ってください',
  MAKER_PO_SNAPSHOT_CHANGED: '承認画面を開いた後に発注書の内容（明細・版）が変わりました。最新の内容を確認してから、もう一度承認してください',
  EXPECTED_SNAPSHOT_SHA256_INVALID: '承認する発注書の確認値が正しくありません。画面を再読み込みしてください',
  MAKER_PO_AMOUNTS_ADMIN_ONLY: '金額は代表者だけが入力できます。金額なしで下書きを作成してください',
  EXPECTED_SNAPSHOT_SHA256_REQUIRED: '承認する発注書の確認値がありません。承認カードを開き直してから承認してください',
  MAKER_PO_AMOUNT_MISSING: 'メーカー発注書に金額が記載されていません。担当者に金額の入力を依頼してください',
  MAKER_PO_SNAPSHOT_DRIFTED: '発注書の作成後に明細または版が変わりました。承認すると最新の内容で確定します',

  // ---- P1 P-4: self-verification
  SELF_VERIFICATION_FORBIDDEN: '自分で登録した証跡は自分で確認できません。代表者または別の担当者に確認を依頼してください',

  // ---- P2: delivery dates / seven PO facts / maker master / language / design data
  DELIVERY_DATE_INVALID: '日付は「年-月-日」（例: 2026-12-01）の実在する日付で入力してください。変更する日付を 1 つ以上送ってください',
  SEVEN_PO_ORDER_FACTS_INVALID: 'セブン化学発注書の数量（単位と一緒に）または金額（通貨と一緒に）を正しく入力してください',
  SEVEN_PO_AMOUNT_ADMIN_ONLY: 'セブン化学発注書の金額は代表者だけが入力できます',
  MAKER_ACCOUNT_INVALID: '製造先の名前（200 文字まで）を入力してください。取引先コードは 64 文字までです',
  MAKER_ACCOUNT_NOT_FOUND: '製造先が見つかりません',
  MAKER_RECIPIENT_ADDRESS_INVALID: '宛先の表示名は 100 文字まで、既定・使用中は「はい」か「いいえ」で指定してください',
  MAKER_RECIPIENT_ADDRESS_NOT_FOUND: '宛先が見つかりません',
  MAKER_RECIPIENT_ADDRESS_UNAVAILABLE: '選んだ送信先は使用できません（この案件の製造先の使用中の宛先ではありません）。送信先を選び直してください',
  DISPLAY_LANGUAGE_INVALID: '表示言語は「日本語」「日本語＋한국어」「한국어」から選んでください',
  ARTWORK_SUBMISSION_ORDER_REQUIRED: 'デザイン入稿データは、セブン化学発注書が紐付いた発注を指定して登録してください',

  // ---- P2 review: idempotency outcomes, delivery-terms lock, read-only roles
  IDEMPOTENCY_IN_PROGRESS: '同じ送信をまだ処理しています。少し待ってから、同じ画面のままもう一度送信してください',
  IDEMPOTENCY_OUTCOME_UNKNOWN: '前回の送信の結果を確認できませんでした。画面を再読み込みして、記録されたかどうかを確認してください',
  DELIVERY_TERMS_LOCKED: '代表承認済みのメーカー発注書があるため、納期・セブン化学発注書の数量は変更できません。変更する場合はメーカー発注書を取り消して作り直してください',
  READ_ONLY_ROLE: '閲覧・監査の権限では案件を登録できません',
};

/** HTTP status → the code a refusal falls back to when its handler named none. */
export function fallbackCodeForStatus(status: number): string {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 422) return 'VALIDATION_FAILED';
  if (status === 429) return 'TOO_MANY_REQUESTS';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

const JAPANESE_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const INTERNAL_LOCATION = /(?:https?:\/\/|localhost|127\.0\.0\.1|::1|(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d{2,5}\b|\/api\/)/i;
/**
 * Latin words a Japanese business sentence may contain. Everything else — an
 * English sentence, a field name such as verifierName, an enum such as
 * MAKER_PO_READY or prepaid — makes the text unsafe to show.
 */
const ALLOWED_LATIN_WORDS = new Set(['PO', 'EML', 'eml', 'PDF', 'ID', 'CSV', 'MB', 'KB', 'Message', 'F1']);

/**
 * True when `text` can be shown to a person as is: Japanese, no internal
 * location, and no Latin word outside the short business allow-list. A UUID
 * (the identifier of an existing record, e.g. on a duplicate) and a mail
 * address are allowed.
 */
export function isSafeUserMessage(text: unknown): text is string {
  // A refusal sentence is short; a long text (e.g. echoing a huge client value)
  // is replaced without running any pattern over it (ReDoS guard).
  if (typeof text !== 'string' || text.length === 0 || text.length > 400) return false;
  if (!JAPANESE_CHARACTER.test(text)) return false;
  if (INTERNAL_LOCATION.test(text)) return false;
  // Mail addresses are business data (the maker's recipient), not internals.
  const withoutIds = text.replace(UUID_TEXT, ' ').replace(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g, ' ');
  for (const word of withoutIds.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []) {
    if (!ALLOWED_LATIN_WORDS.has(word)) return false;
  }
  return true;
}

/** The Japanese text for a code, or the status fallback when the code is unknown. */
export function messageForCode(code: string, status: number): string {
  return ERROR_MESSAGES_JA[code] ?? ERROR_MESSAGES_JA[fallbackCodeForStatus(status)] ?? ERROR_MESSAGES_JA.INTERNAL_ERROR!;
}

/**
 * Normalizes one refusal body: guarantees a string `code` and a safe Japanese
 * `error`. A handler's own Japanese text is kept when it is safe (it often
 * names the record involved); an English core message, an enum, a field name
 * or an internal URL is replaced by the dictionary text for the code.
 */
export function normalizeRefusalBody(status: number, body: Record<string, unknown>): Record<string, unknown> {
  const code = typeof body.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(body.code)
    ? body.code
    : fallbackCodeForStatus(status);
  const error = isSafeUserMessage(body.error) ? body.error : messageForCode(code, status);
  return { ...body, error, code };
}

/**
 * P0 R04: database failures are classified so the screen can tell an outage
 * from a bug. Connection-level failures (refused, unreachable, the pool's
 * connect timeout, an admin shutdown, SQLSTATE class 08) are DB_UNAVAILABLE;
 * a statement cancelled by statement_timeout (57014) is DB_TIMEOUT.
 */
export function classifyDatabaseError(error: unknown): 'DB_UNAVAILABLE' | 'DB_TIMEOUT' | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (code === '57014' || /canceling statement due to statement timeout/i.test(message)) return 'DB_TIMEOUT';
    if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].includes(code)
      || code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03' || code === '53300'
      || /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED|Client has encountered a connection error|the database system is (starting up|shutting down)/i.test(message)) {
      return 'DB_UNAVAILABLE';
    }
    // AggregateError (Node's happy-eyeballs connect) carries the socket errors in `errors`.
    if (Array.isArray(candidate.errors)) {
      for (const inner of candidate.errors) {
        const nested = classifyDatabaseError(inner);
        if (nested) return nested;
      }
    }
    current = candidate.cause;
  }
  return null;
}
