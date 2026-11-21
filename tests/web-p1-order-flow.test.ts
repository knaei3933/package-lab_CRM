import { describe, expect, it, vi } from 'vitest';

/** P1 R21: the 12-step flow of one order and the one action now, by status and role. */
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  loadSession: async () => ({ kind: 'user' }),
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const flow = await import('../apps/web/src/lib/order-flow.js');
const { buildOrderFlow, stepForStatus, ORDER_STEPS, STEP_COUNT, liveMakerPo, approvalSlots, designsOf, nextStepText, waitingText, currentPaymentTerms } = flow;

const PO_OK = { id: 'po-1', poNumber: 'N', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };

function order(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'ord-1', code: 'FSO-1', status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: 'line-1', lineNumber: 1, description: 'film', orderedQuantity: '10', unit: 'rolls' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: null, paymentTerms: 'prepaid',
    createdAt: '', updatedAt: '', ...extra
  };
}

function maker(status: string, id = 'mpo-1') {
  return { id, status };
}

function build(status: string, role: string | null, over: Record<string, unknown> = {}) {
  const { orderExtra, ...rest } = over as { orderExtra?: Record<string, unknown> };
  return buildOrderFlow({
    order: order(status, orderExtra ?? {}) as never,
    role,
    po: PO_OK as never,
    documents: [],
    revisions: [],
    gate: null,
    makerPos: [],
    makerEvents: [],
    settledSendEventIds: new Set<string>(),
    paymentGate: null,
    deliveries: [],
    ...rest
  } as never);
}

describe('ORDER_STEPS', () => {
  it('has 12 numbered steps in order', () => {
    expect(STEP_COUNT).toBe(12);
    expect(ORDER_STEPS.map((step) => step.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('stepForStatus', () => {
  const ctx = { poRegistered: true, poVerified: true, makerPoStatus: null as string | null };
  it.each([
    ['SEVEN_PO_VERIFIED', 4], ['ARTWORK_RECEIVED', 5], ['PROOF_READY', 5], ['APPROVAL_PENDING', 6],
    ['DUAL_APPROVED', 7], ['MAKER_PO_READY', 7], ['APPROVED_FOR_MANUAL_SEND', 9], ['MAKER_PO_SENT_MANUALLY', 10],
    ['MAKER_PO_ACCEPTED', 11], ['FILM_IN_PRODUCTION', 11], ['FILM_SHIPPED', 12], ['FILM_DELIVERED', 12],
    ['FILM_RECEIPT_ASSUMED_NO_ISSUE', 13]
  ])('%s is step %i', (status, step) => {
    expect(stepForStatus(status, ctx)).toBe(step);
  });

  it('is step 1 for a DRAFT without a registered PO', () => {
    expect(stepForStatus('DRAFT', { ...ctx, poRegistered: false, poVerified: false })).toBe(1);
  });
  it('is step 2 for a DRAFT with a registered but unverified PO', () => {
    expect(stepForStatus('DRAFT', { ...ctx, poVerified: false })).toBe(2);
  });
  it('is step 3 for a DRAFT with a verified PO', () => {
    expect(stepForStatus('DRAFT', ctx)).toBe(3);
  });
  it('is step 8 for MAKER_PO_READY when the maker paper is still a DRAFT', () => {
    expect(stepForStatus('MAKER_PO_READY', { ...ctx, makerPoStatus: 'DRAFT' })).toBe(8);
  });
  it('is step 7 for MAKER_PO_READY without a maker paper', () => {
    expect(stepForStatus('MAKER_PO_READY', ctx)).toBe(7);
  });
  it.each(['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLED', 'NOPE'])('has no step for %s', (status) => {
    expect(stepForStatus(status, ctx)).toBeNull();
  });
});

describe('buildOrderFlow: status -> step and action kind (admin)', () => {
  it.each([
    ['SEVEN_PO_VERIFIED', 4, 'advance'],
    ['ARTWORK_RECEIVED', 5, 'proof'],
    ['PROOF_READY', 5, 'advance'],
    ['APPROVAL_PENDING', 6, 'approvals'],
    ['MAKER_PO_ACCEPTED', 11, 'advance'],
    ['FILM_IN_PRODUCTION', 11, 'advance'],
    ['FILM_SHIPPED', 12, 'deliver'],
    ['FILM_DELIVERED', 12, 'receipt']
  ])('%s -> step %i, action %s', (status, step, kind) => {
    const view = build(status, 'admin');
    expect(view.phase).toBe('active');
    expect(view.current).toBe(step);
    expect(view.panel.action.kind).toBe(kind);
  });

  it('advances SEVEN_PO_VERIFIED to ARTWORK_RECEIVED and requires an evidence note without any document', () => {
    const action = build('SEVEN_PO_VERIFIED', 'admin').panel.action;
    expect(action).toMatchObject({ kind: 'advance', to: 'ARTWORK_RECEIVED', evidenceNote: 'required' });
  });

  it('makes the evidence note optional once a document is bound to the order', () => {
    const view = build('SEVEN_PO_VERIFIED', 'admin', { documents: [{ filmSupplyOrderId: 'ord-1' }] });
    expect(view.panel.action).toMatchObject({ evidenceNote: 'optional' });
  });

  it('marks earlier steps done, the current one current and later ones upcoming', () => {
    const view = build('APPROVAL_PENDING', 'admin');
    expect(view.marks.slice(0, 5)).toEqual(Array(5).fill('done'));
    expect(view.marks[5]).toBe('current');
    expect(view.marks.slice(6)).toEqual(Array(6).fill('upcoming'));
  });

  it('lists the delivery lines of the order in the deliver action', () => {
    expect(build('FILM_SHIPPED', 'admin').panel.action).toEqual({ kind: 'deliver', lineIds: ['line-1'] });
  });
});

describe('buildOrderFlow: DRAFT and the purchase order', () => {
  it('is step 1 with po_check(registered=false) when the PO is not officially registered', () => {
    const view = build('DRAFT', 'staff', { po: { ...PO_OK, officiallyRegistered: false, verificationStatus: null } });
    expect(view.current).toBe(1);
    expect(view.panel.action).toEqual({ kind: 'po_check', poId: 'po-1', registered: false });
  });

  it('is step 1 when there is no PO at all', () => {
    const view = build('DRAFT', 'staff', { po: null });
    expect(view.current).toBe(1);
    expect(view.panel.action.kind).toBe('po_check');
  });

  it('is step 2 with po_check(registered=true) when the PO is registered but not verified', () => {
    const view = build('DRAFT', 'staff', { po: { ...PO_OK, verificationStatus: 'pending' } });
    expect(view.current).toBe(2);
    expect(view.panel.action).toEqual({ kind: 'po_check', poId: 'po-1', registered: true });
  });

  it('is step 3 and offers the confirmation transition when the PO is verified', () => {
    const view = build('DRAFT', 'staff');
    expect(view.current).toBe(3);
    expect(view.panel.action).toMatchObject({ kind: 'advance', to: 'SEVEN_PO_VERIFIED' });
  });
});

describe('buildOrderFlow: payment terms gate (B/R01)', () => {
  it('blocks DUAL_APPROVED when the order payment terms are undetermined, with the payment_terms fix', () => {
    const view = build('DUAL_APPROVED', 'admin', { orderExtra: { paymentTerms: 'undetermined' } });
    expect(view.current).toBe(7);
    expect(view.panel.action).toEqual({ kind: 'payment_terms', current: 'undetermined' });
    expect(view.panel.blocked?.fix).toBe('payment_terms');
    expect(view.panel.blocked?.reason).toContain('支払条件');
  });

  it('blocks when the payment terms are not recorded at all', () => {
    const view = build('DUAL_APPROVED', 'admin', { orderExtra: { paymentTerms: null } });
    expect(view.panel.blocked?.fix).toBe('payment_terms');
    expect(view.panel.action).toEqual({ kind: 'payment_terms', current: null });
  });

  it('blocks MAKER_PO_READY the same way', () => {
    const view = build('MAKER_PO_READY', 'admin', { orderExtra: { paymentTerms: 'undetermined' }, makerPos: [maker('DRAFT')] });
    expect(view.panel.blocked?.fix).toBe('payment_terms');
  });

  it('prefers the payment gate answer over the order record', () => {
    const view = build('DUAL_APPROVED', 'admin', {
      orderExtra: { paymentTerms: 'undetermined' },
      paymentGate: { paymentTerms: 'prepaid' }
    });
    expect(view.panel.blocked).toBeNull();
    expect(view.panel.action.kind).toBe('maker_po_create');
  });

  it('still shows the block to a role that cannot act, and a viewer cannot act on it', () => {
    const view = build('DUAL_APPROVED', 'viewer', { orderExtra: { paymentTerms: 'undetermined' } });
    expect(view.panel.blocked?.fix).toBe('payment_terms');
    expect(view.panel.canAct).toBe(false);
  });

  it('lets staff record the payment terms (staff_or_admin)', () => {
    const view = build('DUAL_APPROVED', 'staff', { orderExtra: { paymentTerms: 'undetermined' } });
    expect(view.panel.canAct).toBe(true);
  });

  it('currentPaymentTerms: gate answer, else the order, else null', () => {
    expect(currentPaymentTerms({ order: order('DRAFT', { paymentTerms: 'prepaid' }) as never, paymentGate: { paymentTerms: 'on_delivery' } as never })).toBe('on_delivery');
    expect(currentPaymentTerms({ order: order('DRAFT', { paymentTerms: 'prepaid' }) as never, paymentGate: null })).toBe('prepaid');
    expect(currentPaymentTerms({ order: order('DRAFT', { paymentTerms: undefined }) as never, paymentGate: null })).toBeNull();
  });
});

describe('buildOrderFlow: maker paper steps 7-10', () => {
  it('step 7: DUAL_APPROVED asks for the maker paper with the READY transition', () => {
    expect(build('DUAL_APPROVED', 'admin').panel.action).toEqual({ kind: 'maker_po_create', needsReadyTransition: true });
  });

  it('step 7: MAKER_PO_READY without a draft paper asks for it without the transition', () => {
    const view = build('MAKER_PO_READY', 'admin');
    expect(view.current).toBe(7);
    expect(view.panel.action).toEqual({ kind: 'maker_po_create', needsReadyTransition: false });
  });

  it('step 8: a DRAFT maker paper waits for the representative approval', () => {
    const view = build('MAKER_PO_READY', 'admin', { makerPos: [maker('DRAFT', 'mpo-9')] });
    expect(view.current).toBe(8);
    expect(view.panel.action).toEqual({ kind: 'ceo_approve', poId: 'mpo-9' });
  });

  it('step 9: an approved paper is sent by staff or admin', () => {
    const view = build('APPROVED_FOR_MANUAL_SEND', 'staff', { makerPos: [maker('APPROVED_FOR_MANUAL_SEND')] });
    expect(view.current).toBe(9);
    expect(view.panel.action).toEqual({ kind: 'send', poId: 'mpo-1' });
    expect(view.panel.canAct).toBe(true);
  });

  it('step 9: SEND_UNVERIFIED shows send_stuck for the representative only', () => {
    const view = build('APPROVED_FOR_MANUAL_SEND', 'staff', { makerPos: [maker('SEND_UNVERIFIED')] });
    expect(view.panel.action.kind).toBe('send_stuck');
    expect(view.panel.canAct).toBe(false);
  });

  it('step 9 without a maker paper is unreadable and nobody acts', () => {
    const view = build('APPROVED_FOR_MANUAL_SEND', 'admin');
    expect(view.panel.action.kind).toBe('unreadable');
    expect(view.panel.canAct).toBe(false);
  });

  const pendingSend = [{ id: 'ev-1', eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'PENDING_MANUAL_VERIFICATION' }];

  it('shows send_verify for a pending send evidence, admin only', () => {
    const makerPos = [maker('MAKER_PO_SENT_MANUALLY')];
    const admin = build('MAKER_PO_SENT_MANUALLY', 'admin', { makerPos, makerEvents: pendingSend });
    const staff = build('MAKER_PO_SENT_MANUALLY', 'staff', { makerPos, makerEvents: pendingSend });
    expect(admin.panel.action).toEqual({ kind: 'send_verify', poId: 'mpo-1', eventId: 'ev-1' });
    expect(admin.panel.canAct).toBe(true);
    expect(staff.panel.canAct).toBe(false);
  });

  it('ignores a send evidence whose decision is already recorded', () => {
    const view = build('MAKER_PO_SENT_MANUALLY', 'admin', {
      makerPos: [maker('MAKER_PO_SENT_MANUALLY')], makerEvents: pendingSend, settledSendEventIds: new Set(['ev-1'])
    });
    expect(view.panel.action.kind).toBe('accept');
  });

  it('step 10: the provisional acceptance is staff_or_admin, the final one is admin only', () => {
    const makerPos = [maker('MAKER_PO_SENT_MANUALLY')];
    const first = build('MAKER_PO_SENT_MANUALLY', 'staff', { makerPos });
    expect(first.current).toBe(10);
    expect(first.panel.action).toEqual({ kind: 'accept', poId: 'mpo-1', provisionalRecorded: false });
    expect(first.panel.canAct).toBe(true);
    const events = [{ id: 'e2', eventType: 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL' }];
    const final = build('MAKER_PO_SENT_MANUALLY', 'staff', { makerPos, makerEvents: events });
    expect(final.panel.action).toMatchObject({ kind: 'accept', provisionalRecorded: true });
    expect(final.panel.actor).toBe('admin');
    expect(final.panel.canAct).toBe(false);
    expect(build('MAKER_PO_SENT_MANUALLY', 'admin', { makerPos, makerEvents: events }).panel.canAct).toBe(true);
  });

  it('step 6: when every slot is approved or pending and evidence is pending, the check is admin only', () => {
    const slot = (valid: boolean, pending: boolean) => ({ valid, pendingEvidenceIdentifier: pending });
    const gate = {
      designs: [{ designKey: 'A', currentRevisionId: 'r1', currentRevisionNo: 1, customer: slot(true, false), seven: slot(false, true) }],
      pendingManualVerifications: [{ id: 'v1' }]
    };
    const staff = build('APPROVAL_PENDING', 'staff', { gate });
    const admin = build('APPROVAL_PENDING', 'admin', { gate });
    expect(admin.panel.action).toEqual({ kind: 'evidence_check', count: 1 });
    expect(staff.panel.canAct).toBe(false);
    expect(admin.panel.canAct).toBe(true);
  });

  it('step 6: an open slot keeps the approvals action even with pending evidence', () => {
    const gate = {
      designs: [{ designKey: 'A', currentRevisionId: 'r1', currentRevisionNo: 1, customer: { valid: true, pendingEvidenceIdentifier: false }, seven: undefined }],
      pendingManualVerifications: [{ id: 'v1' }]
    };
    expect(build('APPROVAL_PENDING', 'staff', { gate }).panel.action.kind).toBe('approvals');
  });
});

describe('buildOrderFlow: permissions by role', () => {
  const makerReady = { makerPos: [maker('DRAFT')] };
  const adminOnly: Array<[string, string, Record<string, unknown>]> = [
    ['ceo_approve', 'MAKER_PO_READY', makerReady],
    ['send_verify', 'MAKER_PO_SENT_MANUALLY', { makerPos: [maker('MAKER_PO_SENT_MANUALLY')], makerEvents: [{ id: 'e', eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'PENDING_MANUAL_VERIFICATION' }] }],
    ['send_stuck', 'APPROVED_FOR_MANUAL_SEND', { makerPos: [maker('SEND_UNVERIFIED')] }],
    ['hold', 'ON_HOLD', {}],
    ['cancellation_review', 'CANCELLATION_REVIEW', {}]
  ];

  it('P-6: maker_po_create (DUAL_APPROVED) is staff_or_admin — staff draft, the representative approves', () => {
    const flow = (role: string) => build('DUAL_APPROVED', role);
    expect(flow('staff').panel.action.kind).toBe('maker_po_create');
    expect(flow('staff').panel.canAct).toBe(true);
    expect(flow('admin').panel.canAct).toBe(true);
    expect(flow('viewer').panel.canAct).toBe(false);
  });

  it.each(adminOnly)('%s (%s): staff cannot act, admin can', (kind, status, over) => {
    const staff = build(status, 'staff', over);
    const admin = build(status, 'admin', over);
    expect(admin.panel.action.kind).toBe(kind);
    expect(staff.panel.actor).toBe('admin');
    expect(staff.panel.canAct).toBe(false);
    expect(admin.panel.canAct).toBe(true);
  });

  it('CHANGE_REVIEW is staff_or_admin', () => {
    const staff = build('CHANGE_REVIEW', 'staff');
    expect(staff.panel.actor).toBe('staff_or_admin');
    expect(staff.panel.canAct).toBe(true);
    expect(build('CHANGE_REVIEW', 'admin').panel.canAct).toBe(true);
    expect(build('CHANGE_REVIEW', 'viewer').panel.canAct).toBe(false);
  });

  it('staff can act on staff_or_admin steps (proof, approvals, delivery)', () => {
    for (const status of ['ARTWORK_RECEIVED', 'APPROVAL_PENDING', 'FILM_SHIPPED', 'FILM_DELIVERED', 'MAKER_PO_ACCEPTED']) {
      expect(build(status, 'staff').panel.canAct, status).toBe(true);
    }
  });

  const everyScenario: Array<[string, Record<string, unknown>]> = [
    ...['DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_ACCEPTED', 'FILM_IN_PRODUCTION', 'FILM_SHIPPED', 'FILM_DELIVERED', 'ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW', 'CANCELLED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE'].map((s): [string, Record<string, unknown>] => [s, {}]),
    ['MAKER_PO_READY', makerReady],
    ['APPROVED_FOR_MANUAL_SEND', { makerPos: [maker('APPROVED_FOR_MANUAL_SEND')] }],
    ['MAKER_PO_SENT_MANUALLY', { makerPos: [maker('MAKER_PO_SENT_MANUALLY')] }]
  ];

  it.each(everyScenario)('a viewer (or unknown role) never canAct at %s', (status, over) => {
    expect(build(status, 'viewer', over).panel.canAct).toBe(false);
    expect(build(status, null, over).panel.canAct).toBe(false);
    expect(build(status, 'something-else', over).panel.canAct).toBe(false);
  });

  it('a hidden status (viewer) is unreadable and nobody can act', () => {
    const view = build('DRAFT', 'viewer', { orderExtra: { statusHidden: true } });
    expect(view.phase).toBe('hidden');
    expect(view.status).toBeNull();
    expect(view.panel.action.kind).toBe('unreadable');
    expect(view.panel.canAct).toBe(false);
    expect(view.marks).toEqual(Array(12).fill('unknown'));
  });
});

describe('buildOrderFlow: exceptions, cancelled and terminal', () => {
  it('ON_HOLD marks the step the order left as interrupted', () => {
    const view = build('ON_HOLD', 'admin', { orderExtra: { lastNormalStatus: 'MAKER_PO_SENT_MANUALLY' }, makerPos: [maker('MAKER_PO_SENT_MANUALLY')] });
    expect(view.phase).toBe('exception');
    expect(view.current).toBe(10);
    expect(view.marks[9]).toBe('interrupted');
    expect(view.marks.slice(0, 9)).toEqual(Array(9).fill('done'));
    expect(view.marks.slice(10)).toEqual(Array(2).fill('upcoming'));
  });

  it('an exception without a known last status has unknown marks and no current step', () => {
    const view = build('CHANGE_REVIEW', 'admin', { orderExtra: { lastNormalStatus: null } });
    expect(view.current).toBeNull();
    expect(view.marks).toEqual(Array(12).fill('unknown'));
  });

  it('CANCELLED is its own phase with no actor and nobody can act', () => {
    const view = build('CANCELLED', 'admin');
    expect(view.phase).toBe('cancelled');
    expect(view.panel.action.kind).toBe('cancelled');
    expect(view.panel.actor).toBeNull();
    expect(view.panel.canAct).toBe(false);
  });

  it('the terminal state completes every step', () => {
    const view = build('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'admin');
    expect(view.phase).toBe('complete');
    expect(view.current).toBeNull();
    expect(view.marks).toEqual(Array(12).fill('done'));
    expect(view.panel.action.kind).toBe('done');
    expect(view.panel.canAct).toBe(false);
  });

  it('an unknown status is not shown as a step', () => {
    const view = build('SOMETHING_NEW', 'admin');
    expect(view.phase).toBe('unknown');
    expect(view.current).toBeNull();
    expect(view.panel.action.kind).toBe('unreadable');
  });
});

describe('helpers', () => {
  it('liveMakerPo returns the last live paper and skips cancelled ones', () => {
    expect(liveMakerPo([maker('DRAFT', 'a') as never, maker('CANCELLED', 'b') as never])?.id).toBe('a');
    expect(liveMakerPo([maker('DRAFT', 'a') as never, maker('APPROVED_FOR_MANUAL_SEND', 'c') as never])?.id).toBe('c');
    expect(liveMakerPo([maker('CANCELLED') as never])).toBeNull();
    expect(liveMakerPo([])).toBeNull();
  });

  it('approvalSlots maps valid -> approved, pending identifier -> pending_check, else open', () => {
    const slots = approvalSlots({
      designs: [{
        designKey: 'A', currentRevisionId: 'r1', currentRevisionNo: 2,
        customer: { valid: true, pendingEvidenceIdentifier: true },
        seven: { valid: false, pendingEvidenceIdentifier: true }
      }, {
        designKey: 'B', currentRevisionId: 'r2', currentRevisionNo: 1,
        customer: { valid: false, pendingEvidenceIdentifier: false },
        seven: undefined
      }]
    } as never);
    expect(slots[0]).toMatchObject({ designKey: 'A', revisionId: 'r1', revisionNo: 2, customer: 'approved', seven: 'pending_check' });
    expect(slots[1]).toMatchObject({ customer: 'open', seven: 'open' });
    expect(approvalSlots(null)).toEqual([]);
  });

  it('designsOf lists the order designs once each in registration order', () => {
    const revisions = [
      { filmSupplyOrderId: 'o1', designKey: 'B' }, { filmSupplyOrderId: 'o1', designKey: 'A' },
      { filmSupplyOrderId: 'o1', designKey: 'B' }, { filmSupplyOrderId: 'o2', designKey: 'Z' }
    ];
    expect(designsOf(revisions as never, 'o1')).toEqual(['B', 'A']);
  });

  it('nextStepText names the next step and who does it', () => {
    expect(nextStepText({ phase: 'active', current: 5 })).toBe('次: 6 校了（担当者）');
    expect(nextStepText({ phase: 'active', current: 7 })).toBe('次: 8 代表承認（代表）');
    expect(nextStepText({ phase: 'active', current: 12 })).toBe('次: 完了・手数料計算の準備');
  });

  it('nextStepText is null outside the active phase', () => {
    expect(nextStepText({ phase: 'exception', current: 5 })).toBeNull();
    expect(nextStepText({ phase: 'active', current: null })).toBeNull();
  });

  it('waitingText says who is waited for', () => {
    expect(waitingText('admin')).toContain('代表');
    expect(waitingText('staff_or_admin')).toContain('担当者');
    expect(waitingText(null)).toContain('担当者');
  });
});
