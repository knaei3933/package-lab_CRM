import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * p6 int (audit44c REMAINING §1, conductor decisions 2026-11-23): the web half of
 * - X5: staff get no 「証跡なしで問題なしとして完了する」 form while receipt evidence waits for the
 *   representative (the server's receiptClosure.receiptEvidenceAwaitingRepresentative; 409 otherwise);
 * - X3: the evidence list says 「送信の検証: …」 apart from 「書類の確認: …」, and the inline .eml's own
 *   name travels as `filename` (MakerPoSendEvidenceForm → recordMakerPoSendEvidenceAction);
 * - H10: the viewer's overview names the order (code) beside its stage.
 * The real components are rendered; the API is mocked and still decides. Amounts (staff / viewer /
 * auditor see none), idempotency and P-7 (Japanese-only screens carry no Hangul) are not touched.
 */
const session = vi.hoisted(() => ({
  user: null as { id: string; role: string; displayName?: string | null } | null
}));
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  apiTimeoutMs: () => 10_000,
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => session.user,
  loadSession: async () => (session.user ? { kind: 'user', user: session.user } : { kind: 'anonymous' }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => ({ get: () => null })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { StepPanelView } = await import('../apps/web/src/components/StepPanel.js');
const receiptStep = await import('../apps/web/src/components/DeliveryReceiptStep.js');
const { MakerPoSendEvidenceForm } = await import('../apps/web/src/components/MakerPoSendEvidenceForm.js');
const { ProjectOrderList } = await import('../apps/web/src/components/ProjectOrderList.js');
const { EvidenceScreen } = await import('../apps/web/src/screens/EvidenceScreen.js');
const { buildOrderFlow } = await import('../apps/web/src/lib/order-flow.js');
const closureLib = await import('../apps/web/src/lib/receipt-closure.js');
const evidenceLib = await import('../apps/web/src/lib/evidence-data.js');
const redaction = await import('../apps/web/src/lib/redaction.js');
const makerActions = await import('../apps/web/src/app/maker-po/actions.js');
const { webErrorText } = await import('../apps/web/src/lib/error-dictionary.js');
const { IDEMPOTENCY_FIELD, RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');
const realData = await vi.importActual<typeof import('../apps/web/src/lib/project-data.js')>('../apps/web/src/lib/project-data.js');
const { buildAuditViewForRole } = await import('../apps/api/src/audit-view.js');

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const render = (node: ReactNode, showKorean = false) => renderToStaticMarkup(
  <RenderedContextProvider value={{ projectId: 'project-a', showKorean }}>{node}</RenderedContextProvider>
).replaceAll('<!-- -->', '');
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    return resolve(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  const children = element.props.children;
  if (children === undefined) return element;
  const resolved = await resolve(children);
  return Array.isArray(resolved) ? cloneElement(element, undefined, ...resolved) : cloneElement(element, undefined, resolved);
}
const renderAsync = async (tree: ReactNode) => renderToStaticMarkup((await resolve(tree)) as ReactElement).replaceAll('<!-- -->', '');
const ok = (data: unknown = { id: 'row-1' }, status = 200) => ({ ok: true, status, data, error: null, errorKo: null, code: null, failure: null });
const fail = (status: number) => ({ ok: false, status, data: null, error: '失敗しました', errorKo: null, code: null, failure: null });
function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'project-a');
  data.set(IDEMPOTENCY_FIELD, '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c02');
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}
const visibleText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  session.user = { id: 'u-staff', role: 'staff', displayName: '担当' };
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
});

// ================================================================ X5
describe('X5: no 「証跡なしで問題なし」 form for staff while receipt evidence waits for the representative', () => {
  const PO = { id: 'po-1', poNumber: 'SC-1', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };
  const order = (status: string) => ({
    id: 'order-1', code: 'FSO-1', status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: 'line-1', lineNumber: 1, description: '合成フィルム', orderedQuantity: '500', unit: 'meters' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: 'FILM_DELIVERED', paymentTerms: 'prepaid', paymentTermsHidden: false,
    hold: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z'
  });
  const delivery = (id: string, confirmed = false) => ({
    id, kind: 'film', orderId: 'order-1', lineId: 'line-1', unit: 'meters', deliveredQuantity: '500', deliverySequence: 1, deliveredAt: '2026-11-22T01:00:00Z',
    recordedAt: '2026-11-22T01:00:00Z', note: null, confirmed, evidenceDocumentVersionId: null, confirmedAt: null, detailsHidden: false, confirmationHidden: false
  });
  const receiptDoc = (uploadedBy: string) => ({
    id: 'doc-r', documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filename: 'jyuryo.pdf', note: null, verificationStatus: 'unverified', verificationNote: null,
    sevenPurchaseOrderId: null, filmSupplyOrderId: 'order-1', designKey: null, makerPurchaseOrderId: null, uploadedByUserId: uploadedBy,
    detailsHidden: false, typeHidden: false, verificationHidden: false, createdAt: '2026-11-22T02:00:00Z', updatedAt: '2026-11-22T02:00:00Z',
    versions: [{ id: 'ver-r', documentId: 'doc-r', versionNumber: 1, sha256: null, sha256Hidden: true, originalFilename: 'jyuryo.pdf', createdAt: '2026-11-22T02:00:00Z', uploadedByUserId: uploadedBy }]
  });
  /** The delivery-status answer as GET …/delivery-status sends it while 納品済み. */
  const closure = (awaiting: unknown, acknowledgeNoEvidenceRequired = true) => closureLib.receiptClosureFrom({
    receiptClosure: {
      basis: acknowledgeNoEvidenceRequired ? 'evidence_free_acknowledgment' : 'delivery_confirmations', acknowledgeNoEvidenceRequired,
      ...(awaiting === undefined ? {} : { receiptEvidenceAwaitingRepresentative: awaiting })
    },
    receiptAssumption: null
  });
  function panel(role: string, userId: string, over: { closure?: unknown; documents?: unknown[]; deliveries?: unknown[]; showKorean?: boolean } = {}) {
    const o = order('FILM_DELIVERED');
    const documents = over.documents ?? [];
    const deliveries = over.deliveries ?? [delivery('del-1')];
    const flow = buildOrderFlow({
      order: o as never, role, po: PO as never, documents: documents as never, revisions: [], gate: null,
      makerPos: [], makerEvents: [], settledSendEventIds: new Set(), paymentGate: null, deliveries: deliveries as never
    });
    return render(
      <StepPanelView
        flow={flow} order={o as never} projectCode="PRJ-1" role={role} po={PO as never} gate={null}
        maker={null} makerEvents={[]} documents={documents as never} stateLabel={(key) => key}
        deliveryContext={{ deliveries, userId, filmOnly: true, readiness: null, readinessLabel: (key: string) => key, closure: over.closure ?? null } as never}
      />,
      over.showKorean ?? false
    );
  }
  const EVIDENCE_FREE = '証跡なしで問題なしとして完了する';

  it('server says waiting → staff see the note, not the form (no acknowledgment checkbox, no submit for it)', () => {
    const html = panel('staff', 'u-staff', { closure: closure(true), documents: [receiptDoc('u-other')] });
    expect(html).toContain(receiptStep.EVIDENCE_FREE_WITHHELD_TEXT.ja);
    expect(html).toContain('data-evidence-free="withheld"');
    expect(html).not.toContain(EVIDENCE_FREE);
    expect(html).not.toContain('name="acknowledgeNoEvidence"');
    // P-7: a Japanese-only staff screen carries no Hangul, the Korean line only with the bilingual setting.
    expect(html).not.toMatch(HANGUL);
    expect(panel('staff', 'u-staff', { closure: closure(true), showKorean: true })).toContain(receiptStep.EVIDENCE_FREE_WITHHELD_TEXT.ko);
  });

  it('server says not waiting → staff keep the form exactly as before', () => {
    const html = panel('staff', 'u-staff', { closure: closure(false) });
    expect(html).toContain(EVIDENCE_FREE);
    expect(html).toContain('name="acknowledgeNoEvidence"');
    expect(html).not.toContain(receiptStep.EVIDENCE_FREE_WITHHELD_TEXT.ja);
  });

  it('the representative keeps the form while it waits (代表のみ可)', () => {
    session.user = { id: 'u-admin', role: 'admin' };
    const html = panel('admin', 'u-admin', { closure: closure(true), documents: [receiptDoc('u-staff')] });
    expect(html).toContain(EVIDENCE_FREE);
    expect(html).toContain('name="acknowledgeNoEvidence"');
    expect(html).not.toContain(receiptStep.EVIDENCE_FREE_WITHHELD_TEXT.ja);
  });

  it('an API that does not say it: the staff member\'s own evidence waiting (P-4) stands in; no evidence keeps the form', () => {
    const own = panel('staff', 'u-staff', { closure: closure(undefined), documents: [receiptDoc('u-staff')] });
    expect(own).toContain('代表の確認待ち');
    expect(own).toContain(receiptStep.EVIDENCE_FREE_WITHHELD_TEXT.ja);
    expect(own).not.toContain('name="acknowledgeNoEvidence"');
    const none = panel('staff', 'u-staff', { closure: null });
    expect(none).toContain('name="acknowledgeNoEvidence"');
    // The server's false wins over the local guess.
    const told = panel('staff', 'u-staff', { closure: closure(false), documents: [receiptDoc('u-staff')] });
    expect(told).toContain('name="acknowledgeNoEvidence"');
  });

  it('every delivery confirmed: the confirmed-deliveries completion stays for staff, whatever the flag says', () => {
    const html = panel('staff', 'u-staff', { closure: closure(true, false), deliveries: [delivery('del-1', true)] });
    expect(html).toContain('確認済みの納品で完了する');
    expect(html).not.toContain(receiptStep.EVIDENCE_FREE_WITHHELD_TEXT.ja);
  });

  it('pure: staffEvidenceFreeWithheld is for staff only, and reads the server first', () => {
    const fn = receiptStep.staffEvidenceFreeWithheld;
    const waiting = { kind: 'wait_representative', document: receiptDoc('u-staff') } as never;
    const upload = { kind: 'upload_only' } as never;
    for (const role of ['admin', 'viewer', 'auditor', null]) expect(fn(role, closure(true), waiting), String(role)).toBe(false);
    expect(fn('staff', closure(true), upload)).toBe(true);
    expect(fn('staff', closure(false), waiting)).toBe(false);
    expect(fn('staff', closure(undefined), waiting)).toBe(true);
    expect(fn('staff', closure(undefined), upload)).toBe(false);
    expect(fn('staff', null, waiting)).toBe(true);
    expect(fn('staff', null, upload)).toBe(false);
    expect(fn('staff', closure(true, false), waiting)).toBe(false);
  });

  it('receiptClosureFrom reads the flag as a boolean only (anything else is "not said")', () => {
    expect(closure(true)!.pending!.awaitingRepresentative).toBe(true);
    expect(closure(false)!.pending!.awaitingRepresentative).toBe(false);
    for (const bad of [undefined, 'true', 1, null]) expect(closure(bad)!.pending!.awaitingRepresentative, String(bad)).toBeNull();
  });

  it('the 409 reads in the operator\'s words (ja / ko) and the code is documented', () => {
    const text = webErrorText('RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE');
    expect(text.code).toBe('RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE');
    expect(text.message).toContain('代表の確認を待っています');
    expect(text.message).toContain('証跡なしでの完了は代表だけが記録できます');
    expect(text.messageKo).toMatch(HANGUL);
    expect(readFileSync(path.join(root, 'docs/api/ERROR_CODES.md'), 'utf8')).toMatch(/^\| `RECEIPT_EVIDENCE_AWAITING_REPRESENTATIVE` \| 409 \|/m);
  });
});

// ================================================================ X3
describe('X3: the send evidence row says its send check and keeps the uploaded name', () => {
  const SHA = 'ab12' + '0'.repeat(56) + 'ef90';
  const version = (over: Record<string, unknown> = {}) => ({
    versionId: 'v-1', versionNumber: 1, originalFilename: 'd-send-002.eml', sha256: SHA, byteSize: 10, detectedMimeType: null,
    uploadedAt: '2026-11-20T01:00:00Z', uploadedBy: { id: 'u2', displayName: '佐藤', role: 'staff' }, sendVerification: 'auto_verified', ...over
  });
  const sendDoc = (versions: unknown[], over: Record<string, unknown> = {}) => ({
    documentId: 'doc-s', documentType: 'send_evidence', issuerEntity: 'kanei', originalFilename: 'maker-po-0192-send-evidence.eml',
    filmSupplyOrderId: 'o-1', orderCode: 'FSO-1', designKey: null, verificationStatus: 'unverified', verifiedAt: null, verifiedBy: null,
    createdAt: '2026-11-20T01:00:00Z', createdBy: { id: 'u2', displayName: '佐藤', role: 'staff' }, versions, ...over
  });
  function routes(documents: unknown[]) {
    callApi.mockImplementation(async (url: string) => {
      if (String(url).includes('/evidence-metadata')) return ok({ projectId: 'p-a', limit: 200, truncated: false, documents });
      if (String(url).includes('/audit-history')) return ok({ events: [] });
      if (String(url).includes('/film-supply-orders')) return ok({ orders: [{ id: 'o-1', code: 'FSO-1' }] });
      return fail(404);
    });
  }
  const screen = async () => renderAsync(await EvidenceScreen({ projectId: 'p-a', projectCode: 'PRS-A', searchParams: Promise.resolve({}) }));

  it.each([
    ['auto_verified', '自動確認済み'],
    ['manual_pending', '手動確認待ち'],
    ['manual_confirmed', '手動確認済み'],
    ['manual_rejected', '却下']
  ])('%s → 「送信の検証: %s」 beside 「書類の確認: 未確認」 (staff and auditor)', async (state, label) => {
    for (const role of ['staff', 'auditor']) {
      session.user = { id: 'u', role };
      routes([sendDoc([version({ sendVerification: state })])]);
      const html = await screen();
      expect(html, role).toContain(`<span data-check="send">送信の検証: ${label}</span>`);
      expect(html, role).toContain('data-check="document">書類の確認: 未確認</span>');
      // X3: the uploaded name, not the system key.
      expect(html, role).toContain('d-send-002.eml');
      expect(html, role).not.toContain('maker-po-0192-send-evidence.eml');
    }
  });

  it('the newest version that was cited decides; a send document with none cited reads as before', async () => {
    routes([sendDoc([version({ versionId: 'v-1', versionNumber: 1, sendVerification: 'manual_pending' }), version({ versionId: 'v-2', versionNumber: 2, sendVerification: 'auto_verified' })])]);
    expect(await screen()).toContain('送信の検証: 自動確認済み');
    routes([sendDoc([version({ versionId: 'v-1', versionNumber: 1, sendVerification: 'manual_confirmed' }), version({ versionId: 'v-2', versionNumber: 2, sendVerification: null })])]);
    expect(await screen()).toContain('送信の検証: 手動確認済み');
    routes([sendDoc([version({ sendVerification: null })])]);
    const html = await screen();
    expect(html).not.toContain('送信の検証');
    expect(html).not.toContain('data-check="document"');
    expect(visibleText(html)).toContain('未確認');
  });

  it('only a send evidence says it: another document type with the field set reads its own check only', async () => {
    routes([sendDoc([version({ sendVerification: 'auto_verified' })], { documentType: 'acceptance_evidence', verificationStatus: 'verified' })]);
    const html = await screen();
    expect(html).not.toContain('送信の検証');
    expect(html).toContain('確認済み');
  });

  it('parseEvidenceMetadata keeps only the server\'s words (an unknown value or an older API → null)', () => {
    const parsed = (value: unknown) => evidenceLib.parseEvidenceMetadata({ documents: [sendDoc([version({ sendVerification: value })])] })!.documents[0]!.versions[0]!.sendVerification;
    for (const value of ['auto_verified', 'manual_pending', 'manual_confirmed', 'manual_rejected']) expect(parsed(value)).toBe(value);
    for (const value of ['VERIFIED', 'toString', '', 3, null, undefined]) expect(parsed(value), String(value)).toBeNull();
  });

  it('the form carries the picked .eml\'s name as `filename` (empty until a file is read)', () => {
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'project-a', showKorean: false }}>
        <MakerPoSendEvidenceForm action={async () => null} poId="po-1" sendEvidenceChoices={[]} orderCode="FSO-1" />
      </RenderedContextProvider>
    );
    expect(html).toContain('<input type="hidden" readOnly="" name="filename" value=""/>');
    expect(html.match(/name="filename"/g)).toHaveLength(1);
  });

  const sendForm = (over: Record<string, string>) => form({
    poId: 'po-1', senderAddress: 'staff@kanei.example', recipients: 'maker@example.com', sentAt: '2026-11-23T10:00:00+09:00', ...over
  });
  const postedBody = () => (callApi.mock.calls.at(-1)![1] as { body: Record<string, unknown> }).body;

  it('the action sends the name with an inline .eml, and never with a cited version or an empty name', async () => {
    await makerActions.recordMakerPoSendEvidenceAction(null, sendForm({ contentBase64: 'RU1M', filename: 'd-send-002.eml' }));
    expect(callApi.mock.calls.at(-1)![0]).toBe('/api/maker-purchase-orders/po-1/send-evidence');
    expect(postedBody()).toMatchObject({ contentBase64: 'RU1M', filename: 'd-send-002.eml' });
    await makerActions.recordMakerPoSendEvidenceAction(null, sendForm({ contentBase64: 'RU1M', filename: '' }));
    expect(postedBody()).not.toHaveProperty('filename');
    await makerActions.recordMakerPoSendEvidenceAction(null, sendForm({ evidenceDocumentVersionId: 'ver-1', filename: 'stale.eml' }));
    expect(postedBody()).toMatchObject({ evidenceDocumentVersionId: 'ver-1' });
    expect(postedBody()).not.toHaveProperty('filename');
  });
});

// ================================================================ H10
describe('H10: the viewer\'s overview names the order beside its stage', () => {
  const PROJECT_ID = 'p-h10';
  const row = (id: number, entityType: string, action: string, entityId: string, afterState: Record<string, unknown>) => ({
    id: `e-${id}`, action, entityType, entityId, beforeState: null, afterState, occurredAt: `2026-11-20T0${id}:00:00.000Z`,
    requestMetadata: { operation: 'x' }, actor: { id: 'u1', displayName: '担当', role: 'staff' }
  });
  const ROWS = [
    row(1, 'film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', 'f-1', {
      id: 'f-1', code: 'FSO-H10-1', status: 'DRAFT', lineCount: 1, paymentTerms: 'prepaid', sevenPurchaseOrderId: 'po-1', note: '社内メモH10'
    }),
    row(2, 'film_supply_order', 'FILM_SUPPLY_ORDER_TRANSITIONED', 'f-1', { status: 'ARTWORK_RECEIVED' }),
    row(3, 'filling_order', 'FILLING_ORDER_CREATED', 'fl-1', { id: 'fl-1', code: 'FIL-H10-1', lineCount: 1 }),
    row(4, 'document', 'DOCUMENT_CREATED', 'd-1', { id: 'd-1', code: 'DOC-H10', status: 'x', originalFilename: 'quote_¥98765.pdf', documentType: 'film_quote_kanei', issuerEntity: 'kanei' }),
    row(5, 'maker_purchase_order', 'MAKER_PO_CREATED', 'm-1', { code: 'MPO-H10', status: 'DRAFT', totalAmount: '98765' })
  ];
  function serveViewer() {
    callApi.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes('/audit-history')) {
        const view = buildAuditViewForRole('viewer', ROWS.map((entry) => ({ ...entry, occurredAt: new Date(entry.occurredAt) })) as never);
        return ok({ events: JSON.parse(JSON.stringify(view)) });
      }
      if (target.includes('/status-labels')) return ok({ filmSupplyOrderStates: [] });
      if (target.includes('/film-supply-orders')) return ok({ orders: [] });
      if (target === `/api/projects/${PROJECT_ID}`) return ok({ id: PROJECT_ID, code: 'PRJ-H10', name: '合成', route: 'F1', status: 'ACTIVE' });
      return ok({});
    });
  }

  it('loadWorkspace (viewer answer): the film and filling order codes read; lines, links and documents stay hidden', async () => {
    session.user = { id: 'u-viewer', role: 'viewer' };
    serveViewer();
    const workspace = await realData.loadWorkspace(PROJECT_ID);
    expect(workspace.filmOrders[0]).toMatchObject({ code: 'FSO-H10-1', status: 'ARTWORK_RECEIVED', statusHidden: false, detailsHidden: true, paymentTerms: 'prepaid' });
    expect(workspace.fillingOrders[0]).toMatchObject({ code: 'FIL-H10-1', detailsHidden: true });
    expect(workspace.documents[0]).toMatchObject({ filename: redaction.HIDDEN_BY_ROLE_LABEL, detailsHidden: true });
    const html = render(<ProjectOrderList workspace={workspace} projectCode="PRJ-H10" loadFailed={false} />);
    expect(html).toContain('FSO-H10-1');
    expect(html).toContain('デザイン受領');
    expect(html).not.toContain(redaction.HIDDEN_BY_ROLE_LABEL + '</span><span class="p1-order-row-state"');
    for (const secret of ['98765', '社内メモH10', 'quote_', 'MPO-H10', 'DOC-H10']) expect(JSON.stringify(workspace), secret).not.toContain(secret);
  });

  it('isFieldHiddenByRole: an order row\'s viewer answer is told apart from a staff answer by its keys', () => {
    const viewerOrder = { entityType: 'film_supply_order', afterState: { code: 'FSO-1', status: 'DRAFT', paymentTerms: 'prepaid' } };
    expect(redaction.isFieldHiddenByRole(viewerOrder, 'lineCount')).toBe(true);
    expect(redaction.isFieldHiddenByRole(viewerOrder, 'sevenPurchaseOrderId')).toBe(true);
    expect(redaction.isFieldHiddenByRole(viewerOrder, 'code')).toBe(false);
    expect(redaction.isFieldHiddenByRole({ entityType: 'filling_order', afterState: { code: 'FIL-1' } }, 'lineCount')).toBe(true);
    // On any other row a `code` beside the status is not a viewer answer (the viewer never reads it there).
    const projectRow = { entityType: 'project', afterState: { code: 'PRJ-1', status: 'DRAFT' } };
    expect(redaction.isFieldHiddenByRole(projectRow, 'lineCount')).toBe(false);
    expect(redaction.isFieldHiddenByRole({ afterState: { code: 'PRJ-1', status: 'DRAFT' } }, 'lineCount')).toBe(false);
    // The staff answer of an order row carries lineCount: unchanged.
    expect(redaction.isFieldHiddenByRole({ entityType: 'film_supply_order', afterState: { id: 'f', code: 'FSO-1', status: 'DRAFT', lineCount: 1 } }, 'lineCount')).toBe(false);
  });

  it('the web mirror of the order rows is the API\'s own list', () => {
    const source = readFileSync(path.join(root, 'apps/api/src/audit-view.ts'), 'utf8');
    const literal = /const VIEWER_ORDER_CODE_ENTITY_TYPES: readonly string\[\] = \[([^\]]*)\]/.exec(source);
    expect(literal).not.toBeNull();
    const apiTypes = [...literal![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect([...apiTypes].sort()).toEqual([...redaction.VIEWER_ORDER_CODE_ENTITY_TYPES].sort());
    expect(source).toMatch(/const VIEWER_ORDER_STATE_KEYS: readonly string\[\] = \[\.\.\.VIEWER_STATE_KEYS, 'code'\];/);
  });
});
