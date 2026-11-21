import { ActionForm } from './ActionForm';
import { Bilingual } from './Bilingual';
import { CheckboxField, TextField } from './fields';
import { addRecipientAddressAction, createMakerAccountAction, updateRecipientAddressAction } from '../app/makers/actions';
import type { MakerAccountsRead, MakerAccountView, MakerRecipientAddressView } from '../lib/maker-master';

/**
 * P2 R33 (DESIGN §5): メーカーの宛先 — the representative's maker master. One
 * panel per maker with its addresses (a list, not a table: each row has its own
 * buttons), the add-address form under it, and 「メーカーを追加」 at the end. No
 * delete: an address no longer used is stopped (and can be resumed). Every
 * other role sees one notice and no data (the API answers 403 CEO_ONLY).
 */

export const MAKERS_TITLE = 'メーカーの宛先';
export const MAKERS_ONLY_NOTICE = 'この画面は代表者だけが使います。';
const LEAD = 'メーカー発注書の送信先に選べるメールアドレスを、メーカーごとに管理します。削除はできません。使わなくなった宛先は「使用を止める」にします。';

function Header() {
  return (
    <header>
      <h1 id="makers-title" className="p1-title"><Bilingual ja={MAKERS_TITLE} ko="제조처의 수신처" /></h1>
      <p className="p1-lead">{LEAD}</p>
    </header>
  );
}

/** A non-representative: the notice only — no list, no form. */
export function MakerMasterNotice() {
  return (
    <section className="p1-home p2-makers" aria-labelledby="makers-title">
      <Header />
      <p className="role-notice">{MAKERS_ONLY_NOTICE}</p>
    </section>
  );
}

export function MakerMasterScreen({ read }: { read: MakerAccountsRead }) {
  if (read.kind === 'forbidden') return <MakerMasterNotice />;
  return (
    <section className="p1-home p2-makers" aria-labelledby="makers-title">
      <Header />
      {read.kind === 'error' ? (
        <p className="p1-banner p1-banner--error" role="alert">
          メーカーの一覧を読み込めませんでした（{read.error}）。少し待ってから再読み込みしてください。
        </p>
      ) : read.makers.length === 0 ? (
        <p className="p1-muted">メーカーがまだありません。下の「メーカーを追加」から登録します。</p>
      ) : (
        read.makers.map((maker) => <MakerPanel key={maker.id} maker={maker} />)
      )}
      {read.kind === 'error' ? null : <AddMakerPanel />}
    </section>
  );
}

function MakerPanel({ maker }: { maker: MakerAccountView }) {
  const headingId = `maker-${maker.id}`;
  return (
    <section className="p1-panel p2-maker" aria-labelledby={headingId}>
      <h2 id={headingId} className="p1-section-title p2-maker-head">
        <span>{maker.name}</span>
        {maker.externalCode ? <span className="p1-muted-inline">取引先コード <span translate="no">{maker.externalCode}</span></span> : null}
        {maker.isActive ? null : <span className="p2-maker-tag p2-maker-tag--off">使用停止</span>}
      </h2>
      {maker.recipientAddresses.length === 0 ? (
        <p className="p1-muted">宛先がまだありません。下のフォームから追加します。</p>
      ) : (
        <ul className="p2-recipient-list" aria-label={`${maker.name}の宛先`}>
          {maker.recipientAddresses.map((address) => <AddressRow key={address.id} address={address} />)}
        </ul>
      )}
      <div className="p2-maker-add">
        <h3 className="p2-maker-add-title">宛先を追加</h3>
        <ActionForm action={addRecipientAddressAction} submitLabel="宛先を追加する">
          <input type="hidden" readOnly name="accountId" value={maker.id} />
          <div className="form-row">
            <TextField name="email" label="メールアドレス" type="email" required width={320} autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="order@maker.example" />
            <TextField name="label" label="表示名（任意）" width={240} hint="例 営業部・発注窓口（100文字まで）" autoComplete="off" />
          </div>
          <CheckboxField name="isDefault" label="既定の宛先にする（いまの既定は外れます）" />
        </ActionForm>
      </div>
    </section>
  );
}

function AddressRow({ address }: { address: MakerRecipientAddressView }) {
  const name = address.label ?? '宛先';
  return (
    <li className={address.isActive ? undefined : 'is-inactive'}>
      <p className="p2-recipient-facts">
        <b>{name}</b> <span translate="no" className="p2-recipient-email">{address.email}</span>
        {address.isDefault ? <> <span className="p2-maker-tag">既定</span></> : null}
        {address.isActive ? null : <> <span className="p2-maker-tag p2-maker-tag--off">使用停止</span></>}
      </p>
      <div className="p2-recipient-actions">
        {address.isActive && !address.isDefault ? (
          <AddressChange address={address} change="default" label="既定にする" />
        ) : null}
        {address.isActive ? (
          <AddressChange address={address} change="deactivate" label="使用を止める" />
        ) : (
          <AddressChange address={address} change="reactivate" label="使用を再開" />
        )}
      </div>
    </li>
  );
}

function AddressChange({ address, change, label }: { address: MakerRecipientAddressView; change: 'default' | 'deactivate' | 'reactivate'; label: string }) {
  const stopping = change === 'deactivate';
  return (
    <ActionForm
      action={updateRecipientAddressAction}
      submitLabel={label}
      submitContext={address.email}
      tone={stopping ? 'danger' : undefined}
      confirm={stopping ? {
        title: 'この宛先の使用を止めますか？',
        body: `今後のメーカー発注書の送信先に選べなくなります（${address.email}）。作成済みの発注書は変わりません。あとから再開できます。${address.isDefault ? '既定の宛先です。止めると既定がなくなります。' : ''}`,
        tone: 'danger'
      } : undefined}
    >
      <input type="hidden" readOnly name="addressId" value={address.id} />
      <input type="hidden" readOnly name="change" value={change} />
    </ActionForm>
  );
}

function AddMakerPanel() {
  return (
    <section className="p1-panel p2-maker" aria-labelledby="maker-add-title">
      <h2 id="maker-add-title" className="p1-section-title">メーカーを追加</h2>
      <ActionForm action={createMakerAccountAction} submitLabel="メーカーを追加する">
        <div className="form-row">
          <TextField name="name" label="メーカーの名前" required width={320} hint="200文字まで" autoComplete="off" />
          <TextField name="externalCode" label="取引先コード（任意）" width={200} hint="64文字まで" autoComplete="off" spellCheck={false} autoCapitalize="none" />
        </div>
      </ActionForm>
    </section>
  );
}
