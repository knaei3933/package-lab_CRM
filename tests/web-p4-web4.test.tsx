import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * p4/web4 (base p4/final 8654760 = p4/web3 + p4/server2 rounds 1-7): the web half of the last server2 contract —
 * (1) the step-6 manual check draws the server's sender facts (§13: fromAddress · senderDomainCheck ·
 * senderVerdict · declarationLine · warnings), the same lines as the approval card; its hard-coded 「照合 ✓ 一致」 is gone,
 * (2) 422 DELIVERY_EVIDENCE_MAKER_PO_BOUND is answered on the screen (ja/ko, the customer's own receipt, key renewed)
 * and every confirmation shows its evidenceKind, (3) the Lows left by the p4/web3 review.
 * One describe per item; each holds tests that fail on the base commit (evidence: demo-eml/p4-web4/evidence/*-base-*.log)
 * and renders the real components (no CSS text is read). Server rules, amounts (staff / viewer / auditor see none), the
 * idempotency semantics and P-7 (Japanese-only screens carry no Hangul) are not touched — the API is mocked and still decides.
 */
const session = vi.hoisted(() => ({
  user: null as { id: string; role: string; displayName?: string | null } | null,
  projects: [] as Array<{ id: string; code: string; name: string; status: string }>,
  cookies: new Map<string, string>(),
  cookieWrites: [] as Array<{ op: 'set' | 'delete'; name: string; value?: string; options?: Record<string, unknown> }>
}));
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
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
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (session.cookies.has(name) ? { name, value: session.cookies.get(name)! } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      session.cookies.set(name, value);
      session.cookieWrites.push({ op: 'set', name, value, options });
    },
    delete: (name: string) => {
      session.cookies.delete(name);
      session.cookieWrites.push({ op: 'delete', name });
    }
  }),
  headers: async () => ({ get: () => null })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));
const board = vi.hoisted(() => ({ value: null as unknown }));
const workspaceFixture = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../apps/web/src/lib/maker-po-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/maker-po-data.js')>()),
  loadMakerPoBoard: async () => board.value,
  loadMakerPoDetail: async () => ({ purchaseOrder: null, events: [], error: null })
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadWorkspace: async () => workspaceFixture.value,
  loadSelectableProjectList: async () => ({ projects: session.projects, error: null })
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const readSrc = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
/** A module / export this change adds: on the base commit the import is empty and only the tests needing it fail. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optional = (load: () => Promise<any>): Promise<any> => load().catch(() => ({}));

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { StepPanelView } = await import('../apps/web/src/components/StepPanel.js');
const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
const { PendingVerificationSection } = await import('../apps/web/src/components/EvidenceVerificationSection.js');
const { buildOrderFlow } = await import('../apps/web/src/lib/order-flow.js');
const { OrderDetailScreen } = await import('../apps/web/src/screens/OrderDetailScreen.js');
const { IDEMPOTENCY_FIELD, RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');
const stepActions = await import('../apps/web/src/app/step-actions.js');
const actions = await import('../apps/web/src/app/actions.js');
const cardLib = await import('../apps/web/src/lib/approval-card.js');
const closureLib = await optional(() => import('../apps/web/src/lib/receipt-closure.js'));
const noticeLib2 = await optional(() => import('../apps/web/src/lib/receipt-notice.js'));
const senderLib = await import('../apps/web/src/lib/sender-check.js');
const resultLib = await import('../apps/web/src/lib/action-result.js');
/** The real project-data module (the mock above only replaces the workspace read). */
const realData = await vi.importActual<typeof import('../apps/web/src/lib/project-data.js')>('../apps/web/src/lib/project-data.js');

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const SHA = 'a'.repeat(64);
const KEY = '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c02';
const B64 = Buffer.from('%PDF-1.4 test').toString('base64');
const FILE = { contentBase64: B64, filename: 'receipt.pdf', contentType: 'application/pdf' };

const render = (node: ReactNode, showKorean = false) => renderToStaticMarkup(
  <RenderedContextProvider value={{ projectId: 'project-a', showKorean }}>{node}</RenderedContextProvider>
).replaceAll('<!-- -->', '');
const ok = (data: unknown = { id: 'row-1' }, status = 200) => ({ ok: true, status, data, error: null, errorKo: null, code: null, failure: null });
/** An API refusal as lib/api shapes it (the dictionary text is what the form would show without a step's own words). */
const fail = (status: number, code: string, data: Record<string, unknown> = {}) => ({
  ok: false, status, data: { code, ...data }, error: `dictionary text for ${code}`, errorKo: `사전 ${code}`, code, failure: null
});
const outage = (status = 503) => ({ ok: false, status, data: null, error: 'API unreachable', errorKo: null, code: null, failure: 'unreachable' });
function form(entries: Record<string, string | string[]>, key: string | null = KEY): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'project-a');
  if (key) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) for (const one of Array.isArray(value) ? value : [value]) data.append(name, one);
  return data;
}
const submitLabels = (html: string) => [...html.matchAll(/<button type="submit"[^>]*>([\s\S]*?)<\/button>/g)]
  .map((match) => match[1]!.replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim());
const visibleText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const PO = { id: 'po-1', poNumber: 'SC-1', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };
function order(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'order-1', code: 'FSO-1', status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: 'line-1', lineNumber: 1, description: '合成フィルム', orderedQuantity: '500', unit: 'meters' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: 'MAKER_PO_READY', paymentTerms: 'prepaid', paymentTermsHidden: false,
    hold: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra
  };
}
const slot = (valid: boolean, pending = false) => ({
  organization: 'customer', valid, latestDecision: valid ? 'APPROVE' : null, revoked: false, invalidatedByNewerRevision: false,
  pendingEvidenceIdentifier: pending, manualVerification: null
});
/** The step panel of one order state, built the way the order screen builds it. */
function panel(status: string, role: string, extra: { gate?: unknown; documents?: unknown[]; deliveryContext?: unknown; showKorean?: boolean } = {}) {
  const o = order(status);
  const flow = buildOrderFlow({
    order: o as never, role, po: PO as never, documents: (extra.documents ?? []) as never, revisions: [], gate: (extra.gate ?? null) as never,
    makerPos: [], makerEvents: [], settledSendEventIds: new Set(), paymentGate: null, deliveries: []
  });
  return render(
    <StepPanelView
      flow={flow} order={o as never} projectCode="PRJ-1" role={role} po={PO as never} gate={(extra.gate ?? null) as never}
      maker={null} makerEvents={[]} documents={(extra.documents ?? []) as never} stateLabel={(key) => key}
      deliveryContext={extra.deliveryContext as never}
    />,
    extra.showKorean ?? false
  );
}

beforeEach(() => {
  session.user = { id: 'u-admin', role: 'admin', displayName: '代表' };
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
  revalidatePath.mockReset();
  board.value = null;
  workspaceFixture.value = null;
  session.projects = [];
  session.cookies = new Map();
  session.cookieWrites = [];
});

// =============================================================================================
// (1) the step-6 manual check draws the server's sender facts (server2 §13) — not a hard-coded 「照合 ✓ 一致」
// =============================================================================================
const line = (code: string, tone: string, label: string) => ({ code, tone, label });
/** One pending manual verification as GET …/approval-gate answers it (server2 §13-2), before the web reads it. */
function rawPending(over: Record<string, unknown> = {}) {
  return {
    approvalEventId: 'ev-1', revisionId: 'rev-1', designKey: '表面A', revisionNo: 1, organization: 'customer',
    evidenceDocumentVersionId: 'ver-9', evidenceIdentifier: 'REV-NOMID-005', approvedFileSha256: 'ab'.repeat(32),
    eventTime: '2026-11-20T00:00:00Z', recordedAt: '2026-11-20T00:00:10Z', manualVerification: null,
    evidenceIssuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated', issuerMatchesOrganization: true,
    sharedEvidenceException: null, confirmable: true, sameContentUsedByOtherOrganization: false, recordedAsPending: true,
    ...over
  };
}
const FOREIGN = {
  fromAddress: 'boss@evil-w3.example',
  senderDomainCheck: { status: 'mismatch', fromAddress: 'boss@evil-w3.example', fromDomain: 'evil-w3.example', registeredDomain: 'customer-w3.example' },
  senderVerdict: line('mismatch', 'warning', '差出人のドメインが登録先と一致しません'),
  declarationLine: line('sender_domain_mismatch', 'warning', '申告は承認組織と一致・差出人のドメインは不一致'),
  warnings: [{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: 'x', fromDomain: 'evil-w3.example', registeredDomain: 'customer-w3.example' }]
};
const MATCHING = {
  fromAddress: 'po@customer-w3.example',
  senderDomainCheck: { status: 'match', fromAddress: 'po@customer-w3.example', fromDomain: 'customer-w3.example', registeredDomain: 'customer-w3.example' },
  senderVerdict: line('match', 'ok', '差出人のドメインが登録先と一致'),
  declarationLine: line('declared_and_sender_match', 'ok', '申告どおり（差出人のドメインも一致）'),
  warnings: []
};
const UNVERIFIABLE = {
  fromAddress: 'boss@customer-w3.example',
  senderDomainCheck: { status: 'multiple_from', fromAddress: 'boss@customer-w3.example', fromDomain: null, registeredDomain: 'customer-w3.example' },
  senderVerdict: line('unverifiable', 'warning', '差出人を確認できません（差出人がない・複数ある・読めない文字のドメイン）'),
  declarationLine: line('sender_unverifiable', 'warning', '申告は承認組織と一致・差出人を確認できません'),
  warnings: [{ code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: 'y', fromDomain: null, registeredDomain: 'customer-w3.example' }]
};
const NOT_COMPARED = {
  fromAddress: null,
  senderDomainCheck: { status: 'no_registered_domain', fromAddress: 'boss@somewhere.example', fromDomain: 'somewhere.example', registeredDomain: null },
  senderVerdict: line('no_registered_domain', 'neutral', '取引先のメールアドレスが未登録のため、差出人は照合していません'),
  declarationLine: line('declared_only', 'neutral', '申告は承認組織と一致（差出人は照合していません）'),
  warnings: []
};
const gateWith = (pending: unknown[]) => ({
  orderId: 'order-1', orderStatus: 'APPROVAL_PENDING', dualApproved: false, missingApprovals: [],
  designs: [{ designKey: '表面A', currentRevisionId: 'rev-1', currentRevisionNo: 1, fileSha256: 'ab'.repeat(32), customer: slot(false, true), seven: slot(true), dualApproved: false }],
  pendingManualVerifications: pending
});
/** The raw gate answer → the web's own read (the real loadApprovalGate) → the real step-6 panel. */
async function step6(rawPendings: unknown[], role = 'admin', showKorean = false) {
  callApi.mockImplementation(async (url: string) => url.endsWith('/approval-gate') ? ok(gateWith(rawPendings)) : ok());
  const gate = await realData.loadApprovalGate('order-1');
  expect(gate).not.toBeNull();
  session.user = { id: `u-${role}`, role };
  return panel('APPROVAL_PENDING', role, {
    gate, showKorean,
    documents: [{ id: 'doc-9', documentType: 'approval_evidence', filename: 'approval-nomid.eml', verificationStatus: 'unverified', versions: [{ id: 'ver-9', versionNumber: 1 }] }]
  });
}
/** The 「照合」 row of the manual check as drawn. */
const reconciliation = (html: string) => /<dt>照合<\/dt><dd[^>]*>[\s\S]*?<\/dd>/.exec(html)?.[0] ?? '';
const declarationMarkup = (html: string) => /<span class="p4w3-line[^"]*"[^>]*data-declaration="[^"]*">(?:<span aria-hidden="true">[^<]*<\/span>)?[^<]*<\/span>/.exec(html)?.[0] ?? '';

describe('(1) 6 校了: the representative\'s manual check shows what the server decided about the mail\'s sender', () => {
  it('a foreign-domain mail: 「照合」 is the server\'s warning line — never 「一致」 / 「申告どおり」 — with the From address, the verdict and the warning', async () => {
    const html = await step6([rawPending(FOREIGN)]);
    const row = reconciliation(html);
    expect(row).toContain('data-reconciliation="sender_domain_mismatch"');
    expect(row).toContain('data-tone="warning"');
    expect(row).toContain('申告は承認組織と一致・差出人のドメインは不一致');
    expect(html).not.toContain('申告どおり');
    expect(html).not.toMatch(/<dt>照合<\/dt><dd[^>]*>(?:(?!<\/dd>)[\s\S])*?>一致</);
    expect(html).toContain('<dt>差出人</dt>');
    expect(html).toContain('差出人 <span translate="no">boss@evil-w3.example</span>');
    expect(html).toContain('data-sender="mismatch"');
    expect(html).toContain('data-warning="EVIDENCE_SENDER_DOMAIN_MISMATCH"');
    // The form that records the check is still there: the server only warns (the representative decides).
    expect(submitLabels(html)).toContain('手動確認を記録する');
    expect(html).toContain('issuer-check--warning');
  });

  it('a mail from the registered domain: 「申告どおり（差出人のドメインも一致）」 with ✓, no warning', async () => {
    const html = await step6([rawPending(MATCHING)]);
    expect(reconciliation(html)).toMatch(/<span aria-hidden="true">✓ <\/span>申告どおり（差出人のドメインも一致）/);
    expect(reconciliation(html)).toContain('data-tone="ok"');
    expect(html).toContain('data-sender="match"');
    expect(html).not.toContain('data-warning');
    expect(html).not.toContain('issuer-check--warning');
  });

  it('an unreadable sender (several From lines): a warning, from the first address', async () => {
    const html = await step6([rawPending(UNVERIFIABLE)]);
    expect(reconciliation(html)).toContain('申告は承認組織と一致・差出人を確認できません');
    expect(html).toContain('差出人（1件目） <span translate="no">boss@customer-w3.example</span>');
    expect(html).toContain('data-warning="EVIDENCE_SENDER_UNVERIFIABLE"');
    expect(html).not.toContain('申告どおり');
  });

  it('a sender that was not compared says so in the neutral tone (no ✓, no warning)', async () => {
    const html = await step6([rawPending(NOT_COMPARED)]);
    expect(reconciliation(html)).toContain('申告は承認組織と一致（差出人は照合していません）');
    expect(reconciliation(html)).toContain('data-tone="neutral"');
    expect(html).not.toContain('申告どおり');
    expect(html).not.toContain('✓ ');
  });

  it('an older API (no sender facts): the declared match reads 「差出人は照合していません」 — the badge 「一致」 is gone', async () => {
    const html = await step6([rawPending()]);
    expect(reconciliation(html)).toContain('data-reconciliation="declared_only"');
    expect(reconciliation(html)).toContain('申告は承認組織と一致（差出人は照合していません）');
    expect(html).not.toContain('申告どおり');
    expect(html).not.toMatch(/>一致</);
    expect(html).not.toContain('<dt>差出人</dt>');
  });

  it('the declared issuer is not the approving organization: 「不一致」 and the required issuer stay (the API refuses 「確認」)', async () => {
    const html = await step6([rawPending({ issuerMatchesOrganization: false, confirmable: false, evidenceIssuerEntity: 'maker', ...FOREIGN, declarationLine: line('issuer_differs', 'warning', '申告された発行元が承認組織と異なります') })]);
    expect(reconciliation(html)).toContain('不一致');
    expect(reconciliation(html)).toContain('必要な発行元');
    expect(html).not.toContain('申告どおり');
    expect(html).toContain('「確認」は記録できません');
  });

  it('the same input is drawn with the same words and tones as the approval card (one component, one wording)', () => {
    for (const facts of [FOREIGN, MATCHING, UNVERIFIABLE, NOT_COMPARED]) {
      const manual = render(<PendingVerificationSection pending={[toView(rawPending(facts))] as never} role="admin" canVerify evidenceLabel={() => 'x'} organizationText={() => '顧客'} />);
      const cardView = cardLib.cardFromServer('po-1', {
        makerPurchaseOrder: { id: 'po-1', status: 'DRAFT', displayNumber: 'MPO-1', approvalSnapshotSha256: SHA },
        order: { id: 'order-1', code: 'FSO-1', paymentTerms: 'prepaid' },
        snapshot: { amounts: { currency: 'JPY', totalAmount: '1', display: '¥1' }, items: [], artworkFiles: [], recipient: { address: 'a@b.example', isEmail: true } },
        approvals: { dualApproved: false, designs: [{ designKey: '表面A', currentRevisionNo: 1, organizations: { customer: { state: 'pending_manual_verification', approvalEventId: 'ev-1', evidence: { issuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated', issuerMatchesOrganization: true, evidenceSource: 'email', documentVersionId: 'ver-9', ...facts }, eventTime: null }, seven: { state: 'missing' } } }] },
        sevenPurchaseOrder: null, blockers: [], warnings: [], canApprove: false, canReturn: true
      })!;
      const card = render(<ApprovalCard card={cardView} korean={false} />);
      expect(declarationMarkup(manual)).not.toBe('');
      expect(declarationMarkup(manual)).toBe(declarationMarkup(card));
      expect(/<span class="p4w3-line[^"]*"[^>]*data-sender="[^"]*">[\s\S]*?<\/span>(?:<\/span>)?/.exec(manual)?.[0] ?? null)
        .toBe(/<span class="p4w3-line[^"]*"[^>]*data-sender="[^"]*">[\s\S]*?<\/span>(?:<\/span>)?/.exec(card)?.[0] ?? null);
    }
  });

  it('the web reads the gate\'s sender facts exactly as answered (loadApprovalGate), and keeps nothing else', async () => {
    callApi.mockResolvedValue(ok(gateWith([rawPending(FOREIGN)])));
    const gate = await realData.loadApprovalGate('order-1');
    expect(gate!.pendingManualVerifications[0]).toMatchObject({
      fromAddress: 'boss@evil-w3.example', senderStatus: 'mismatch',
      senderVerdict: { code: 'mismatch', tone: 'warning' },
      declarationLine: { code: 'sender_domain_mismatch', tone: 'warning', label: '申告は承認組織と一致・差出人のドメインは不一致' }
    });
    expect(gate!.pendingManualVerifications[0]!.warnings!.map((warning: { code: string }) => warning.code)).toEqual(['EVIDENCE_SENDER_DOMAIN_MISMATCH']);
  });

  it('「申告どおり」 is drawn only for the server\'s own match code: an ok-toned line under another code is dropped (older API fallback)', async () => {
    expect(senderLib.evidenceLineFrom({ code: 'sender_domain_mismatch', tone: 'ok', label: '申告どおり（差出人のドメインも一致）' })).toBeNull();
    expect(senderLib.evidenceLineFrom({ code: 'declared_and_sender_match', tone: 'ok', label: '申告どおり（差出人のドメインも一致）' })).toMatchObject({ tone: 'ok' });
    // The contradicting line never reaches the screen: the form falls back to what the declaration alone says.
    const html = await step6([rawPending({ ...FOREIGN, declarationLine: line('sender_domain_mismatch', 'ok', '申告どおり（差出人のドメインも一致）') })]);
    expect(html).not.toContain('申告どおり');
    expect(reconciliation(html)).toContain('申告は承認組織と一致（差出人は照合していません）');
  });

  it('a server label is printed as text (markup and control characters never pass)', async () => {
    const html = await step6([rawPending({ ...FOREIGN, declarationLine: line('sender_domain_mismatch', 'warning', '<img src=x onerror=alert(1)>\u0007'), fromAddress: '"><script>x</script>@evil.example' })]);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('\u0007');
  });

  it('P-7: Japanese-only screens carry no Hangul; the bilingual screen adds the Korean line of the warning', async () => {
    for (const facts of [FOREIGN, MATCHING, UNVERIFIABLE, NOT_COMPARED, {}]) expect(await step6([rawPending(facts)])).not.toMatch(HANGUL);
    expect(await step6([rawPending(FOREIGN)], 'admin', true)).toContain('lang="ko"');
  });

  it('the staff / viewer / auditor never get the check form (the gate answers them no pending list) and see no amount', async () => {
    for (const role of ['staff', 'viewer', 'auditor']) {
      const html = await step6([], role);
      expect(html, role).not.toContain('手動確認を記録する');
      expect(html, role).not.toMatch(/[¥￥]\s?\d/);
    }
  });
});
/** The web's view of one raw pending item (the real loader's mapping, without a network). */
function toView(raw: Record<string, unknown>) {
  return {
    approvalEventId: raw.approvalEventId, revisionId: 'rev-1', designKey: '表面A', revisionNo: 1, organization: 'customer',
    evidenceDocumentVersionId: 'ver-9', evidenceIdentifier: 'REV-NOMID-005', approvedFileSha256: 'ab'.repeat(32),
    eventTime: '2026-11-20T00:00:00Z', recordedAt: '2026-11-20T00:00:10Z', manualVerification: null,
    evidenceIssuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated', issuerMatchesOrganization: true,
    sharedEvidenceException: null, confirmable: true, sameContentUsedByOtherOrganization: false, recordedAsPending: true,
    fromAddress: raw.fromAddress ?? null,
    senderStatus: senderLib.senderStatusOf(raw.senderDomainCheck),
    senderVerdict: senderLib.evidenceLineFrom(raw.senderVerdict),
    declarationLine: senderLib.evidenceLineFrom(raw.declarationLine),
    warnings: senderLib.senderWarningsOf(raw.warnings)
  };
}

// =============================================================================================
// (2) 納品の確認: DELIVERY_EVIDENCE_MAKER_PO_BOUND is answered on the screen, and every confirmation says what it rests on
// =============================================================================================
const delivery = (id: string, confirmed = false, over: Record<string, unknown> = {}) => ({
  id, kind: 'film', orderId: 'order-1', lineId: 'line-1', unit: 'meters', deliveredQuantity: '500', deliverySequence: 1, deliveredAt: '2026-11-22T01:00:00Z',
  recordedAt: '2026-11-22T01:00:00Z', note: null, confirmed, evidenceDocumentVersionId: null, confirmedAt: null, detailsHidden: false, confirmationHidden: false, ...over
});
const receiptDoc = (uploadedBy: string, verificationStatus = 'unverified') => ({
  id: 'doc-r', documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filename: 'jyuryo.pdf', note: null, verificationStatus, verificationNote: null,
  sevenPurchaseOrderId: null, filmSupplyOrderId: 'order-1', designKey: null, makerPurchaseOrderId: null, uploadedByUserId: uploadedBy,
  detailsHidden: false, typeHidden: false, verificationHidden: false, createdAt: '2026-11-22T02:00:00Z', updatedAt: '2026-11-22T02:00:00Z',
  versions: [{ id: 'ver-r', documentId: 'doc-r', versionNumber: 1, sha256: null, sha256Hidden: true, originalFilename: 'jyuryo.pdf', createdAt: '2026-11-22T02:00:00Z', uploadedByUserId: uploadedBy }]
});
const context = (userId: string, deliveries: unknown[] = [delivery('del-1')], over: Record<string, unknown> = {}) => ({
  deliveries, userId, filmOnly: true, readiness: null, readinessLabel: (key: string) => key, ...over
});
const BOUND = 'DELIVERY_EVIDENCE_MAKER_PO_BOUND';

describe('(2a) 422 DELIVERY_EVIDENCE_MAKER_PO_BOUND: the screen says why and where the customer\'s own receipt goes (ja / ko)', () => {
  const confirmForm = (over: Record<string, string | string[]> = {}) => form({
    orderId: 'order-1', orderCode: 'FSO-1', projectCode: 'PRJ-1', receiptMode: 'confirm', evaluateReadiness: 'false', deliveryId: 'del-1',
    evidenceDocumentId: 'doc-r', evidenceDocumentVersionId: 'ver-r', evidenceVerified: 'true', ...over
  });

  it('the order screen\'s refusal is the step\'s own words, not the dictionary line: Japanese, Korean, the way forward, a link to the form', async () => {
    callApi.mockResolvedValue(fail(422, BOUND));
    const result = await stepActions.confirmDeliveryReceiptStepAction(null, confirmForm());
    expect(result).toMatchObject({ ok: false, code: BOUND, settled: true });
    expect(result.message).toContain('メーカー発注書の受領書');
    expect(result.message).toContain('お客様から受け取った納品受領の証跡（受領書・受領メール）を登録してください');
    expect(result.message).not.toContain('dictionary text');
    expect(result.messageKo).toContain('고객');
    expect(result.messageKo).toContain('수령 증빙');
    expect(result.link).toEqual({ href: '#receipt-alternative', label: 'お客様の受領証跡を登録する' });
    // The page it points at has that anchor (see (2b)); the API was asked once (nothing else was written).
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0]![0]).toBe('/api/film-deliveries/del-1/confirmation');
  });

  it('the key is renewed (an answered 4xx) — also when the evidence was checked first in the same submit (a stored write before the refusal)', async () => {
    callApi.mockImplementation(async (url: string) => url.endsWith('/verify') ? ok({ id: 'doc-r' }) : fail(422, BOUND));
    const result = await stepActions.confirmDeliveryReceiptStepAction(null, confirmForm({ evidenceVerified: 'false' }));
    expect(callApi.mock.calls.map((call) => String(call[0]))).toEqual(['/api/documents/doc-r/verify', '/api/film-deliveries/del-1/confirmation']);
    expect(result).toMatchObject({ ok: false, code: BOUND, settled: true });
    expect(result.message.startsWith('「納品1の確認」で止まりました（その前の手順は記録済みです）。')).toBe(true);
    expect(result.message).toContain('お客様から受け取った納品受領の証跡');
  });

  it('a registered-then-refused upload (the representative uploaded a copy of the maker\'s 受領書): the key is renewed so another file can be sent', async () => {
    callApi.mockImplementation(async (url: string) => {
      if (/\/documents$/.test(url)) return ok({ document: { id: 'doc-new' }, version: { id: 'ver-new' } }, 201);
      if (/\/verify$/.test(url)) return ok({ id: 'doc-new' });
      return fail(422, BOUND);
    });
    const result = await stepActions.confirmDeliveryReceiptStepAction(null, form({
      orderId: 'order-1', orderCode: 'FSO-1', projectCode: 'PRJ-1', receiptMode: 'confirm', evaluateReadiness: 'false', deliveryId: 'del-1',
      receiptIssuer: 'customer_generated', ...FILE
    }));
    expect(callApi.mock.calls.map((call) => String(call[0]))).toEqual(['/api/projects/project-a/documents', '/api/documents/doc-new/verify', '/api/film-deliveries/del-1/confirmation']);
    expect(result).toMatchObject({ ok: false, code: BOUND, settled: true });
  });

  it('every other partly stored chain is still NOT settled (the same key replays what was stored): another 422, a 5xx, an outage', async () => {
    for (const refusal of [fail(422, 'DELIVERY_EVIDENCE_NOT_VERIFIED'), fail(409, 'DELIVERY_ALREADY_CONFIRMED'), outage(503), fail(500, 'INTERNAL_ERROR')]) {
      callApi.mockReset();
      callApi.mockImplementation(async (url: string) => url.endsWith('/verify') ? ok({ id: 'doc-r' }) : refusal);
      const result = await stepActions.confirmDeliveryReceiptStepAction(null, confirmForm({ evidenceVerified: 'false' }));
      expect(result.ok, String(refusal.code)).toBe(false);
      expect(result.settled, String(refusal.code)).toBe(false);
    }
  });

  it('a refusal of the FIRST write follows the usual rule (an answered 4xx renews the key, an outage keeps it)', async () => {
    callApi.mockResolvedValue(fail(422, 'DELIVERY_EVIDENCE_NOT_VERIFIED'));
    expect((await stepActions.confirmDeliveryReceiptStepAction(null, confirmForm())).settled).toBe(true);
    callApi.mockResolvedValue(outage(503));
    expect((await stepActions.confirmDeliveryReceiptStepAction(null, confirmForm())).settled).toBe(false);
  });

  it('the key rule is one list: only this code ends a partly stored chain', () => {
    expect(resultLib.RENEWS_KEY_AFTER_PARTIAL_CODES ?? []).toEqual([BOUND]);
  });

  it('the old filling list (it keeps the confirm form) answers the same refusal in its own words — the 文書 screen, no dead link', async () => {
    callApi.mockResolvedValue(fail(422, BOUND));
    const result = await actions.confirmDeliveryAction(null, form({ kind: 'filling', deliveryId: 'fill-del-1', evidenceDocumentVersionId: 'ver-r' }));
    expect(result).toMatchObject({ ok: false, code: BOUND, settled: true });
    expect(result.message).toContain('文書の画面で、お客様から受け取った納品受領の証跡');
    expect(result.message).not.toContain('下の');
    expect(result.messageKo).toContain('문서 화면');
    expect(result.link ?? null).toBeNull();
    expect(callApi.mock.calls[0]![0]).toBe('/api/filling-deliveries/fill-del-1/confirmation');
  });

  it('the refusal text carries no amount and the Japanese message no Hangul', async () => {
    callApi.mockResolvedValue(fail(422, BOUND));
    const result = await stepActions.confirmDeliveryReceiptStepAction(null, confirmForm());
    expect(result.message).not.toMatch(HANGUL);
    expect(result.message).not.toMatch(/[¥￥]\s?\d/);
  });
});

describe('(2b) the order screen offers the customer\'s own receipt as the way out (the refusal\'s link opens it)', () => {
  const alt = (html: string) => /<details class="p4w4-alt" id="receipt-alternative"[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';

  it('the representative with a registered receipt: the main form cites it, and below it the 「お客様の受領証跡を登録して確認する」 block takes a new file', () => {
    const html = panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin'), documents: [receiptDoc('u-admin')] });
    const block = alt(html);
    expect(block).not.toBe('');
    expect(block).toContain('お客様の受領証跡を登録して確認する');
    expect(block).toContain('name="receiptMode" value="confirm"');
    expect(block).toContain('name="deliveryId" value="del-1"');
    expect(block).toMatch(/<select[^>]*name="receiptIssuer"[^>]*required/);
    expect(block).toMatch(/<option value="customer_generated" selected="">顧客（受領書・受領メール）<\/option>/);
    // It cites no existing evidence (the new file is the evidence) and asks before the irreversible confirmation.
    expect(block).not.toContain('name="evidenceDocumentId"');
    expect(block).not.toContain('name="evidenceDocumentVersionId"');
    expect(block).toContain('納品を確認済みにしますか？');
    expect(submitLabels(block)).toEqual(['お客様の受領証跡を登録して納品を確認する']);
    // The main form is unchanged.
    expect(submitLabels(html)).toContain('受領証跡で納品を確認する');
    expect(html).toContain('name="evidenceDocumentVersionId" value="ver-r"');
  });

  it('staff cite a receipt somebody else registered: the block registers the customer\'s own receipt only (P-4: the confirmation is the representative\'s)', () => {
    const html = panel('FILM_DELIVERED', 'staff', { deliveryContext: context('u-staff'), documents: [receiptDoc('u-other', 'verified')] });
    const block = alt(html);
    expect(block).toContain('name="receiptMode" value="register"');
    expect(submitLabels(block)).toEqual(['お客様の受領証跡を登録する（確認は代表）']);
    expect(block).not.toContain('納品を確認済みにしますか？');
  });

  it('no block where the main form already takes a new file (nothing registered yet) or has nothing to cite (staff\'s own, waiting)', () => {
    expect(alt(panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin') }))).toBe('');
    expect(alt(panel('FILM_DELIVERED', 'staff', { deliveryContext: context('u-staff') }))).toBe('');
    expect(alt(panel('FILM_DELIVERED', 'staff', { deliveryContext: context('u-staff'), documents: [receiptDoc('u-staff')] }))).toBe('');
    // Nothing left to confirm: no block either.
    expect(alt(panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin', [delivery('del-1', true)]), documents: [receiptDoc('u-admin')] }))).toBe('');
  });

  it('the block is not offered to a role that cannot confirm (viewer / auditor), and Japanese screens carry no Hangul', () => {
    for (const role of ['viewer', 'auditor']) expect(alt(panel('FILM_DELIVERED', role, { deliveryContext: context(`u-${role}`), documents: [receiptDoc('u-other', 'verified')] })), role).toBe('');
    expect(panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin'), documents: [receiptDoc('u-admin')] })).not.toMatch(HANGUL);
  });

  it('submitting it uploads the customer\'s receipt and confirms on THAT version (the existing evidence is not cited)', async () => {
    callApi.mockImplementation(async (url: string) => {
      if (/\/documents$/.test(url)) return ok({ document: { id: 'doc-new' }, version: { id: 'ver-new' } }, 201);
      return ok({ id: 'x' });
    });
    const result = await stepActions.confirmDeliveryReceiptStepAction(null, form({
      orderId: 'order-1', orderCode: 'FSO-1', projectCode: 'PRJ-1', receiptMode: 'confirm', evaluateReadiness: 'false', deliveryId: 'del-1', receiptIssuer: 'customer_generated', ...FILE
    }));
    expect(result.ok).toBe(true);
    const calls = callApi.mock.calls.map((call) => [String(call[0]), (call[1] as { body?: Record<string, unknown> }).body]);
    expect(calls[0]![0]).toBe('/api/projects/project-a/documents');
    expect(calls[0]![1]).toMatchObject({ documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', filmSupplyOrderId: 'order-1' });
    expect(calls.at(-1)).toEqual(['/api/film-deliveries/del-1/confirmation', { evidenceDocumentVersionId: 'ver-new' }]);
  });
});

describe('(2c) every confirmation says what it rests on (delivery-status evidenceKind)', () => {
  const kinds = { 'del-1': 'customer_receipt', 'del-2': 'maker_po_acceptance' };
  const deliveries = [delivery('del-1', true), delivery('del-2', true), delivery('del-3', false), delivery('del-4', true, { confirmationHidden: true })];
  const html = () => panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin', deliveries, { evidenceKinds: { ...kinds, 'del-3': 'customer_receipt', 'del-4': 'customer_receipt' } }) });
  const item = (markup: string, id: string) => new RegExp(`<li data-delivery-id="${id}">[\\s\\S]*?</li>`).exec(markup)?.[0] ?? '';

  it('evidenceKindsFrom reads the kind per delivery id from the lines, ignores an unknown value and an older answer', () => {
    expect(closureLib.evidenceKindsFrom?.({
      lines: [{ deliveries: [{ id: 'd1', confirmation: { evidenceKind: 'customer_receipt' } }, { id: 'd2', confirmation: { evidenceKind: 'maker_po_acceptance' } }, { id: 'd3', confirmation: null }] },
        { deliveries: [{ id: 'd4', confirmation: { evidenceKind: 'something_new' } }, { id: 'd5', confirmation: {} }] }]
    })).toEqual({ d1: 'customer_receipt', d2: 'maker_po_acceptance' });
    expect(closureLib.evidenceKindsFrom?.({ status: 'FILM_DELIVERED' })).toEqual({});
    expect(closureLib.evidenceKindsFrom?.(null)).toEqual({});
  });

  it('a customer receipt reads 「受領証跡: お客様の受領書で確認」; the legacy maker 受領書 is a warning that it is not the completion\'s basis', () => {
    const markup = html();
    expect(item(markup, 'del-1')).toContain('data-evidence-kind="customer_receipt"');
    expect(item(markup, 'del-1')).toContain('受領証跡: お客様の受領書で確認');
    expect(item(markup, 'del-1')).not.toContain('⚠');
    expect(item(markup, 'del-2')).toContain('data-evidence-kind="maker_po_acceptance"');
    expect(item(markup, 'del-2')).toContain('p4w4-kind--legacy');
    expect(item(markup, 'del-2')).toContain('<span aria-hidden="true">⚠ </span>');
    expect(item(markup, 'del-2')).toContain('メーカー受領書で確認（旧データ）。お客様の受領証跡ではないため、完了の根拠には数えません。');
  });

  it('an unconfirmed delivery and a confirmation the role may not read say nothing about evidence', () => {
    const markup = html();
    expect(item(markup, 'del-3')).not.toContain('data-evidence-kind');
    expect(item(markup, 'del-4')).not.toContain('data-evidence-kind');
    expect(item(markup, 'del-4')).toContain('（確認状態は閲覧権限なし）');
  });

  it('without the kinds (an older API) the line is exactly what it was', () => {
    const markup = panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin', [delivery('del-1', true)]) });
    expect(markup).not.toContain('data-evidence-kind');
    expect(markup).toContain('フィルムの納品確認済み');
  });

  it('when every delivery is confirmed but one rests on the maker\'s 受領書 (legacy), the done line says that one is not the completion\'s basis', () => {
    const rows = [delivery('del-1', true), delivery('del-2', true)];
    const legacy = panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin', rows, { evidenceKinds: { 'del-1': 'customer_receipt', 'del-2': 'maker_po_acceptance' } }) });
    expect(legacy).toContain('フィルムの納品確認済み（数量は確認済み。メーカー受領書で確認した分は、完了の根拠には数えません）');
    expect(legacy).not.toContain('（受領証跡で数量を確認済み）');
    const clean = panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin', rows, { evidenceKinds: { 'del-1': 'customer_receipt', 'del-2': 'customer_receipt' } }) });
    expect(clean).toContain('フィルムの納品確認済み（受領証跡で数量を確認済み）');
  });

  it('Japanese screens carry no Hangul; the bilingual screen adds the Korean line', () => {
    expect(html()).not.toMatch(HANGUL);
    const korean = panel('FILM_DELIVERED', 'admin', { showKorean: true, deliveryContext: context('u-admin', deliveries, { evidenceKinds: kinds }) });
    expect(korean).toContain('고객의 수령서로 확인');
    expect(korean).toContain('메이커 수령서로 확인(옛 데이터)');
  });

  it('the order screen reads delivery-status once (at 納品済み) and draws each kind from it', async () => {
    session.user = { id: 'u-admin', role: 'admin' };
    const o = order('FILM_DELIVERED', { lines: [] });
    workspaceFixture.value = {
      error: null, projectRefused: false, project: { id: 'project-a', code: 'PRJ-1', name: 'A', route: 'F1' }, labels: null, filmOrders: [o], fillingOrders: [],
      sevenPurchaseOrders: [PO], documents: [], revisions: [], approvalEvents: [],
      deliveries: [delivery('del-1', true), delivery('del-2', true)], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
    };
    board.value = { workspace: workspaceFixture.value, boards: [{ order: o, closure: null, makerPurchaseOrders: [], makerPoError: null, paymentGate: null, paymentGateError: null }] };
    callApi.mockImplementation(async (url: string) => {
      if (url.endsWith('/delivery-status')) {
        return ok({ status: 'FILM_SHIPPED', lines: [{ deliveries: [{ id: 'del-1', confirmation: { evidenceKind: 'customer_receipt' } }, { id: 'del-2', confirmation: { evidenceKind: 'maker_po_acceptance' } }] }] });
      }
      return url.endsWith('/order-facts') ? ok({ orderedQuantity: '500', orderedUnit: 'meters', updatedAt: null }) : ok({ events: [] });
    });
    const markup = render(await OrderDetailScreen({ projectId: 'project-a', projectCode: 'PRJ-1', orderCode: 'FSO-1', started: false, step: 12 } as never));
    expect(callApi.mock.calls.filter((call) => String(call[0]).endsWith('/delivery-status'))).toHaveLength(1);
    expect(item(markup, 'del-1')).toContain('data-evidence-kind="customer_receipt"');
    expect(item(markup, 'del-2')).toContain('data-evidence-kind="maker_po_acceptance"');
  });

  it('an order before 納品済み does not read delivery-status (nothing there draws the confirmations)', async () => {
    session.user = { id: 'u-admin', role: 'admin' };
    const o = order('FILM_SHIPPED', { lines: [] });
    workspaceFixture.value = {
      error: null, projectRefused: false, project: { id: 'project-a', code: 'PRJ-1', name: 'A', route: 'F1' }, labels: null, filmOrders: [o], fillingOrders: [],
      sevenPurchaseOrders: [PO], documents: [], revisions: [], approvalEvents: [], deliveries: [delivery('del-1', true)], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
    };
    board.value = { workspace: workspaceFixture.value, boards: [{ order: o, closure: null, makerPurchaseOrders: [], makerPoError: null, paymentGate: null, paymentGateError: null }] };
    callApi.mockImplementation(async (url: string) => url.endsWith('/order-facts') ? ok({ orderedQuantity: '500', orderedUnit: 'meters', updatedAt: null }) : ok({ events: [] }));
    await OrderDetailScreen({ projectId: 'project-a', projectCode: 'PRJ-1', orderCode: 'FSO-1', started: false, step: 12 } as never);
    expect(callApi.mock.calls.filter((call) => String(call[0]).endsWith('/delivery-status'))).toHaveLength(0);
  });
});


describe('(2d) the refusal survives the redraw: a stopped confirmation is said at the top of step 12 (cookie bound to the order)', () => {
  const ORDER_UUID = '0192a000-0000-7000-8000-0000000000a1';
  const OTHER_UUID = '0192a000-0000-7000-8000-0000000000a2';
  const recordForm = (over: Record<string, string | string[]> = {}) => form({
    orderId: ORDER_UUID, orderCode: 'FSO-1', projectCode: 'PRJ-1', lineId: 'line-1', 'unit_line-1': 'meters', 'quantity_line-1': '100',
    receiptIssuer: 'customer_generated', receiptMode: 'confirm', evaluateReadiness: 'false', sevenPurchaseOrderId: 'po-1', ...FILE, ...over
  });
  /** The API as the chain needs it: the delivery, the order's move and the evidence are stored; the confirmation is refused. */
  const refuseAtConfirmation = () => callApi.mockImplementation(async (url: string) => {
    if (/\/deliveries$/.test(url)) return ok({ id: 'del-1' }, 201);
    if (/\/transitions$/.test(url)) return ok({ order: { id: ORDER_UUID, status: 'FILM_DELIVERED' } });
    if (/\/documents$/.test(url)) return ok({ document: { id: 'doc-new' }, version: { id: 'ver-new' } }, 201);
    if (/\/verify$/.test(url)) return ok({ id: 'doc-new' });
    return fail(422, BOUND);
  });
  const noticeCookie = () => session.cookies.get('kanei_receipt_notice');

  it('encode / decode: a valid cookie reads back; a malformed one, another order\'s and an unknown reason are no notice', () => {
    const notice = { orderId: ORDER_UUID, reason: 'maker_po_bound', at: '2026-11-23T05:00:00.000Z' };
    const value = noticeLib2.encodeReceiptNotice?.(notice);
    expect(noticeLib2.decodeReceiptNotice?.(value)).toEqual(notice);
    expect(noticeLib2.decodeReceiptNotice?.(value, ORDER_UUID)).toEqual(notice);
    expect(noticeLib2.decodeReceiptNotice?.(value, OTHER_UUID)).toBeNull();
    for (const bad of [null, '', 'x', `${ORDER_UUID}|something_else|2026-11-23T05:00:00.000Z`, `${ORDER_UUID}|maker_po_bound|yesterday`, `not-a-uuid|maker_po_bound|2026-11-23T05:00:00.000Z`, `${value}|extra`, 'a'.repeat(200)]) {
      expect(noticeLib2.decodeReceiptNotice?.(bad as never), String(bad).slice(0, 30)).toBeNull();
    }
  });

  it('the single-submit 「納品を記録する」 refused at the confirmation: the answer is the guidance AND the reason is kept for the redraw', async () => {
    refuseAtConfirmation();
    const result = await stepActions.recordDeliveryStepAction(null, recordForm());
    expect(result).toMatchObject({ ok: false, code: BOUND, settled: true });
    expect(result.message.startsWith('「納品1の確認」で止まりました（その前の手順は記録済みです）。')).toBe(true);
    expect(noticeLib2.decodeReceiptNotice?.(noticeCookie(), ORDER_UUID)).toMatchObject({ orderId: ORDER_UUID, reason: 'maker_po_bound' });
    const write = session.cookieWrites.find((entry) => entry.name === 'kanei_receipt_notice');
    expect(write?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 });
    // Display only: no hash, no amount, no rule in the cookie.
    expect(noticeCookie()!.split('|')).toEqual([ORDER_UUID, 'maker_po_bound', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)]);
  });

  it('a refusal AFTER a stored write (the evidence was checked first) keeps the reason; a refusal of the first write does not (its own line stays on the mounted form); any other refusal keeps none', async () => {
    const existing = (verified: string) => form({ orderId: ORDER_UUID, orderCode: 'FSO-1', projectCode: 'PRJ-1', receiptMode: 'confirm', evaluateReadiness: 'false', deliveryId: 'del-1', evidenceDocumentId: 'doc-r', evidenceDocumentVersionId: 'ver-r', evidenceVerified: verified });
    callApi.mockImplementation(async (url: string) => url.endsWith('/verify') ? ok({ id: 'doc-r' }) : fail(422, BOUND));
    const stored = await stepActions.confirmDeliveryReceiptStepAction(null, existing('false'));
    expect(stored.chainStored).toBe(true);
    expect(noticeLib2.decodeReceiptNotice?.(noticeCookie(), ORDER_UUID)?.reason).toBe('maker_po_bound');
    session.cookies.clear();
    callApi.mockReset();
    callApi.mockResolvedValue(fail(422, BOUND));
    const first = await stepActions.confirmDeliveryReceiptStepAction(null, existing('true'));
    expect(first).toMatchObject({ ok: false, code: BOUND, settled: true });
    expect(first.chainStored).toBeUndefined();
    expect(noticeCookie()).toBeUndefined();
    callApi.mockResolvedValue(fail(422, 'DELIVERY_EVIDENCE_NOT_VERIFIED'));
    await stepActions.confirmDeliveryReceiptStepAction(null, existing('false'));
    expect(noticeCookie()).toBeUndefined();
  });

  it('a success on ANOTHER order leaves this order\'s notice alone (one slot, bound to its order)', async () => {
    session.cookies.set('kanei_receipt_notice', `${ORDER_UUID}|maker_po_bound|2026-11-23T05:00:00.000Z`);
    callApi.mockImplementation(async (url: string) => /\/documents$/.test(url) ? ok({ document: { id: 'doc-ok' }, version: { id: 'ver-ok' } }, 201) : ok({ id: 'x' }));
    const other = await stepActions.confirmDeliveryReceiptStepAction(null, form({ orderId: OTHER_UUID, orderCode: 'FSO-2', projectCode: 'PRJ-1', receiptMode: 'confirm', evaluateReadiness: 'false', deliveryId: 'del-9', receiptIssuer: 'customer_generated', ...FILE }));
    expect(other.ok).toBe(true);
    expect(noticeCookie()).toBe(`${ORDER_UUID}|maker_po_bound|2026-11-23T05:00:00.000Z`);
  });

  it('a later submit that goes through (the customer\'s own receipt) ends the notice', async () => {
    refuseAtConfirmation();
    await stepActions.recordDeliveryStepAction(null, recordForm());
    expect(noticeCookie()).toBeDefined();
    callApi.mockReset();
    callApi.mockImplementation(async (url: string) => /\/documents$/.test(url) ? ok({ document: { id: 'doc-ok' }, version: { id: 'ver-ok' } }, 201) : ok({ id: 'x' }));
    const result = await stepActions.confirmDeliveryReceiptStepAction(null, form({ orderId: ORDER_UUID, orderCode: 'FSO-1', projectCode: 'PRJ-1', receiptMode: 'confirm', evaluateReadiness: 'false', deliveryId: 'del-1', receiptIssuer: 'customer_generated', ...FILE }));
    expect(result.ok).toBe(true);
    expect(noticeCookie()).toBeUndefined();
  });

  const stepWith = (notice: unknown, deliveries: unknown[] = [delivery('del-1')], showKorean = false, role = 'admin') => panel('FILM_DELIVERED', role, {
    showKorean, documents: [receiptDoc('u-admin')], deliveryContext: context('u-admin', deliveries, { notice })
  });
  const NOTICE = { orderId: ORDER_UUID, reason: 'maker_po_bound', at: '2026-11-23T05:00:00.000Z' };

  it('step 12 says it at the top (role=alert) with the way forward, while a delivery is still unconfirmed', () => {
    const html = stepWith(NOTICE);
    expect(html).toMatch(/<p class="p1-banner p4w3-notice" role="alert" data-notice="maker_po_bound">/);
    expect(html).toContain('の納品の確認は止まりました。');
    expect(html).toContain('メーカー発注書の受領書');
    expect(html).toContain('<a href="#receipt-alternative">お客様の受領証跡を登録する</a>');
    expect(html.indexOf('data-notice="maker_po_bound"')).toBeLessThan(html.indexOf('p4w2-delivery-list'));
    expect(html).not.toMatch(HANGUL);
    expect(stepWith(NOTICE, [delivery('del-1')], true)).toContain('고객에게서 받은 납품 수령 증빙');
    // Nothing left to confirm / no notice: no banner.
    expect(stepWith(NOTICE, [delivery('del-1', true)])).not.toContain('data-notice');
    expect(stepWith(null)).not.toContain('data-notice');
  });

  it('the alternative form starts opened while a stopped confirmation waits for it, and closed otherwise (the link opens it: live check)', () => {
    expect(stepWith(NOTICE)).toMatch(/<details class="p4w4-alt" id="receipt-alternative" open="" data-alternative-receipt="">/);
    expect(stepWith(null)).toMatch(/<details class="p4w4-alt" id="receipt-alternative" data-alternative-receipt="">/);
  });

  it('the order screen reads the notice of ITS order only (another order\'s cookie says nothing)', async () => {
    const serve = () => {
      session.user = { id: 'u-admin', role: 'admin' };
      const o = order('FILM_DELIVERED', { id: ORDER_UUID, lines: [] });
      workspaceFixture.value = {
        error: null, projectRefused: false, project: { id: 'project-a', code: 'PRJ-1', name: 'A', route: 'F1' }, labels: null, filmOrders: [o], fillingOrders: [],
        sevenPurchaseOrders: [PO], documents: [receiptDoc('u-admin')], revisions: [], approvalEvents: [],
        deliveries: [delivery('del-1', false, { orderId: ORDER_UUID })], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
      };
      board.value = { workspace: workspaceFixture.value, boards: [{ order: o, closure: null, makerPurchaseOrders: [], makerPoError: null, paymentGate: null, paymentGateError: null }] };
      callApi.mockImplementation(async (url: string) => url.endsWith('/delivery-status') ? ok({ lines: [] }) : url.endsWith('/order-facts') ? ok({ orderedQuantity: '500', orderedUnit: 'meters', updatedAt: null }) : ok({ events: [] }));
    };
    const screen = async () => render(await OrderDetailScreen({ projectId: 'project-a', projectCode: 'PRJ-1', orderCode: 'FSO-1', started: false, step: 12 } as never));
    serve();
    session.cookies.set('kanei_receipt_notice', `${ORDER_UUID}|maker_po_bound|2026-11-23T05:00:00.000Z`);
    expect(await screen()).toContain('data-notice="maker_po_bound"');
    session.cookies.set('kanei_receipt_notice', `${OTHER_UUID}|maker_po_bound|2026-11-23T05:00:00.000Z`);
    expect(await screen()).not.toContain('data-notice="maker_po_bound"');
  });
});

// =============================================================================================
// (3) the Lows left by the p4/web3 review (REVIEW.md L-1 … L-6)
// =============================================================================================
/** Resolves async server components so a static render can print them. */
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
const queueLib = await import('../apps/web/src/lib/representative-queue.js');
const approvalActions = await import('../apps/web/src/app/approval-actions.js');
const noticeLib = await import('../apps/web/src/lib/approval-notice.js');

describe('(3) L-1: a slot that waits for the representative\'s check no longer points at a form that is not on the screen', () => {
  const gate = (seven: ReturnType<typeof slot>) => ({
    ...gateWith([]),
    designs: [{ designKey: '表面A', currentRevisionId: 'rev-1', currentRevisionNo: 1, fileSha256: 'ab'.repeat(32), customer: slot(false, true), seven, dualApproved: false }]
  });

  it('the representative: the slot says WHICH approval has to be recorded first, and that the check is then on this screen', () => {
    const html = panel('APPROVAL_PENDING', 'admin', { gate: gate(slot(false)) });
    expect(visibleText(html)).toContain('証跡の確認が必要です。セブン化学の承認が記録されると、この画面で確認できます');
    expect(html).not.toContain('上の「証跡を確認する」');
    expect(html).not.toContain('手動確認を記録する');
  });

  it('the waiting text never promises a form that cannot come: another design\'s open slot is named; with nothing open it says to reload', () => {
    const designOf = (key: string, customer: ReturnType<typeof slot>, seven: ReturnType<typeof slot>) => ({ designKey: key, currentRevisionId: `rev-${key}`, currentRevisionNo: 1, fileSha256: 'ab'.repeat(32), customer, seven, dualApproved: false });
    const other = { ...gateWith([]), designs: [designOf('表面A', slot(false, true), slot(true)), designOf('裏面B', slot(false), slot(false))] };
    expect(visibleText(panel('APPROVAL_PENDING', 'admin', { gate: other as never }))).toContain('ほかのデザインの承認が記録されると、この画面で確認できます');
    const none = { ...gateWith([]), designs: [designOf('表面A', slot(false, true), slot(true, true))] };
    const html = visibleText(panel('APPROVAL_PENDING', 'admin', { gate: none as never }));
    expect(html).toContain('確認の欄が出ないときは、画面を再読み込みしてください');
    expect(html).not.toContain('承認が記録されると、この画面で確認できます');
  });

  it('staff keep their line (the representative checks); once both approvals are recorded the check form itself is on the screen', () => {
    expect(visibleText(panel('APPROVAL_PENDING', 'staff', { gate: gate(slot(false)) }))).toContain('代表の確認を待っています');
    const both = { ...gate(slot(true)), pendingManualVerifications: [rawPending()] };
    expect(panel('APPROVAL_PENDING', 'admin', { gate: both as never })).toContain('手動確認を記録する');
  });
});

describe('(3) L-2: the two survivors of the p4/web3 review\'s mutation run are pinned', () => {
  it('V7: a delivery-status that does not say whether the 「証跡なし」 agreement is needed asks for it (the safe default)', () => {
    const missing = closureLib.receiptClosureFrom({ receiptClosure: { basis: 'delivery_confirmations' }, receiptAssumption: null });
    expect(missing.pending).toEqual({ basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: true });
    expect(closureLib.receiptClosureFrom({ receiptClosure: { basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false }, receiptAssumption: null }).pending.acknowledgeNoEvidenceRequired).toBe(false);
    const html = (closure: unknown) => panel('FILM_DELIVERED', 'admin', { deliveryContext: context('u-admin', [delivery('del-1', true)], { closure }) });
    expect(html(missing)).toContain('name="acknowledgeNoEvidence"');
    expect(html(closureLib.receiptClosureFrom({ receiptClosure: { basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false }, receiptAssumption: null }))).not.toContain('name="acknowledgeNoEvidence"');
  });

  describe('V16: when the card cannot be read again, a stopped approval says 「内容が変わりました」, never 「証跡が変わりました」', () => {
    const PO_ID = '0192a000-0000-7000-8000-0000000000f1';
    const approve = () => approvalActions.approveFromCardAction(null, form({ poId: PO_ID, expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, expectedEvidenceStamp: 'drawn-stamp' }));
    const content = noticeLib.approvalNoticeText('content_changed');
    const evidence = noticeLib.approvalNoticeText('evidence_changed');

    it('the card read fails (an outage, a 500) → content_changed', async () => {
      callApi.mockImplementation(async (url: string) => url.endsWith('/approval-card') ? outage(503) : fail(409, 'MAKER_PO_SNAPSHOT_CHANGED'));
      const result = await approve();
      expect(result).toMatchObject({ ok: false, code: 'MAKER_PO_SNAPSHOT_CHANGED', settled: true });
      expect(result.message).toBe(content.ja);
      expect(result.message).not.toBe(evidence.ja);
    });

    it('the re-read card carries no evidence stamp (an older API) → content_changed', async () => {
      callApi.mockImplementation(async (url: string) => url.endsWith('/approval-card') ? ok({ makerPurchaseOrder: { id: PO_ID } }) : fail(409, 'MAKER_PO_SNAPSHOT_CHANGED'));
      expect((await approve()).message).toBe(content.ja);
    });
  });
});

describe('(3) L-4: the Korean line of a delivery row names its line and quantity like the Japanese title', () => {
  const item = { kind: 'delivery_confirmation', label: '納品の確認', project: { id: 'proj-1', code: 'PRJ-1' }, order: { id: 'ord-1', code: 'FSO-1' }, detail: { delivery: { line: { lineNumber: 1 }, display: '500 m' } } };

  it('queueTarget has a Korean twin; the suffix of a row with no organization / design takes it', () => {
    expect(queueLib.queueTarget(item, 'ko')).toBe('명세1／500 m');
    expect(queueLib.queueTarget(item)).toBe('明細1／500 m');
    const task = queueLib.taskFromServerItem(item)!;
    expect(queueLib.queueRowSuffixKo(task)).toBe('(명세1／500 m)');
    // A row that names an organization keeps its organization suffix (a design name is never translated).
    expect(queueLib.queueRowSuffixKo({ organization: 'seven', designKey: '表面A', targetKo: '세븐화학／디자인 表面A' })).toBe('(세븐화학／表面A)');
    expect(queueLib.queueRowSuffixKo({ organization: null, designKey: null })).toBeNull();
  });

  it('on the home screen the Korean line reads 「납품 확인 (명세1／500 m)」 beside 「納品の確認（明細1／500 m）」', async () => {
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({ items: [item], blocked: [] }));
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    const html = render((await resolve(await HomeScreen())) as ReactElement, true);
    expect(html).toContain('納品の確認（明細1／500 m）');
    expect(html).toContain('납품 확인 (명세1／500 m)');
  });
});

describe('(3) L-6: the lock line of a blocked 未定 row has its Korean twin (by the server\'s reason)', () => {
  const blocked = (reason: string) => ({
    key: 'payment_terms_undetermined:ord-1', kind: 'payment_terms_undetermined', project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' },
    order: { id: 'ord-1', code: 'PRJ-1-FILM-001', status: 'ON_HOLD', paymentTerms: 'undetermined' },
    reason: { code: 'PAYMENT_TERMS_UNDETERMINED', message: '支払条件が「未定」です。' }, fixableBy: ['admin', 'staff'], paymentTermsEditable: false,
    paymentTermsLock: { code: 'PAYMENT_TERMS_LOCKED', reason, message: '保留中のため支払条件は変更できません。' }, waitingSince: '2026-11-23T01:00:00Z',
    deepLink: { step: 'payment_terms', projectCode: 'PRJ-1', orderCode: 'PRJ-1-FILM-001', projectId: 'proj-1', orderId: 'ord-1', subjectId: 'ord-1' }
  });
  async function home(reason: string, korean: boolean) {
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({ items: [], blocked: [blocked(reason)] }));
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    return render((await resolve(await HomeScreen())) as ReactElement, korean);
  }

  it('order_frozen / ceo_approved: the Korean line follows the Japanese one (bilingual mode only)', async () => {
    expect(await home('order_frozen', true)).toContain('보류·재검토 중이거나 취소 종료된 발주는 결제 조건을 바꿀 수 없습니다');
    expect(await home('ceo_approved', true)).toContain('대표 승인이 끝난 메이커 발주서가 있어 결제 조건을 바꿀 수 없습니다');
    const japanese = await home('order_frozen', false);
    expect(japanese).toContain('いまは変更できません: 保留中のため支払条件は変更できません。');
    expect(japanese).not.toMatch(HANGUL);
  });

  it('a reason the web does not know gets no Korean line (never a guess)', async () => {
    const html = await home('something_new', true);
    expect(html).toContain('いまは変更できません');
    expect(html).not.toContain('결제 조건을 바꿀 수 없습니다');
  });
});

describe('(3) L-6: the old approvals list\'s link to the step-6 check is a 44px target, and the summaries are 44px on a narrow screen', () => {
  it('the read-only list links to the order screen with the target class', () => {
    const html = render(<PendingVerificationSection pending={[toView(rawPending(FOREIGN))] as never} role="admin" canVerify={false} readOnly recordHref="/p/PRJ-1/o/FSO-1?step=6" evidenceLabel={() => 'x'} organizationText={() => '顧客'} />);
    expect(html).toContain('<a class="p4w3-target" href="/p/PRJ-1/o/FSO-1?step=6">発注の画面（手順6 校了）で確認を記録する</a>');
    expect(html).not.toContain('手動確認を記録する');
  });

  it('the stylesheet carries the narrow-screen rule for every <summary> in the content (measured live at 390px: see REPORT)', () => {
    const css = readSrc('app/p4-web4.css');
    expect(css).toMatch(/@media \(max-width: 600px\) \{\s*main details > summary \{[^}]*min-height: 44px;/);
    expect(readSrc('app/layout.tsx')).toContain("import './p4-web4.css';");
  });
});
