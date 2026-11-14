import { ActionForm } from '../../components/ActionForm';
import { OrderCreateForm } from '../../components/OrderCreateForm';
import { SelectField, TextField } from '../../components/fields';
import { callApi, loadSessionUser, readSelectedProjectId } from '../../lib/api';
import {
  isOrderPastMakerAcceptance,
  loadMakerPoBoard,
  loadMakerPoDetail,
  MAKER_PO_EVENT_TYPE_LABELS,
  MAKER_PO_STATUS_LABELS,
  nextActionForStatus,
  PAYMENT_TERMS_LABELS
} from '../../lib/maker-po-data';
import type { MakerPoEventRow, MakerPoViewRow, OrderMakerPoBoard } from '../../lib/maker-po-data';
import type { AuditEventView } from '../../lib/project-data';
import { labelLookup } from '../../lib/project-data';
import {
  badgeStyle,
  cardStyle,
  infoBoxStyle,
  monoStyle,
  noteStyle,
  tableStyle,
  tdStyle,
  thStyle
} from '../../lib/ui';
import { formatTimestamp, unitChoices, VERIFICATION_STATUS_LABELS } from '../../lib/vocabulary';
import type { Choice } from '../../lib/types';
import { createFilmSupplyOrderAction } from '../actions';
import {
  approveMakerPoAction,
  createMakerPoAction,
  recordFinalAcceptanceAction,
  recordMakerPoSendEvidenceAction,
  recordProvisionalAcceptanceAction,
  updatePaymentTermsAction
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * M8-OPERATOR S5: メーカー発注オペレーション画面.
 *
 * Five screens over the real API: (1) 発注書の作成と一覧, (2) 大代表承認 with the
 * G6 payment-gate state, (3) 手動送信記録, (4) メーカー受入記録 split into the
 * provisional staff record and the admin final confirmation, and (5) the
 * role-aware audit dashboard behind the S3 filter. Every block shows the NEXT
 * action and the reason the paper is blocked (G6未満・二重承認不足・送信証跡なし),
 * and the amounts are rendered only for the representative — the API already
 * answers staff and viewer with the filtered view, so a role that cannot see an
 * amount never receives one to render.
 */

const PAYMENT_TERMS_CHOICES: Choice[] = [
  { value: 'prepaid', label: PAYMENT_TERMS_LABELS.prepaid! },
  { value: 'on_delivery', label: PAYMENT_TERMS_LABELS.on_delivery! },
  { value: 'undetermined', label: PAYMENT_TERMS_LABELS.undetermined! }
];

const MAKER_PO_READY = 'MAKER_PO_READY';

export default async function MakerPoPage() {
  const projectId = await readSelectedProjectId();
  if (!projectId) {
    return <div style={infoBoxStyle}>案件が選択されていません。上部の「案件の選択」で案件IDを入力してください。</div>;
  }

  const [user, board] = await Promise.all([loadSessionUser(), loadMakerPoBoard(projectId)]);
  const role = user?.role ?? 'viewer';
  const isAdmin = role === 'admin';
  const stateLabel = labelLookup(board.workspace.labels, 'filmSupplyOrderStates');
  const poChoices = board.workspace.sevenPurchaseOrders.map((po) => ({
    value: po.id,
    label: `${po.poNumber}（${po.officialRegisteredAt ? '公式登録済み' : '未登録'}）`
  }));

  const audit = await loadMakerPoAudit(projectId);

  const documentVersionChoices = (orderId: string, documentType: string): Choice[] =>
    board.workspace.documents
      .filter((document) => document.documentType === documentType && document.filmSupplyOrderId === orderId)
      .flatMap((document) => document.versions.map((version) => ({
        value: version.id,
        label: `${document.filename}（版${version.versionNumber}／確認状態 ${
          VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus
        }／ID ${version.id.slice(0, 8)}…）`
      })));

  const readyOrders = board.boards.filter((entry) => entry.order.status === MAKER_PO_READY);

  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>メーカー発注（発注書・承認・送信・受入）</h1>
        {board.workspace.project ? (
          <p style={noteStyle}>
            案件 {board.workspace.project.code}（{board.workspace.project.name}） ／
            ログイン中の役割: {role === 'admin' ? '代表者' : role === 'staff' ? '担当者' : '閲覧者'} ／
            金額は代表者にのみ表示されます。
          </p>
        ) : null}
        {board.workspace.error ? <div style={infoBoxStyle}>{board.workspace.error}</div> : null}
      </header>

      <MakerPoCreateSection
        readyOrders={readyOrders}
        isAdmin={isAdmin}
        stateLabel={stateLabel}
      />

      {/* M8-OPER2 FIX 1: a new order can be created with its G6 terms already set. */}
      <div style={cardStyle}>
        <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>決済条件を設定して発注を作成する</h2>
        <p style={noteStyle}>
          フィルム発注を作るときに決済条件（G6: prepaid／on_delivery／undetermined）を設定できます。
          決済条件は発注ドラフト（DRAFT）の間だけ変更でき、ここでの記録は入金確認ではありません
          — 入金の確認は別の手動ステップです。未確定（undetermined）のままでは代表承認（G6）は拒否されます。
        </p>
        <OrderCreateForm
          action={createFilmSupplyOrderAction}
          orderKind="film"
          unitChoices={unitChoices('film')}
          sevenPurchaseOrderChoices={poChoices}
          paymentTermsChoices={PAYMENT_TERMS_CHOICES}
        />
      </div>

      {board.boards.map((entry) => (
        <MakerPoOrderSection
          key={entry.order.id}
          entry={entry}
          isAdmin={isAdmin}
          role={role}
          stateLabel={stateLabel}
          sendEvidenceChoices={documentVersionChoices(entry.order.id, 'send_evidence')}
          acceptanceEvidenceChoices={documentVersionChoices(entry.order.id, 'acceptance_evidence')}
        />
      ))}

      {board.boards.length === 0 ? (
        <div style={cardStyle}>
          <p style={noteStyle}>
            メーカー発注の作業対象の発注はまだありません。フィルム発注が MAKER_PO_READY（校正のダブル承認が完了）に
            なると、この画面に表示されます。製造中・出荷済み・納品済みに進んだ発注も、発注書と承認・送信・受入の
            履歴が読めるままこの画面に表示されます。次のアクション:
            「案件（発注）一覧／作成」画面で承認を進めてください。
          </p>
        </div>
      ) : null}

      <AuditDashboardSection events={audit.events} error={audit.error} role={role} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screen 1: 発注書作成 + 一覧
// ---------------------------------------------------------------------------

function MakerPoCreateSection({
  readyOrders,
  isAdmin,
  stateLabel
}: {
  readyOrders: OrderMakerPoBoard[];
  isAdmin: boolean;
  stateLabel: (key: string) => string;
}) {
  const orderChoices: Choice[] = readyOrders.map((entry) => ({
    value: entry.order.id,
    label: `${entry.order.code}（${stateLabel(entry.order.status)}）`
  }));

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>① 発注書の作成（メーカー発注書の作成）</h2>
      <p style={noteStyle}>
        校正のダブル承認が完了して発注が MAKER_PO_READY になった発注の紙を凍結し、メーカー発注書を作ります。
        作成は代表者だけです（担当者・閲覧者は作成できません）。
      </p>
      {readyOrders.length === 0 ? (
        <p style={noteStyle}>
          作成できる発注（MAKER_PO_READY）はまだありません。ブロック理由: 二重承認不足（顧客とセブン化学の
          ダブル承認が未完了）、または発注自体がまだありません。次のアクション:
          「承認」画面でダブル承認を完了させてください。
        </p>
      ) : (
        <>
          <ActionForm
            action={createMakerPoAction}
            submitLabel="メーカー発注書を作成する"
            hint="宛先住所はメーカーへの送り先です。金額は代表者のみ入力できます（担当者の画面には金額欄がありません）。"
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <SelectField name="orderId" label="対象のフィルム発注" required choices={orderChoices} width={420} />
              <TextField name="recipientAddress" label="宛先住所（メーカーの送り先）" required width={320} />
              {isAdmin ? (
                <>
                  <TextField name="currency" label="通貨（例 JPY）" width={140} />
                  <TextField name="totalAmount" label="金額（例 480000）" width={180} />
                </>
              ) : null}
            </div>
          </ActionForm>
          {!isAdmin ? (
            <p style={noteStyle}>金額の入力は代表者のみです。金額が必要な場合は代表者に依頼してください。</p>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens 2, 3 and 4: per-order paper
// ---------------------------------------------------------------------------

function MakerPoOrderSection({
  entry,
  isAdmin,
  role,
  stateLabel,
  sendEvidenceChoices,
  acceptanceEvidenceChoices
}: {
  entry: OrderMakerPoBoard;
  isAdmin: boolean;
  role: string;
  stateLabel: (key: string) => string;
  sendEvidenceChoices: Choice[];
  acceptanceEvidenceChoices: Choice[];
}) {
  const gate = entry.paymentGate;
  const list = entry.makerPurchaseOrders;
  // M8-OPER2 FIX 3: an order in the production/shipping/delivery chain has a
  // closed paper. The section answers with the read-only history and never
  // renders the approval / send / acceptance forms again.
  const pastAcceptance = isOrderPastMakerAcceptance(entry.order.status);

  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>
        フィルム発注 {entry.order.code}（{stateLabel(entry.order.status)}）
        {pastAcceptance ? <span style={noteStyle}> ／ メーカー発注の紙は受入済み（履歴は下に表示）</span> : null}
      </h2>

      {/* G6 payment gate: 決済条件の状態 and the block reason, always visible. */}
      <div style={{ ...infoBoxStyle, borderColor: gate?.gate.satisfied ? '#b9d8bc' : '#e4b9b9', color: gate?.gate.satisfied ? '#166534' : '#8a3b3b' }}>
        <strong>決済条件（G6）の状態: </strong>
        {gate ? (
          <>
            {PAYMENT_TERMS_LABELS[gate.paymentTerms] ?? gate.paymentTerms}
            {gate.gate.satisfied
              ? ' ／ ゲート: 満たしています（代表承認の前提を満たしています）'
              : ` ／ ゲート: 満たしていません（ブロック理由: ${gate.gate.reason ?? gate.gate.code ?? '未確定'}）`}
            <div style={noteStyle}>
              入金確認（檢証）: {gate.paymentConfirmedAt ? formatTimestamp(gate.paymentConfirmedAt) : '未確認'}。
              決済条件の記録（prepaid／on_delivery）は入金確認ではありません。入金の確認は、
              専用の確認操作で別に記録する手動のステップです（現在はまだ記録操作がありません）。
            </div>
          </>
        ) : (
          <>決済条件の状態を取得できませんでした。{entry.paymentGateError ?? ''}</>
        )}
      </div>

      {!pastAcceptance && isAdmin && entry.order.status === 'DRAFT' && gate && !gate.gate.satisfied ? (
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 13, cursor: 'pointer' }}>決済条件を記録する（ドラフトの間のみ）</summary>
          <ActionForm
            action={updatePaymentTermsAction}
            submitLabel="決済条件を記録する"
            hint="決済条件は発注ドラフト（DRAFT）の間だけ変更できます。記録しても入金確認にはなりません。"
          >
            <input type="hidden" readOnly name="orderId" value={entry.order.id} />
            <SelectField name="paymentTerms" label="決済条件" required choices={PAYMENT_TERMS_CHOICES} width={280} />
          </ActionForm>
        </details>
      ) : null}

      {list.length === 0 ? (
        <p style={noteStyle}>
          この発注のメーカー発注書はまだありません。次のアクション: {isAdmin
            ? '上の「① 発注書の作成」で作成してください。'
            : '代表者による発注書の作成を待ちます。'}
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>発注書ID</th>
              <th style={thStyle}>状態</th>
              <th style={thStyle}>発注コード</th>
              {isAdmin ? <th style={thStyle}>金額</th> : null}
              {isAdmin ? <th style={thStyle}>宛先／ダイジェスト</th> : null}
              {!isAdmin ? <th style={thStyle}>宛先</th> : null}
              <th style={thStyle}>代表承認</th>
              <th style={thStyle}>更新</th>
            </tr>
          </thead>
          <tbody>
            {list.map((po) => (
              <tr key={po.id}>
                <td style={tdStyle}>
                  <span style={monoStyle}>{po.id}</span>
                </td>
                <td style={tdStyle}>
                  <span style={badgeStyle}>{MAKER_PO_STATUS_LABELS[po.status] ?? po.status}</span>
                  <div style={noteStyle}>{nextActionForStatus(po.status, role)}</div>
                </td>
                <td style={tdStyle}>{po.orderCode ?? po.snapshot?.order?.code ?? '—'}</td>
                {isAdmin ? (
                  <td style={tdStyle}>
                    {po.snapshot?.amounts
                      ? `${po.snapshot.amounts.currency} ${po.snapshot.amounts.totalAmount}`
                      : '—'}
                  </td>
                ) : null}
                {isAdmin ? (
                  <td style={tdStyle}>
                    <div>{po.snapshot?.recipient?.address ?? po.recipientAddress ?? '—'}</div>
                    <div style={monoStyle}>{po.snapshotSha256 ? `${po.snapshotSha256.slice(0, 16)}…` : '—'}</div>
                  </td>
                ) : (
                  <td style={tdStyle}>{po.recipientAddress ?? '—'}</td>
                )}
                <td style={tdStyle}>{po.ceoApprovedAt ? formatTimestamp(po.ceoApprovedAt) : '未承認'}</td>
                <td style={tdStyle}>{formatTimestamp(po.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {entry.makerPoError ? <div style={infoBoxStyle}>{entry.makerPoError}</div> : null}

      {pastAcceptance ? (
        // M8-OPER2 FIX 3: read-only history instead of the recording forms.
        <MakerPoHistoryBlock list={list} />
      ) : (
        <>
          {/* Screen 2: 大代表承認 */}
          <MakerPoApprovalBlock entry={entry} isAdmin={isAdmin} role={role} />

          {/* Screens 3 and 4 */}
          {list.map((po) => (
            <MakerPoWorkBlocks
              key={po.id}
              po={po}
              isAdmin={isAdmin}
              role={role}
              sendEvidenceChoices={sendEvidenceChoices}
              acceptanceEvidenceChoices={acceptanceEvidenceChoices}
            />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * M8-OPER2 FIX 3: the 発注書・代表承認・送信・受入 history of a closed paper,
 * read from the role-shaped API answer. No form is rendered here: past
 * MAKER_PO_ACCEPTED the paper is done and the screen only reports what happened.
 */
async function MakerPoHistoryBlock({ list }: { list: MakerPoViewRow[] }) {
  if (list.length === 0) {
    return (
      <p style={noteStyle}>
        この発注は受入後の状態（製造中・出荷済み・納品済み）ですが、この画面に表示できるメーカー発注書はまだありません。
      </p>
    );
  }
  const details = await Promise.all(list.map((po) => loadMakerPoDetail(po.id)));

  return (
    <div style={{ borderTop: '1px solid #eef1f6', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>メーカー発注の履歴（発注書・代表承認・送信・受入）</h3>
      <p style={noteStyle}>
        受入済みのため、これ以上の承認・送信・受入の記録操作は表示しません。以下は記録の履歴です。
      </p>
      {list.map((po, index) => {
        const detail = details[index] ?? { purchaseOrder: null, events: [], error: '取得できませんでした。' };
        const sentEvent = detail.events.find((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
        const acceptedEvent = detail.events.find((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED');
        const provisionalEvents = detail.events.filter((event) => event.provisional === true);
        return (
          <div key={po.id} style={{ marginBottom: 12 }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>発注書</th>
                  <th style={thStyle}>状態</th>
                  <th style={thStyle}>発注書の作成</th>
                  <th style={thStyle}>代表承認</th>
                  <th style={thStyle}>送信記録</th>
                  <th style={thStyle}>受入確認（最終）</th>
                  <th style={thStyle}>受入記録（仮）</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={tdStyle}><span style={monoStyle}>{po.id}</span></td>
                  <td style={tdStyle}>{MAKER_PO_STATUS_LABELS[po.status] ?? po.status}</td>
                  <td style={tdStyle}>{po.createdAt ? formatTimestamp(po.createdAt) : '—'}</td>
                  <td style={tdStyle}>{po.ceoApprovedAt ? formatTimestamp(po.ceoApprovedAt) : '未承認'}</td>
                  <td style={tdStyle}>
                    {sentEvent?.sentAt ? formatTimestamp(sentEvent.sentAt) : '記録なし'}
                  </td>
                  <td style={tdStyle}>
                    {acceptedEvent ? formatTimestamp(acceptedEvent.recordedAt) : '記録なし'}
                  </td>
                  <td style={tdStyle}>
                    {provisionalEvents.length > 0
                      ? `${provisionalEvents.length}件（${provisionalEvents
                          .map((event) => formatTimestamp(event.recordedAt))
                          .join('、')}）`
                      : 'なし'}
                  </td>
                </tr>
              </tbody>
            </table>
            {detail.events.length > 0 ? (
              <details>
                <summary style={{ fontSize: 13, cursor: 'pointer' }}>
                  この発注書の記録イベント（{detail.events.length}件）
                </summary>
                <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
                  {detail.events.map((event) => (
                    <li key={event.id}>
                      {MAKER_PO_EVENT_TYPE_LABELS[event.eventType] ?? event.eventType} ／{' '}
                      {formatTimestamp(event.recordedAt)}
                      {event.provisional === true ? '（仮の受入記録）' : ''}
                      {event.verificationStatus ? ` ／ 確認状態: ${event.verificationStatus}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {detail.error ? <div style={infoBoxStyle}>{detail.error}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function MakerPoApprovalBlock({ entry, isAdmin, role }: { entry: OrderMakerPoBoard; isAdmin: boolean; role: string }) {
  const pending = entry.makerPurchaseOrders
    .filter((po) => po.status === 'DRAFT' || po.status === 'SNAPSHOT_VOIDED');
  if (pending.length === 0) return null;
  const gate = entry.paymentGate;
  const gateBlocks = gate !== null && !gate.gate.satisfied;

  return (
    <div style={{ borderTop: '1px solid #eef1f6', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>② 大代表承認（代表者のみ）</h3>
      <p style={noteStyle}>
        承認は凍結されたスナップショットのダイジェストに対して行われます。ブロック理由:
        {gateBlocks ? ' G6未満（決済条件が未確定）' : ''}
        {pending.some((po) => po.status === 'SNAPSHOT_VOIDED') ? ' スナップショット失効（再承認が必要）' : ''}
        {!gateBlocks ? ' なし（前提を満たしています）' : ''}
      </p>
      {pending.map((po) => (
        <div key={po.id} style={{ marginBottom: 12 }}>
          {isAdmin ? (
            <ActionForm
              action={approveMakerPoAction}
              submitLabel="代表承認を記録する"
              hint="決済条件が未確定のまま実行すると、APIが G6 のブロック理由を返します。"
            >
              <input type="hidden" readOnly name="poId" value={po.id} />
            </ActionForm>
          ) : (
            <p style={noteStyle}>
              メーカー発注書 <span style={monoStyle}>{po.id}</span> は代表承認待ちです。次のアクション:
              代表者の承認を待ちます（{role === 'viewer' ? '閲覧者' : '担当者'}は承認できません）。
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function MakerPoWorkBlocks({
  po,
  isAdmin,
  role,
  sendEvidenceChoices,
  acceptanceEvidenceChoices
}: {
  po: MakerPoViewRow;
  isAdmin: boolean;
  role: string;
  sendEvidenceChoices: Choice[];
  acceptanceEvidenceChoices: Choice[];
}) {
  return (
    <>
      {po.status === 'APPROVED_FOR_MANUAL_SEND' ? (
        <div style={{ borderTop: '1px solid #eef1f6', marginTop: 16, paddingTop: 12 }}>
          <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>③ 手動送信記録（担当者・代表者が記録）</h3>
          <p style={noteStyle}>
            送信はシステムの外（メール）で行うので、ここでは証跡を記録します。宛先は発注書の宛先住所と一致が必要です。
            ブロック理由: {sendEvidenceChoices.length === 0 ? '送信証跡（send_evidence）の書類バージョンがまだありません' : 'なし'}
          </p>
          {sendEvidenceChoices.length === 0 ? (
            <p style={noteStyle}>次のアクション: 「文書」画面で送信証跡（send_evidence）をアップロードしてください。</p>
          ) : (
            <ActionForm
              action={recordMakerPoSendEvidenceAction}
              submitLabel="手動送信を記録する"
              hint="証跡の書類バージョン、送信元、宛先、送信日時を記録します。証跡なしの記録は送信未確認になり、以降の操作が停止します。"
            >
              <input type="hidden" readOnly name="poId" value={po.id} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <SelectField
                  name="evidenceDocumentVersionId"
                  label="送信証跡の書類バージョン"
                  required
                  choices={sendEvidenceChoices}
                  width={420}
                />
                <TextField name="senderAddress" label="送信元アドレス" required width={260} />
                <TextField
                  name="recipients"
                  label="宛先アドレス（カンマ区切り）"
                  required
                  defaultValue={po.recipientAddress ?? undefined}
                  width={260}
                />
                <TextField name="sentAt" label="送信日時" type="datetime-local" required width={240} />
              </div>
            </ActionForm>
          )}
        </div>
      ) : null}

      {po.status === 'MAKER_PO_SENT_MANUALLY' ? (
        <MakerPoAcceptanceBlock
          po={po}
          isAdmin={isAdmin}
          role={role}
          acceptanceEvidenceChoices={acceptanceEvidenceChoices}
        />
      ) : null}
    </>
  );
}

async function MakerPoAcceptanceBlock({
  po,
  isAdmin,
  role,
  acceptanceEvidenceChoices
}: {
  po: MakerPoViewRow;
  isAdmin: boolean;
  role: string;
  acceptanceEvidenceChoices: Choice[];
}) {
  // The provisional record is what the final confirmation later names, so the
  // screen reads the event trail of this paper before offering the buttons.
  const detail = await loadMakerPoDetail(po.id);
  const provisionalCount = detail.events.filter((event) => event.provisional === true).length;
  const provisionalRecords: MakerPoEventRow[] = detail.events.filter((event) => event.provisional === true);

  return (
    <div style={{ borderTop: '1px solid #eef1f6', marginTop: 16, paddingTop: 12 }}>
      <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>④ メーカー受入記録</h3>
      <p style={noteStyle}>
        受入は二段階です。まず担当者が「受入記録（仮）」を書き、そのあと代表者が受領証跡を検証して
        「最終受入確認」を記録します。仮の記録だけでは発注書は受入済みになりません。
      </p>
      <p style={noteStyle}>
        仮の受入記録: {provisionalCount}件
        {provisionalCount > 0 ? (
          <span style={monoStyle}>
            {' '}（{provisionalRecords.map((event) => formatTimestamp(event.recordedAt)).join('、')}）
          </span>
        ) : (
          ' ／ 次のアクション: 担当者が受入記録（仮）を記録してください。'
        )}
      </p>

      <details style={{ marginBottom: 12 }} open={provisionalCount === 0}>
        <summary style={{ fontSize: 13, cursor: 'pointer' }}>受入記録（仮）を書く（担当者・代表者）</summary>
        <ActionForm
          action={recordProvisionalAcceptanceAction}
          submitLabel="受入記録（仮）を記録する"
          hint="この記録は「仮」と明示され、発注書の状態は動きません。最終受入確認は代表者だけが記録できます。"
        >
          <input type="hidden" readOnly name="poId" value={po.id} />
          <TextField name="acceptedAt" label="メーカー受入の日時" type="datetime-local" width={240} />
        </ActionForm>
      </details>

      {isAdmin ? (
        acceptanceEvidenceChoices.length === 0 ? (
          <p style={noteStyle}>
            最終受入確認のブロック理由: 受領証跡（acceptance_evidence）の書類バージョンがありません。
            次のアクション: 「文書」画面で受領証跡をアップロードし、確認済みにしてください。
          </p>
        ) : (
          <details>
            <summary style={{ fontSize: 13, cursor: 'pointer' }}>最終受入確認を記録する（代表者のみ）</summary>
            <ActionForm
              action={recordFinalAcceptanceAction}
              submitLabel="最終受入確認を記録する"
              hint={
                provisionalCount > 0
                  ? `仮の受入記録が ${provisionalCount}件 あります。最終確認はその記録を引き継いで確定します。`
                  : '仮の受入記録がなくても最終確認は可能です（記録には事前に確認済みの受領証跡が必要です）。'
              }
            >
              <input type="hidden" readOnly name="poId" value={po.id} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <SelectField
                  name="evidenceDocumentVersionId"
                  label="受領証跡の書類バージョン（確認済み）"
                  required
                  choices={acceptanceEvidenceChoices}
                  width={420}
                />
                <TextField name="acceptedAt" label="受入日時" type="datetime-local" width={240} />
              </div>
            </ActionForm>
          </details>
        )
      ) : (
        <p style={noteStyle}>
          最終受入確認は代表者のみです。次のアクション: 受入記録（仮）を書き、代表者の確認を待ちます
          （{role === 'viewer' ? '閲覧者は閲覧のみです' : '担当者は仮の記録まで'}）。
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 5: role-aware audit dashboard (the API answers through the S3 filter)
// ---------------------------------------------------------------------------

interface MakerPoAuditPayload {
  events: AuditEventView[];
  error: string | null;
}

async function loadMakerPoAudit(projectId: string): Promise<MakerPoAuditPayload> {
  const base = `/api/projects/${encodeURIComponent(projectId)}/audit-history`;
  const [poEvents, makerEvents] = await Promise.all([
    callApi<{ events: AuditEventView[] }>(`${base}?entityType=maker_purchase_order&limit=200`),
    callApi<{ events: AuditEventView[] }>(`${base}?entityType=maker_po_event&limit=200`)
  ]);
  if (!poEvents.ok && !makerEvents.ok) {
    return { events: [], error: poEvents.error ?? makerEvents.error ?? '監査履歴が取得できませんでした。' };
  }
  const events = [
    ...(poEvents.ok && poEvents.data ? poEvents.data.events : []),
    ...(makerEvents.ok && makerEvents.data ? makerEvents.data.events : [])
  ].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
  return { events, error: null };
}

function AuditDashboardSection({
  events,
  error,
  role
}: {
  events: AuditEventView[];
  error: string | null;
  role: string;
}) {
  return (
    <div style={cardStyle}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>⑤ 監査ダッシュボード（役割に応じた表示）</h2>
      <p style={noteStyle}>
        監査履歴（GET /api/projects/:id/audit-history）をメーカー発注の記録だけに絞って表示します。
        表示内容は API が役割ごとに決めます: 代表者は金額やスナップショットまで、担当者は状態の形だけ、
        閲覧者は概要だけを見ます。現在の役割: {role === 'admin' ? '代表者' : role === 'staff' ? '担当者' : '閲覧者'}。
      </p>
      {error ? <div style={infoBoxStyle}>{error}</div> : null}
      {events.length === 0 ? (
        <p style={noteStyle}>メーカー発注の監査記録はまだありません。</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>日時</th>
              <th style={thStyle}>操作</th>
              <th style={thStyle}>種別</th>
              <th style={thStyle}>対象ID</th>
              <th style={thStyle}>状態（役割に見える範囲）</th>
              <th style={thStyle}>実行者</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const after = (event.afterState ?? null) as Record<string, unknown> | null;
              const status = after && typeof after.status === 'string' ? after.status : null;
              return (
                <tr key={event.id}>
                  <td style={tdStyle}>{formatTimestamp(event.occurredAt)}</td>
                  <td style={tdStyle}>{event.action}</td>
                  <td style={tdStyle}>{event.entityType}</td>
                  <td style={tdStyle}><span style={monoStyle}>{event.entityId}</span></td>
                  <td style={tdStyle}>
                    {status ? MAKER_PO_STATUS_LABELS[status] ?? status : '—'}
                    {after && after.provisional === true ? '（仮の受入記録を含む）' : ''}
                  </td>
                  <td style={tdStyle}>
                    {event.actor?.displayName ?? '—'}
                    <div style={noteStyle}>{MAKER_PO_EVENT_TYPE_LABELS[event.action] ?? ''}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
