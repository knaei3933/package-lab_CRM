import { ActionForm } from './ActionForm';
import { Bilingual } from './Bilingual';
import { TextField } from './fields';
import { updatePartnerContactEmailAction } from '../app/partners/actions';
import { PARTNER_ROLE_LABELS } from '../lib/partner-contacts';
import type { PartnerAccountsRead, PartnerAccountView } from '../lib/partner-contacts';

/**
 * P5 R5: 取引先の連絡先 — one panel per customer / セブン化学 account with its
 * registered contact address and the form that sets it. An approval mail whose
 * From domain differs from this address is not counted by itself (N4(b),
 * 2026-11-23): it waits for the representative's check. Every other role sees
 * one notice and no data (the API answers 403 CEO_ONLY).
 */

export const PARTNERS_TITLE = '取引先の連絡先';
export const PARTNERS_ONLY_NOTICE = 'この画面は代表者だけが使います。';
const LEAD = '顧客とセブン化学の連絡先メールアドレスを登録します。承認メール（.eml）の差出人のドメインがこのアドレスのドメインと完全に一致するときだけ自動で承認に数えます。違うとき・差出人を読み取れないときは、代表の確認に回します。';

function Header() {
  return (
    <header>
      <h1 id="partners-title" className="p1-title"><Bilingual ja={PARTNERS_TITLE} ko="거래처 연락처" /></h1>
      <p className="p1-lead">{LEAD}</p>
    </header>
  );
}

export function PartnerContactsNotice() {
  return (
    <section className="p1-home p2-makers" aria-labelledby="partners-title">
      <Header />
      <p className="role-notice">{PARTNERS_ONLY_NOTICE}</p>
    </section>
  );
}

export function PartnerContactsScreen({ read }: { read: PartnerAccountsRead }) {
  if (read.kind === 'forbidden') return <PartnerContactsNotice />;
  return (
    <section className="p1-home p2-makers" aria-labelledby="partners-title">
      <Header />
      {read.kind === 'error' ? (
        <p className="p1-banner p1-banner--error" role="alert">
          取引先の一覧を読み込めませんでした（{read.error}）。少し待ってから再読み込みしてください。
        </p>
      ) : read.accounts.length === 0 ? (
        <p className="p1-muted">顧客・セブン化学の取引先がまだありません。</p>
      ) : (
        read.accounts.map((account) => <PartnerPanel key={account.id} account={account} />)
      )}
    </section>
  );
}

function PartnerPanel({ account }: { account: PartnerAccountView }) {
  const headingId = `partner-${account.id}`;
  return (
    <section className="p1-panel p2-maker" aria-labelledby={headingId} data-partner-role={account.role}>
      <h2 id={headingId} className="p1-section-title p2-maker-head">
        <span>{account.name}</span>
        <span className="p2-maker-tag">{PARTNER_ROLE_LABELS[account.role]}</span>
        {account.externalCode ? <span className="p1-muted-inline">取引先コード <span translate="no">{account.externalCode}</span></span> : null}
        {account.isActive ? null : <span className="p2-maker-tag p2-maker-tag--off">使用停止</span>}
      </h2>
      <p className="p2-recipient-facts" data-contact-email={account.contactEmail ? 'set' : 'unset'}>
        連絡先: {account.contactEmail
          ? <span translate="no" className="p2-recipient-email">{account.contactEmail}</span>
          : <>未登録（この取引先の承認メールの差出人は照合されません）</>}
      </p>
      {account.projectCodes.length > 0 ? (
        <p className="p1-muted">使っている案件: <span translate="no">{account.projectCodes.join('、')}</span></p>
      ) : null}
      <div className="p2-maker-add">
        <ActionForm
          action={updatePartnerContactEmailAction}
          submitLabel={account.contactEmail ? '連絡先を変更する' : '連絡先を登録する'}
          submitContext={account.name}
        >
          <input type="hidden" readOnly name="accountId" value={account.id} />
          <TextField
            name="contactEmail"
            label="連絡先メールアドレス"
            type="email"
            required
            width={320}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            defaultValue={account.contactEmail ?? ''}
            placeholder="approvals@customer.example.jp"
            hint="承認メールを送ってくる担当者のアドレス（ドメインで照合します。サブドメインは一致とみなさず、代表の確認に回ります）。"
          />
        </ActionForm>
        {account.contactEmail ? (
          <ActionForm
            action={updatePartnerContactEmailAction}
            submitLabel="連絡先を消す"
            submitContext={account.name}
            tone="danger"
            confirm={{
              title: 'この取引先の連絡先を消しますか？',
              body: `${account.name} の連絡先 ${account.contactEmail} を消します。消すと、この取引先の承認メールの差出人は照合されなくなります。変更は、この取引先を使う案件の監査履歴に残ります。`
            }}
          >
            <input type="hidden" readOnly name="accountId" value={account.id} />
            <input type="hidden" readOnly name="clear" value="yes" />
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}
