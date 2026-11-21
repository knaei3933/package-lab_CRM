import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R24: the approval card model — server card (contract §2-1), web fallback, loader. */
const callApi = vi.hoisted(() => vi.fn());
const loadMakerPoDetail = vi.hoisted(() => vi.fn());
const loadApprovalGate = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('../apps/web/src/lib/maker-po-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/maker-po-data.js')>()),
  loadMakerPoDetail: (...args: unknown[]) => loadMakerPoDetail(...args)
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadApprovalGate: (...args: unknown[]) => loadApprovalGate(...args)
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { isMissingRoute, cardFromServer, cardFromWeb, loadApprovalCard } = await import('../apps/web/src/lib/approval-card.js');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function serverBody(over: Record<string, unknown> = {}) {
  return {
    makerPurchaseOrder: { id: 'mpo-1', displayNumber: 'MPO-2026-0007', status: 'DRAFT', storedSnapshotSha256: SHA_B, approvalSnapshotSha256: SHA_A, snapshotDrifted: true },
    project: { id: 'p1', code: 'PRS', name: 'n' },
    order: { id: 'o1', code: 'FSO-1', status: 'MAKER_PO_READY', paymentTerms: 'prepaid', paymentTermsLabel: '前払い' },
    snapshot: {
      items: [{ lineNumber: 1, description: '合成フィルム', orderedQuantity: '500.000', unit: 'meters', quantityDisplay: '500 m' }],
      artworkFiles: [{ designKey: '表面A', revisionNo: 2, fileSha256: SHA_A, filename: 'proof.pdf', matchesApprovedRevision: true }],
      amounts: { currency: 'JPY', totalAmount: '312000', display: '¥312,000' },
      recipient: { address: 'order@maker.example', isEmail: true }
    },
    sevenPurchaseOrder: { id: 'po-1', poNumber: 'SC-1', officialRegisteredAt: '2026-11-01', verificationStatus: 'verified' },
    approvals: {
      dualApproved: true,
      designs: [{
        designKey: '表面A', currentRevisionNo: 2, currentRevisionId: 'rev-1',
        organizations: {
          customer: { state: 'approved', eventTime: '2026-11-19T01:00:00Z', evidence: { filename: 'c.eml', issuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated', issuerMatchesOrganization: true, evidenceSource: 'email', identifierStatus: 'verified_in_document' } },
          seven: { state: 'pending_manual_verification', evidence: { issuerEntity: 'customer_generated', expectedIssuerEntity: 'seven', issuerMatchesOrganization: false, evidenceSource: 'signed_document' } }
        }
      }]
    },
    blockers: [],
    warnings: [{ code: 'MAKER_PO_SNAPSHOT_DRIFTED', message: '変更あり' }],
    canApprove: true,
    canReturn: true,
    ...over
  };
}

describe('isMissingRoute', () => {
  it('is true for a 404 whose body has no code (the route does not exist)', () => {
    expect(isMissingRoute({ ok: false, status: 404, data: null })).toBe(true);
    expect(isMissingRoute({ ok: false, status: 404, data: {} })).toBe(true);
    expect(isMissingRoute({ ok: false, status: 404, data: { message: 'Not Found' } })).toBe(true);
  });
  it('is false for a 404 with a code (a real refusal such as MAKER_PO_NOT_FOUND)', () => {
    expect(isMissingRoute({ ok: false, status: 404, data: { code: 'MAKER_PO_NOT_FOUND' } })).toBe(false);
  });
  it('is false for other statuses and for an ok answer', () => {
    expect(isMissingRoute({ ok: false, status: 403, data: null })).toBe(false);
    expect(isMissingRoute({ ok: false, status: 500, data: null })).toBe(false);
    expect(isMissingRoute({ ok: false, status: 0, data: null })).toBe(false);
    expect(isMissingRoute({ ok: true, status: 404, data: null })).toBe(false);
  });
  it('treats a non-string code as no code', () => {
    expect(isMissingRoute({ ok: false, status: 404, data: { code: 5 } })).toBe(true);
  });
});

describe('cardFromServer', () => {
  it('returns null when the body lacks the paper, order or snapshot', () => {
    expect(cardFromServer('p', null)).toBeNull();
    expect(cardFromServer('p', 'x')).toBeNull();
    expect(cardFromServer('p', {})).toBeNull();
    expect(cardFromServer('p', { ...serverBody(), snapshot: undefined })).toBeNull();
    expect(cardFromServer('p', { ...serverBody(), order: null })).toBeNull();
    expect(cardFromServer('p', { ...serverBody(), makerPurchaseOrder: 'x' })).toBeNull();
  });

  it('maps the paper, order and amount', () => {
    const card = cardFromServer('mpo-1', serverBody())!;
    expect(card).toMatchObject({
      source: 'server', poId: 'mpo-1', displayNumber: 'MPO-2026-0007', status: 'DRAFT', orderCode: 'FSO-1',
      paymentTerms: 'prepaid', amountDisplay: '¥312,000', canApprove: true, canReturn: true, dualApproved: true
    });
  });

  it('takes expectedSnapshotSha256 from approvalSnapshotSha256, not storedSnapshotSha256', () => {
    const card = cardFromServer('mpo-1', serverBody())!;
    expect(card.expectedSnapshotSha256).toBe(SHA_A);
    expect(card.expectedPaymentTerms).toBe('prepaid');
  });

  it('has no expected hash when the server gave none', () => {
    const body = serverBody();
    delete (body.makerPurchaseOrder as Record<string, unknown>).approvalSnapshotSha256;
    expect(cardFromServer('p', body)!.expectedSnapshotSha256).toBeNull();
  });

  it('uses quantityDisplay, and falls back to the formatted quantity and unit', () => {
    const body = serverBody();
    (body.snapshot.items[0] as Record<string, unknown>).quantityDisplay = undefined;
    expect(cardFromServer('p', body)!.items[0]).toEqual({ lineNumber: 1, description: '合成フィルム', quantityDisplay: '500 m' });
    expect(cardFromServer('p', serverBody())!.items[0]!.quantityDisplay).toBe('500 m');
  });

  it('falls back to a formatted amount when amounts.display is missing', () => {
    const body = serverBody();
    (body.snapshot.amounts as Record<string, unknown>).display = undefined;
    expect(cardFromServer('p', body)!.amountDisplay).toMatch(/^[¥￥]312,000$/);
  });

  it('has no amount when amounts is null', () => {
    const body = serverBody();
    (body.snapshot as Record<string, unknown>).amounts = null;
    expect(cardFromServer('p', body)!.amountDisplay).toBeNull();
  });

  it('maps the artwork files with their hash and match flag', () => {
    expect(cardFromServer('p', serverBody())!.artworkFiles).toEqual([
      { designKey: '表面A', revisionNo: 2, sha256: SHA_A, filename: 'proof.pdf', matchesApprovedRevision: true }
    ]);
  });

  it('maps organizations.*.state and the evidence issuer fields', () => {
    const [design] = cardFromServer('p', serverBody())!.designs;
    expect(design).toMatchObject({ designKey: '表面A', revisionNo: 2 });
    expect(design!.customer).toMatchObject({ state: 'approved', eventTime: '2026-11-19T01:00:00Z' });
    expect(design!.customer.evidence).toMatchObject({ issuerEntity: 'customer_generated', issuerMatchesOrganization: true, evidenceSource: 'email' });
    expect(design!.seven.state).toBe('pending_manual_verification');
    expect(design!.seven.evidence).toMatchObject({ issuerEntity: 'customer_generated', expectedIssuerEntity: 'seven', issuerMatchesOrganization: false });
  });

  it('reads a missing organization as state missing with no evidence', () => {
    const body = serverBody();
    (body.approvals.designs[0] as Record<string, unknown>).organizations = {};
    const [design] = cardFromServer('p', body)!.designs;
    expect(design!.customer).toEqual({ state: 'missing', eventTime: null, evidence: null });
    expect(design!.seven.state).toBe('missing');
  });

  it('maps recipient, seven PO, blockers and warnings', () => {
    const body = serverBody({ blockers: [{ code: 'PAYMENT_GATE_UNSATISFIED', message: '未定です' }] });
    const card = cardFromServer('p', body)!;
    expect(card.recipient).toEqual({ address: 'order@maker.example', isEmail: true });
    expect(card.sevenPo).toEqual({ poNumber: 'SC-1', officialRegisteredAt: '2026-11-01', verificationStatus: 'verified' });
    expect(card.blockers).toEqual([{ code: 'PAYMENT_GATE_UNSATISFIED', message: '未定です' }]);
    expect(card.warnings).toEqual([{ code: 'MAKER_PO_SNAPSHOT_DRIFTED', message: '変更あり' }]);
  });

  it('sevenPo is null without a linked PO', () => {
    expect(cardFromServer('p', serverBody({ sevenPurchaseOrder: null }))!.sevenPo).toBeNull();
  });

  it('canApprove and canReturn are true only for the boolean true', () => {
    const card = cardFromServer('p', serverBody({ canApprove: 'true', canReturn: 1 }))!;
    expect(card.canApprove).toBe(false);
    expect(card.canReturn).toBe(false);
  });
});

describe('cardFromWeb', () => {
  const paper = (over: Record<string, unknown> = {}) => ({
    id: 'mpo-9', status: 'DRAFT',
    snapshot: {
      amounts: { currency: 'JPY', totalAmount: '480000' },
      recipient: { address: 'order@maker.example' },
      items: [{ lineNumber: 1, description: 'film', orderedQuantity: '300.000', unit: 'meters' }],
      specs: { artworkFiles: [{ designKey: 'A', revisionNo: 2, fileSha256: SHA_A }] }
    },
    ...over
  });
  const gate = (over: Record<string, unknown> = {}) => ({
    dualApproved: true, missingApprovals: [], pendingManualVerifications: [], orderId: 'o', orderStatus: 's',
    designs: [{ designKey: 'A', currentRevisionId: 'r', currentRevisionNo: 2, fileSha256: SHA_A, dualApproved: true, customer: { valid: true }, seven: { valid: false, pendingEvidenceIdentifier: true } }],
    ...over
  });
  const build = (over: { paper?: unknown; paymentTerms?: string | null; gate?: unknown } = {}) => cardFromWeb({
    paper: (over.paper ?? paper()) as never,
    orderCode: 'FSO-1',
    paymentTerms: over.paymentTerms === undefined ? 'prepaid' : over.paymentTerms,
    gate: (over.gate === undefined ? gate() : over.gate) as never,
    sevenPo: null
  });
  const codes = (card: { blockers: Array<{ code: string }> }) => card.blockers.map((blocker) => blocker.code);

  it('is approvable when nothing blocks: DRAFT, terms decided, dual approval, amount present', () => {
    const card = build();
    expect(card.source).toBe('web');
    expect(card.blockers).toEqual([]);
    expect(card.canApprove).toBe(true);
    expect(card.canReturn).toBe(true);
    expect(card.amountDisplay).toMatch(/^[¥￥]480,000$/);
    expect(card.expectedPaymentTerms).toBe('prepaid');
    expect(card.expectedSnapshotSha256).toBeNull();
    expect(card.items[0]!.quantityDisplay).toBe('300 m');
  });

  it('blocks a paper that is not DRAFT and cannot be returned', () => {
    const card = build({ paper: paper({ status: 'APPROVED_FOR_MANUAL_SEND' }) });
    expect(codes(card)).toContain('MAKER_PO_TRANSITION_BLOCKED');
    expect(card.canApprove).toBe(false);
    expect(card.canReturn).toBe(false);
  });

  it.each(['undetermined', null])('blocks payment terms %s', (paymentTerms) => {
    const card = build({ paymentTerms });
    expect(codes(card)).toContain('PAYMENT_GATE_UNSATISFIED');
    expect(card.canApprove).toBe(false);
  });

  it('blocks a missing dual approval', () => {
    const card = build({ gate: gate({ dualApproved: false }) });
    expect(codes(card)).toEqual(['DUAL_APPROVAL_REQUIRED']);
    expect(card.canApprove).toBe(false);
  });

  it('does not claim a dual-approval blocker when the gate could not be read', () => {
    const card = build({ gate: null });
    expect(codes(card)).not.toContain('DUAL_APPROVAL_REQUIRED');
    expect(card.dualApproved).toBe(false);
  });

  it.each([
    ['no snapshot amounts', { snapshot: { items: [], specs: { artworkFiles: [] } } }],
    ['an empty totalAmount', { snapshot: { amounts: { currency: 'JPY', totalAmount: '' } } }]
  ])('an amount missing (%s) is a warning, not a blocker: approvable with the explicit confirmation on the card', (_name, over) => {
    const card = build({ paper: paper(over) });
    expect(codes(card)).toEqual([]);
    expect(card.warnings.map((warning) => warning.code)).toEqual(['MAKER_PO_AMOUNT_MISSING']);
    expect(card.amountDisplay).toBeNull();
    expect(card.canApprove).toBe(true);
  });

  it('marks an artwork file as matching only when revision number and hash both equal the gate', () => {
    expect(build().artworkFiles[0]!.matchesApprovedRevision).toBe(true);
    const otherHash = build({ gate: gate({ designs: [{ designKey: 'A', currentRevisionId: 'r', currentRevisionNo: 2, fileSha256: SHA_B, customer: {}, seven: {} }] }) });
    expect(otherHash.artworkFiles[0]!.matchesApprovedRevision).toBe(false);
    const otherRevision = build({ gate: gate({ designs: [{ designKey: 'A', currentRevisionId: 'r', currentRevisionNo: 3, fileSha256: SHA_A, customer: {}, seven: {} }] }) });
    expect(otherRevision.artworkFiles[0]!.matchesApprovedRevision).toBe(false);
  });

  it('matchesApprovedRevision is null when the gate has no such design or no gate', () => {
    expect(build({ gate: gate({ designs: [] }) }).artworkFiles[0]!.matchesApprovedRevision).toBeNull();
    expect(build({ gate: null }).artworkFiles[0]!.matchesApprovedRevision).toBeNull();
  });

  it('checks the recipient is an e-mail address', () => {
    expect(build().recipient).toEqual({ address: 'order@maker.example', isEmail: true });
    const bad = build({ paper: paper({ snapshot: { amounts: { currency: 'JPY', totalAmount: '1' }, recipient: { address: 'not-an-email' } } }) });
    expect(bad.recipient).toEqual({ address: 'not-an-email', isEmail: false });
    const none = build({ paper: paper({ snapshot: { amounts: { currency: 'JPY', totalAmount: '1' } } }) });
    expect(none.recipient).toEqual({ address: null, isEmail: false });
  });

  it('uses the staff view recipientAddress when there is no snapshot recipient', () => {
    const card = build({ paper: paper({ snapshot: undefined, recipientAddress: 'staff@maker.example' }) });
    expect(card.recipient.address).toBe('staff@maker.example');
  });

  it('reads each organization seal from the gate: approved, pending, revoked, rejected, missing', () => {
    const designs = [{
      designKey: 'A', currentRevisionId: 'r', currentRevisionNo: 2, fileSha256: SHA_A,
      customer: { valid: true }, seven: { valid: false, pendingEvidenceIdentifier: true }
    }, {
      designKey: 'B', currentRevisionId: 'r2', currentRevisionNo: 1, fileSha256: SHA_A,
      customer: { valid: false, revoked: true }, seven: { valid: false, manualVerification: { result: 'rejected' } }
    }, {
      designKey: 'C', currentRevisionId: 'r3', currentRevisionNo: 1, fileSha256: SHA_A, customer: undefined, seven: { valid: false }
    }];
    const card = build({ gate: gate({ designs }) });
    expect(card.designs.map((design) => [design.customer.state, design.seven.state])).toEqual([
      ['approved', 'pending_manual_verification'], ['revoked', 'rejected'], ['missing', 'missing']
    ]);
  });
});

describe('loadApprovalCard', () => {
  const paper = { id: 'mpo-1', status: 'DRAFT', snapshot: { amounts: { currency: 'JPY', totalAmount: '1000' }, recipient: { address: 'a@b.example' } } };
  const input = (over: Record<string, unknown> = {}) => ({ paper: paper as never, orderId: 'o1', orderCode: 'FSO-1', paymentTerms: 'prepaid', sevenPo: null, ...over });
  const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, code: null });

  beforeEach(() => {
    callApi.mockReset();
    loadMakerPoDetail.mockReset();
    loadApprovalGate.mockReset();
    loadApprovalGate.mockResolvedValue({ dualApproved: true, designs: [], missingApprovals: [], pendingManualVerifications: [] });
  });

  it('uses the server card when the route answers, without any web-side read', async () => {
    callApi.mockResolvedValue(ok(serverBody()));
    const card = await loadApprovalCard(input());
    expect(callApi).toHaveBeenCalledWith('/api/maker-purchase-orders/mpo-1/approval-card');
    expect(card.source).toBe('server');
    expect(card.expectedSnapshotSha256).toBe(SHA_A);
    expect(loadApprovalGate).not.toHaveBeenCalled();
    expect(loadMakerPoDetail).not.toHaveBeenCalled();
  });

  it('builds the web card when the route is missing (404 without a code)', async () => {
    callApi.mockResolvedValue({ ok: false, status: 404, data: null, error: 'x', code: null });
    const card = await loadApprovalCard(input());
    expect(card.source).toBe('web');
    expect(loadApprovalGate).toHaveBeenCalledWith('o1');
    expect(card.canApprove).toBe(true);
  });

  it('reads the paper detail only when the row carries no snapshot', async () => {
    callApi.mockResolvedValue({ ok: false, status: 404, data: null, error: 'x', code: null });
    loadMakerPoDetail.mockResolvedValue({ purchaseOrder: { ...paper, id: 'mpo-1', snapshot: { amounts: { currency: 'JPY', totalAmount: '777' } } } });
    const card = await loadApprovalCard(input({ paper: { id: 'mpo-1', status: 'DRAFT' } }));
    expect(loadMakerPoDetail).toHaveBeenCalledWith('mpo-1');
    expect(card.amountDisplay).toMatch(/777/);
  });

  it('falls back to the web card when the server body is ok but unreadable', async () => {
    callApi.mockResolvedValue(ok({ unexpected: true }));
    expect((await loadApprovalCard(input())).source).toBe('web');
  });

  it('keeps the server decision for a card without an amount (the API only warns; the card asks for the confirmation)', async () => {
    const body = serverBody();
    (body.snapshot as Record<string, unknown>).amounts = null;
    callApi.mockResolvedValue(ok(body));
    const card = await loadApprovalCard(input());
    expect(card.source).toBe('server');
    expect(card.amountDisplay).toBeNull();
    expect(card.blockers.map((blocker) => blocker.code)).not.toContain('MAKER_PO_AMOUNT_MISSING');
  });

  it('does not duplicate an amount blocker the server already sent', async () => {
    const body = serverBody({ blockers: [{ code: 'MAKER_PO_AMOUNT_MISSING', message: 'server' }], canApprove: false });
    (body.snapshot as Record<string, unknown>).amounts = null;
    callApi.mockResolvedValue(ok(body));
    const card = await loadApprovalCard(input());
    expect(card.blockers.filter((blocker) => blocker.code === 'MAKER_PO_AMOUNT_MISSING')).toHaveLength(1);
  });

  it('keeps canApprove true for a server card with an amount and no blockers', async () => {
    callApi.mockResolvedValue(ok(serverBody()));
    expect((await loadApprovalCard(input())).canApprove).toBe(true);
  });
});
