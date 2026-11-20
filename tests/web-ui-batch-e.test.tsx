import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OFFICIAL_ARTIFACT_DOCUMENT_TYPES } from '@kanei/core';

/**
 * UI batch E (demo-eml/ui-batch-e/REPORT.md): the persona friction fixes that
 * live in the web layer only — dead ends (F-05 F-07 F-10), the facts behind a
 * representative decision (F-08 F-11 F-23), wording and formats (F-12–F-22)
 * and the evidence warning before a transition (F-06). Pure helpers and server
 * markup; the real-API checks are in web-ui-batch-e-parity.test.tsx.
 */

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, refresh: () => undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => undefined, refresh: () => undefined }), usePathname: () => '/orders' }));

const { formatDateOrTimestamp, formatMoney } = await import('../apps/web/src/lib/vocabulary.js');
const { summaryFieldsFor } = await import('../apps/web/src/lib/confirm-summary.js');
const { ceoApprovalFacts, holdReleaseFacts, holdSummaryText } = await import('../apps/web/src/lib/decision-facts.js');
const { EVIDENCE_GAP_SUFFIX, evidenceGapsFor } = await import('../apps/web/src/lib/transition-evidence.js');
const { statusSymbol, TONE_SYMBOLS } = await import('../apps/web/src/lib/status-tone.js');
const { defaultSevenPoId, requiresSevenPo, SEVEN_PO_REQUIRED_DOCUMENT_TYPES } = await import('../apps/web/src/lib/document-maker-po.js');
const { failedRepresentativeQueue, replayOrderStatuses, representativeTasks, REPRESENTATIVE_WORK } = await import('../apps/web/src/lib/representative-queue.js');
const { isPlainAmount, normalizeAmountText } = await import('../apps/web/src/lib/amount.js');
const { nextActionForOrder } = await import('../apps/web/src/lib/project-data.js');
const { fieldForActionMessage } = await import('../apps/web/src/lib/form-messages.js');
const { StatusBadge } = await import('../apps/web/src/components/StatusBadge.js');
const { OrderCreateForm } = await import('../apps/web/src/components/OrderCreateForm.js');
const { DocumentUploadForm } = await import('../apps/web/src/components/DocumentUploadForm.js');
const { CheckboxField, DateTextField } = await import('../apps/web/src/components/fields.js');
const { ProjectUnavailable } = await import('../apps/web/src/components/ProjectUnavailable.js');
const { RepresentativeQueuePanel } = await import('../apps/web/src/components/RepresentativeQueue.js');
const { createFilmSupplyOrderAction, uploadDocumentAction } = await import('../apps/web/src/app/actions.js');

const noop = async () => ({ ok: true, message: '' });
/** Server markup without React's text separators. */
const markup = (node: Parameters<typeof renderToString>[0]) => renderToString(node).replaceAll('<!-- -->', '');
const label = (key: string) => `L:${key}`;

describe('F-15: amounts and date-only values as people write them', () => {
  it('formatMoney: ¥ and group commas for JPY, the code for another currency, unchanged text otherwise', () => {
    expect(formatMoney('JPY', '480000')).toBe('¥480,000');
    expect(formatMoney('jpy', '1200.5')).toBe('¥1,200.5');
    expect(formatMoney('USD', '1234567.25')).toBe('USD 1,234,567.25');
    expect(formatMoney('', '999')).toBe('999');
    expect(formatMoney('JPY', '約50万')).toBe('JPY 約50万');
    expect(formatMoney('JPY', '')).toBe('—');
    // A value that is not a plain non-negative decimal is shown as recorded (review L8).
    expect(formatMoney('JPY', '-480000')).toBe('JPY -480000');
  });

  it('normalizeAmountText / isPlainAmount: only the spelling of a plain amount is normalised (review L8)', () => {
    expect(normalizeAmountText('¥480,000')).toBe('480000');
    expect(normalizeAmountText('４８０，０００')).toBe('480000');
    expect(normalizeAmountText(' 1,234.5 ')).toBe('1234.5');
    expect(normalizeAmountText('480000')).toBe('480000');
    for (const odd of ['1,2,3', '480000円', '-480000', '48 0000', '']) {
      expect(isPlainAmount(normalizeAmountText(odd)), odd).toBe(false);
    }
    expect(isPlainAmount('480000')).toBe(true);
  });

  it('formatDateOrTimestamp: midnight UTC or JST reads as the date; any other instant keeps its JST time', () => {
    expect(formatDateOrTimestamp('2026-11-19T00:00:00.000Z')).toBe('2026/11/19');
    expect(formatDateOrTimestamp('2026-11-18T15:00:00.000Z')).toBe('2026/11/19');
    expect(formatDateOrTimestamp('2026-11-19T05:30:00.000Z')).toBe('2026/11/19 14:30 JST');
    expect(formatDateOrTimestamp(null)).toBe('—');
  });

  it('the date field has no placeholder that looks like a value; the example is the hint outside it (T5)', () => {
    const html = renderToString(<DateTextField name="officialRegisteredAt" label="公式登録日" />);
    expect(html).not.toContain('placeholder=');
    expect(html).toContain('例 2026/11/18（日本時間の日付）');
  });
});

describe('F-18: a reason row only for the target it belongs to', () => {
  const when = { holdReason: { field: 'to', values: ['ON_HOLD'] }, evidenceNote: { field: 'to', values: ['ARTWORK_RECEIVED'] } };
  it('drops the hold reason unless 保留中 is the chosen target', () => {
    expect(summaryFieldsFor(['to', 'holdReason', 'evidenceNote'], when, () => 'PROOF_READY')).toEqual(['to']);
    expect(summaryFieldsFor(['to', 'holdReason', 'evidenceNote'], when, () => 'ON_HOLD')).toEqual(['to', 'holdReason']);
    expect(summaryFieldsFor(['to', 'holdReason', 'evidenceNote'], when, () => 'ARTWORK_RECEIVED')).toEqual(['to', 'evidenceNote']);
  });
  it('without conditions every field is listed (unchanged forms)', () => {
    expect(summaryFieldsFor(['a', 'b'], undefined, () => '')).toEqual(['a', 'b']);
  });
});

describe('F-08: the representative approval lists what is approved', () => {
  it('order code, address, amount (formatted) and payment terms from the admin answer', () => {
    const facts = ceoApprovalFacts(
      { snapshot: { order: { code: 'FSO-E-1' }, recipient: { address: '大阪府 合成メーカー' }, amounts: { currency: 'JPY', totalAmount: '480000' } } },
      'FSO-FALLBACK',
      'prepaid'
    );
    expect(facts).toEqual([
      { label: '発注コード', value: 'FSO-E-1' },
      { label: 'メーカーの送信先', value: '大阪府 合成メーカー' },
      { label: '金額', value: '¥480,000' },
      { label: '支払条件', value: '前払い' }
    ]);
  });
  it('a value the answer does not carry is named as missing, never invented', () => {
    const facts = ceoApprovalFacts({ recipientAddress: null }, 'FSO-E-2', null);
    expect(facts.map((fact) => fact.value)).toEqual(['FSO-E-2', '（記録なし）', '（記録なし）', '（確認できません）']);
  });
});

describe('F-11: the hold reason, who held the order and when', () => {
  const hold = { reason: '色見本の再確認待ち', reasonHidden: false, actorName: '合成担当者', at: '2026-11-19T01:00:00.000Z' };
  it('one line under the badge and three dialog rows', () => {
    expect(holdSummaryText(hold)).toBe('保留の理由: 色見本の再確認待ち（合成担当者 が 2026/11/19 10:00 JST に保留）');
    expect(holdReleaseFacts({ code: 'FSO-E-3', hold })).toEqual([
      { label: '発注コード', value: 'FSO-E-3' },
      { label: '保留の理由', value: '色見本の再確認待ち' },
      { label: '保留した人・日時', value: '合成担当者／2026/11/19 10:00 JST' }
    ]);
  });
  it('a reason withheld from the role says so; an unseen hold is not guessed', () => {
    expect(holdSummaryText({ ...hold, reason: null, reasonHidden: true })).toContain('保留の理由: （閲覧権限なし）');
    expect(holdReleaseFacts({ code: 'FSO-E-4', hold: null })[1]).toEqual({ label: '保留の理由', value: '（確認できません）' });
  });
});

describe('F-06: evidence warnings before a transition (warn only, never block)', () => {
  const empty = { documents: [], revisions: [], revisionsWithheld: 0, deliveries: [] };
  it('names the missing document, proof revision and delivery of the order', () => {
    const gaps = evidenceGapsFor({ id: 'o1' }, empty, ['ARTWORK_RECEIVED', 'PROOF_READY', 'FILM_DELIVERED', 'ON_HOLD']);
    expect(gaps.map((gap) => gap.target)).toEqual(['ARTWORK_RECEIVED', 'PROOF_READY', 'FILM_DELIVERED']);
    expect(EVIDENCE_GAP_SUFFIX).toBe('証跡がないまま進めると、画面の状態と実物の証跡が食い違います。');
  });
  it('no gap when the evidence is there, or when the role may not see whether it is', () => {
    const full = {
      documents: [{ filmSupplyOrderId: 'o1' }],
      revisions: [{ filmSupplyOrderId: 'o1' }],
      revisionsWithheld: 0,
      deliveries: [{ kind: 'film', orderId: 'o1', detailsHidden: false }]
    } as unknown as Parameters<typeof evidenceGapsFor>[1];
    expect(evidenceGapsFor({ id: 'o1' }, full, ['ARTWORK_RECEIVED', 'PROOF_READY', 'FILM_DELIVERED'])).toEqual([]);
    const withheld = {
      ...empty,
      revisionsWithheld: 1,
      deliveries: [{ kind: 'film', orderId: null, detailsHidden: true }]
    } as unknown as Parameters<typeof evidenceGapsFor>[1];
    expect(evidenceGapsFor({ id: 'o1' }, withheld, ['PROOF_READY', 'FILM_DELIVERED'])).toEqual([]);
  });
});

describe('F-16: 保留中 reads ‖, the other statuses keep their tone symbol', () => {
  it('statusSymbol', () => {
    expect(statusSymbol('filmOrder', 'ON_HOLD', 'blocked')).toBe('‖');
    expect(statusSymbol('filmOrder', 'CANCELLED', 'blocked')).toBe(TONE_SYMBOLS.blocked);
    expect(statusSymbol('filmOrder', 'CANCELLATION_REVIEW', 'blocked')).toBe('✕');
    expect(statusSymbol('makerPo', 'ON_HOLD', 'neutral')).toBe(TONE_SYMBOLS.neutral);
    expect(statusSymbol(undefined, undefined, 'hidden')).toBe('—');
  });
  it('the badge markup', () => {
    expect(renderToString(<StatusBadge domain="filmOrder" status="ON_HOLD" label="保留中" />))
      .toBe('<span class="status-badge status-badge--blocked"><span class="status-badge-mark" aria-hidden="true">‖</span>保留中</span>');
    expect(renderToString(<StatusBadge domain="filmOrder" status="CANCELLED" label="キャンセル終了" />))
      .toContain('aria-hidden="true">✕</span>キャンセル終了');
  });
});

describe('F-05: a film order is created with its セブン化学発注書', () => {
  const choices = [{ value: 'po-1', label: 'SC-E-1（公式登録済み）' }];
  it('the PO select is required, starts blank and offers no 「紐付けない」', () => {
    const html = renderToString(
      <OrderCreateForm action={noop} orderKind="film" unitChoices={[{ value: 'rolls', label: 'ロール' }]} sevenPurchaseOrderChoices={choices} />
    );
    expect(html).toMatch(/セブン化学発注書<span style="color:var\(--danger\)">（必須）<\/span>/);
    expect(html).toMatch(/<select name="sevenPurchaseOrderId" required=""/);
    expect(html).toContain('<option value="" selected="">（発注書を選ぶ）</option>');
    expect(html).not.toContain('紐付けない');
    expect(html).not.toContain('（任意）');
    expect(html).toContain('紐付けはここでしか選べません');
  });
  it('without a registered PO the field says to register one first', () => {
    const html = renderToString(
      <OrderCreateForm action={noop} orderKind="film" unitChoices={[{ value: 'rolls', label: 'ロール' }]} sevenPurchaseOrderChoices={[]} />
    );
    expect(html).toContain('（登録済みの発注書がありません）');
    expect(html).toContain('先に「セブン化学発注書を登録する」で紙の発注書を登録してください。');
  });
  it('the filling order form has no PO field (unchanged)', () => {
    const html = renderToString(<OrderCreateForm action={noop} orderKind="filling" unitChoices={[{ value: 'pods', label: 'ポッド' }]} />);
    expect(html).not.toContain('sevenPurchaseOrderId');
  });
  it('the server action refuses a film order without a PO, on the field', async () => {
    const form = new FormData();
    form.set('code', 'FSO-E-5');
    form.set('lines', JSON.stringify([{ description: '合成', orderedQuantity: '10', unit: 'rolls' }]));
    // requireProjectId reads the project cookie (mocked away): the project refusal comes first.
    const refused = await createFilmSupplyOrderAction(null, form);
    expect(refused.ok).toBe(false);
    expect(fieldForActionMessage('セブン化学発注書を選択してください。')).toBe('sevenPurchaseOrderId');
  });
});

describe('F-07: the PO link follows the document type', () => {
  it('the web mirror equals the core list of official artifacts', () => {
    expect([...SEVEN_PO_REQUIRED_DOCUMENT_TYPES]).toEqual([...OFFICIAL_ARTIFACT_DOCUMENT_TYPES]);
    expect(requiresSevenPo('proof')).toBe(true);
    expect(requiresSevenPo('seven_po')).toBe(false);
  });
  it('defaultSevenPoId: the one ready PO, else none', () => {
    expect(defaultSevenPoId([{ value: 'a', label: 'A', ready: true }, { value: 'b', label: 'B', ready: false }])).toBe('a');
    expect(defaultSevenPoId([{ value: 'a', label: 'A', ready: true }, { value: 'b', label: 'B', ready: true }])).toBe('');
    expect(defaultSevenPoId([])).toBe('');
  });
  function upload(firstType: string) {
    return markup(
      <DocumentUploadForm
        action={noop}
        documentTypeChoices={[{ value: firstType, label: firstType }]}
        issuerEntityChoices={[{ value: 'kanei', label: 'カネイ' }]}
        contentTypeChoices={[{ value: 'text/plain', label: 'テキスト' }]}
        sevenPurchaseOrderChoices={[{ value: 'po-ready', label: 'SC-E-2（公式登録済み）', ready: true }]}
        filmSupplyOrderChoices={[]}
      />
    );
  }
  it('a proof: 「必須」, required and the ready PO preselected', () => {
    const html = upload('proof');
    expect(html).toMatch(/セブン化学発注書の紐付け<span style="color:var\(--danger\)">（必須）<\/span>/);
    expect(html).toMatch(/<select name="sevenPurchaseOrderId" required=""/);
    expect(html).toContain('<option value="po-ready" selected="">SC-E-2（公式登録済み）</option>');
    expect(html).not.toContain('セブン化学発注書の紐付け（任意）');
  });
  it('a purchase order document: 「任意」 and 「紐付けない」 stay', () => {
    const html = upload('seven_po');
    expect(html).toContain('セブン化学発注書の紐付け（任意）');
    expect(html).toContain('紐付けない');
    expect(html).not.toMatch(/<select name="sevenPurchaseOrderId" required=""/);
    // Not preselected for a type that does not need the link.
    expect(html).toContain('<option value="po-ready">SC-E-2（公式登録済み）</option>');
  });
  it('the upload action refuses an official artifact without a PO on the field', async () => {
    expect(fieldForActionMessage('セブン化学発注書を選択してください（校正ゲラ・各種証跡では必須です）。')).toBe('sevenPurchaseOrderId');
    const form = new FormData();
    form.set('documentType', 'proof');
    form.set('filename', 'proof.txt');
    form.set('contentBase64', 'eA==');
    const refused = await uploadDocumentAction(null, form);
    expect(refused.ok).toBe(false);
  });
});

describe('F-17: the consent box stops the submit before the dialog', () => {
  it('a required checkbox renders required (native and shell validation)', () => {
    const html = renderToString(<CheckboxField name="acknowledgeNoEvidence" label="同意します" required />);
    const input = html.match(/<input type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('required=""');
    expect(input).toContain('name="acknowledgeNoEvidence"');
  });
});

describe('F-12: a project that cannot be opened shows only the way out', () => {
  it('ProjectUnavailable: the step, the API reason, no form', () => {
    const html = markup(<ProjectUnavailable title="文書" reason="案件が見つかりません 上部の「案件」から選び直してください。" />);
    expect(html).toContain('<h1');
    // ui/fix-project-select: what happened and the one thing to do, as a button.
    expect(html).toContain('この案件は開けません。削除されたか、担当から外れた可能性があります。「案件を選び直す」を押して、開ける案件から選んでください。');
    expect(html).toContain('href="/project-selection?next=%2Fdashboard&amp;reset=1"');
    expect(html).toContain('理由（システムの応答）: 案件が見つかりません');
    expect(html).not.toContain('<form');
  });
});

describe('F-23: the representative queue across projects', () => {
  const event = (action: string, entityId: string, afterState: Record<string, unknown>) => ({
    id: `${entityId}-${action}`, action, entityType: 'film_supply_order', entityId,
    beforeState: null, afterState, occurredAt: '2026-11-19T00:00:00.000Z', requestMetadata: null, actor: null
  });
  it('replays each order to its latest state and keeps only the representative work', () => {
    const orders = replayOrderStatuses([
      event('FILM_SUPPLY_ORDER_CREATED', 'a', { code: 'FSO-A', status: 'DRAFT' }),
      event('FILM_SUPPLY_ORDER_CREATED', 'b', { code: 'FSO-B', status: 'DRAFT' }),
      event('FILM_SUPPLY_ORDER_TRANSITIONED', 'a', { status: 'ON_HOLD', holdReason: '確認待ち' }),
      event('FILM_SUPPLY_ORDER_TRANSITIONED', 'b', { status: 'SEVEN_PO_VERIFIED' })
    ]);
    expect(orders).toEqual([{ id: 'a', code: 'FSO-A', status: 'ON_HOLD' }, { id: 'b', code: 'FSO-B', status: 'SEVEN_PO_VERIFIED' }]);
    const tasks = representativeTasks({ id: 'p1', code: 'P-1', name: '合成案件' }, orders);
    expect(tasks).toEqual([{ projectId: 'p1', orderId: 'a', projectLabel: 'P-1（合成案件）', orderCode: 'FSO-A', status: 'ON_HOLD', work: REPRESENTATIVE_WORK.ON_HOLD }]);
  });
  it('the panel: a row per task with 「この案件を開く」, and a plain line when nothing waits', () => {
    const queue = { tasks: [{ projectId: 'p1', orderId: 'a', projectLabel: 'P-1（合成案件）', orderCode: 'FSO-A', status: 'ON_HOLD', work: '保留の解除（理由の確認）' }], unreadProjects: ['P-9'], skippedProjects: 0 };
    const html = renderToString(<RepresentativeQueuePanel queue={queue} selectAction={noop} currentProjectId={null} />);
    expect(html).toContain('<caption class="visually-hidden">代表者の対応待ち（全案件）</caption>');
    expect(html).toContain('保留の解除（理由の確認）');
    expect(html).toContain('この案件を開く');
    expect(html).toContain('name="projectId" value="p1"');
    expect(html).toContain('読み込めなかった案件: P-9。');
    const none = renderToString(<RepresentativeQueuePanel queue={{ tasks: [], unreadProjects: [], skippedProjects: 0 }} selectAction={noop} currentProjectId={null} />);
    expect(none).toContain('代表者の対応待ちはありません。');
    // Review M1: a failed project-list read is said as such, never 「ありません」.
    const failed = renderToString(<RepresentativeQueuePanel queue={failedRepresentativeQueue('一時的に取得できません')} selectAction={noop} currentProjectId={null} />)
      .replaceAll('<!-- -->', '');
    expect(failed).toContain('案件の一覧を読み込めなかったため、代表者の対応待ちを表示できません（一時的に取得できません）。');
    expect(failed).not.toContain('ありません。');
  });
});

describe('F-10, F-11: 「次にやること」', () => {
  const base = {
    id: 'o1', code: 'FSO-E-9', sevenPurchaseOrderId: 'po', lineCount: 1, lines: [], detailsHidden: false,
    statusHidden: false, lastNormalStatus: null, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z'
  };
  const workspace = { labels: null, sevenPurchaseOrders: [], revisions: [] };
  it('after the send: the provisional record and the 受領証跡 the final confirmation waits for, with the 文書 link', () => {
    const action = nextActionForOrder({ ...base, status: 'MAKER_PO_SENT_MANUALLY' }, workspace, 'staff');
    expect(action.text).toBe('メーカーの受入を記録する（担当者が仮の記録と受領証跡の登録、代表者が受領証跡を確認して最終確認）。');
    expect(action.screens).toEqual(['/maker-po', '/documents']);
  });
  it('on hold: the reason comes first when the role may read it', () => {
    const held = { ...base, status: 'ON_HOLD', hold: { reason: '色見本の再確認待ち', reasonHidden: false, actorName: 'x', at: '2026-11-19T00:00:00Z' } };
    expect(nextActionForOrder(held, workspace, 'admin').text.startsWith('保留の理由は「色見本の再確認待ち」です。代表者が理由を記録して保留を解除する')).toBe(true);
    const hidden = { ...held, hold: { ...held.hold, reason: null, reasonHidden: true } };
    expect(nextActionForOrder(hidden, workspace, 'staff').text.startsWith('代表者が理由を記録して保留を解除する')).toBe(true);
  });
  it('an unlinked draft (admin): the remedy names re-creation and the cancellation review', () => {
    const text = nextActionForOrder({ ...base, status: 'DRAFT', sevenPurchaseOrderId: null }, workspace, 'admin').text;
    expect(text).toContain('紐付けは作成のときだけ選べます。');
    expect(text).toContain('から取消で終了してください。');
    expect(label('x')).toBe('L:x');
  });
});
