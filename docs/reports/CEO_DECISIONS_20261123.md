# 代表決定記録 — 2026-11-23

この記録は 2026-11-23 の決定（指揮者経由）と実装方針をまとめる。2026-11-19 の記録（`CEO_DECISIONS_20261119.md`）に続く。金額・実名・認証情報は書かない。

## 決定一覧

| Q-ID / 主題 | 決定 | 実装・運用上の意味 |
|---|---|---|
| N4(b) / 差出人ドメイン不一致の承認メール | 承認メール（.eml）の差出人（From）のドメインが、承認する組織（顧客・セブン化学）の登録連絡先（`accounts.contact_email`）のドメインと違うときは、**自動で承認に数えない**。拒否はせず、PDF・画像と同じく**代表の手動確認**に回す。確認待ちの理由は「差出人のドメインが登録先と違います」。 | サーバーの承認算入条件に `senderVerdict !== 'mismatch'` を加える（承認記録時に `evidenceIdentifierStatus = pending_manual_verification`）。応答・確認待ち一覧・代表の承認箱に理由 `{ code: EVIDENCE_SENDER_DOMAIN_MISMATCH, message: 差出人のドメインが登録先と違います }` を載せる。差出人が読めない／複数（`unverifiable`）、連絡先未登録（`no_registered_domain`）、メール以外（`not_email`）は従来どおり警告・中立のみ。staff の承認証跡選択の契約（代表確定のサーバー規則の一つ）は、項目も拒否条件も変えない。変わるのは算入条件だけ。2026-11-19 以前の「サーバーは警告のみ」は本決定で置き換える。 |
| R5 / 取引先の連絡先の入力 | N4 の前提として、代表者が画面から顧客・セブン化学の連絡先メールアドレスを登録・変更・削除できるようにする。 | 画面 `/partners`（代表のみ）、API `GET /api/partner-accounts`・`PATCH /api/partner-accounts/:id/contact-email`（代表のみ、`partner_contact:manage`）。既存の `accounts.contact_email` を使い、マイグレーションは追加しない。変更ごとに監査イベント `PARTNER_CONTACT_EMAIL_UPDATED`（変更前→変更後）を残す。 |

## 実装状態の要点

- 実装はブランチ `p5/int`（未 push、main DB 未適用）。詳細と証拠は `demo-eml/p5-int/REPORT.md`。
- 本決定より前に記録された「差出人ドメイン不一致」の承認（P4 の検証用 DB にだけ存在。main DB は P4 未適用）は、記録時の判定のまま数える。読み出し時に遡って保留にはしない（保留にすると、DB 規則上手動確認を記録できない古い記録が新しい行き止まりになるため）。
