import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ERROR_DICTIONARY } from '../apps/web/src/lib/error-dictionary-data.js';

/** P1 R24/R29: the approval card and the Bilingual gloss, static render. */
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
const { Bilingual } = await import('../apps/web/src/components/Bilingual.js');
const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');

const SHA = `abcd${'0'.repeat(56)}ef12`;

const org = (state: string, evidence: Record<string, unknown> | null = null, eventTime: string | null = null) => ({ state, eventTime, evidence });

function card(over: Record<string, unknown> = {}) {
  return {
    source: 'server', poId: 'mpo-1', displayNumber: 'MPO-2026-0007', status: 'DRAFT', orderCode: 'FSO-1', paymentTerms: 'prepaid',
    amountDisplay: '¥312,000',
    items: [{ lineNumber: 1, description: '合成フィルム', quantityDisplay: '500 m' }],
    artworkFiles: [{ designKey: '表面A', revisionNo: 2, sha256: SHA, filename: 'proof.pdf', matchesApprovedRevision: true }],
    recipient: { address: 'order@maker.example', isEmail: true },
    sevenPo: { poNumber: 'SC-1', officialRegisteredAt: '2026-11-01T00:00:00Z', verificationStatus: 'verified' },
    designs: [{ designKey: '表面A', revisionNo: 2, customer: org('approved'), seven: org('missing') }],
    dualApproved: false, blockers: [], warnings: [], canApprove: true, canReturn: true,
    expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: 'a'.repeat(64),
    ...over
  };
}

function render(c: unknown, korean = false) {
  return renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: 'p1', showKorean: korean }}>
      <ApprovalCard card={c as never} korean={korean} />
    </RenderedContextProvider>
  );
}

const sealSlots = (html: string) => html.match(/class="p1-seal-slot /g)?.length ?? 0;
const sealMarks = (html: string) => html.match(/class="p1-seal-mark"/g)?.length ?? 0;

describe('ApprovalCard: forms', () => {
  it('shows the approve form with the paper, terms, hash and rendered project when canApprove and terms are known', () => {
    const html = render(card());
    expect(html).toContain('name="poId" value="mpo-1"');
    expect(html).toContain('name="expectedPaymentTerms" value="prepaid"');
    expect(html).toContain(`name="expectedSnapshotSha256" value="${'a'.repeat(64)}"`);
    expect(html).toContain(`name="${RENDERED_PROJECT_FIELD}" value="p1"`);
    expect(html).toContain('MPO-2026-0007 を代表承認する');
  });

  it('has no approve form when canApprove is false', () => {
    expect(render(card({ canApprove: false }))).not.toContain('name="expectedPaymentTerms"');
  });

  it('has no approve form without an expected payment terms value, even if canApprove', () => {
    expect(render(card({ expectedPaymentTerms: null }))).not.toContain('name="expectedPaymentTerms"');
  });

  it('omits the snapshot hash field for a web card', () => {
    expect(render(card({ expectedSnapshotSha256: null }))).not.toContain('name="expectedSnapshotSha256"');
  });

  it('shows the return form (reason field, 差し戻す button) only when canReturn', () => {
    const on = render(card());
    expect(on).toContain('name="reason"');
    expect(on).toMatch(/>差し戻す<\/button>/);
    const off = render(card({ canReturn: false }));
    expect(off).not.toContain('name="reason"');
    expect(off).not.toMatch(/>差し戻す<\/button>/);
  });

  it('shows neither form for an already approved paper', () => {
    const html = render(card({ canApprove: false, canReturn: false, status: 'APPROVED_FOR_MANUAL_SEND' }));
    expect(html).not.toContain('<form');
  });
});

describe('ApprovalCard: facts', () => {
  it('shows the amount as given: number and currency only, no 税込/税抜 label (the stored meaning is not asserted)', () => {
    const html = render(card({ amountDisplay: '¥312,000' }));
    expect(html).toContain('¥312,000');
    expect(html).not.toMatch(/税込|税抜/);
  });

  it('shows 未入力 and asks for the amount (P4 H4①: no 「金額未入力のまま承認する」 check any more)', () => {
    const html = render(card({ amountDisplay: null, canApprove: false }));
    expect(html).toContain('未入力');
    expect(html).not.toMatch(/税込|税抜/);
    const approvable = render(card({ amountDisplay: null, canApprove: true, expectedPaymentTerms: 'prepaid' }));
    expect(approvable).not.toContain('金額未入力のまま承認する');
    expect(approvable).not.toContain('acknowledgeMissingAmount');
    // Review M2: the representative types the amount instead (admin-only card) — and it is required.
    expect(approvable).toContain('name="totalAmount"');
    expect(approvable).toContain('name="amountRequired" value="true"');
  });

  it('shows lines, payment terms label, the recipient and the seven PO', () => {
    const html = render(card());
    expect(html).toContain('合成フィルム');
    expect(html).toContain('500 m');
    expect(html).toContain('前払い');
    expect(html).toContain('order@maker.example');
    expect(html).toContain('SC-1');
    expect(html).toContain('照合OK');
  });

  it('shows the artwork hash shortened and the match mark', () => {
    const html = render(card());
    expect(html).toContain(`SHA-256 ${SHA.slice(0, 4)}…${SHA.slice(-4)}`);
    expect(html).not.toContain(SHA);
    expect(html).toContain('校了した版と一致');
    expect(render(card({ artworkFiles: [{ designKey: 'A', revisionNo: 1, sha256: SHA, filename: null, matchesApprovedRevision: false }] }))).toContain('校了した版と違います');
  });

  it('flags a recipient that is not an e-mail address', () => {
    expect(render(card({ recipient: { address: 'nope', isEmail: false } }))).toContain('メールアドレスではありません');
  });

  it('says there is no linked seven PO', () => {
    expect(render(card({ sevenPo: null }))).toContain('紐付けなし');
  });
});

describe('ApprovalCard: 押印欄', () => {
  it('has exactly 3 slots (customer, seven, representative)', () => {
    expect(sealSlots(render(card()))).toBe(3);
  });

  it('stamps only the approved organization', () => {
    const html = render(card({ designs: [{ designKey: 'A', revisionNo: 1, customer: org('approved'), seven: org('missing') }] }));
    expect(sealMarks(html)).toBe(1);
    expect(html).toContain('顧客 承認済み');
    expect(html).not.toContain('セブン化学 承認済み');
  });

  it('stamps both when both are approved and none when neither is', () => {
    expect(sealMarks(render(card({ designs: [{ designKey: 'A', revisionNo: 1, customer: org('approved'), seven: org('approved') }] })))).toBe(2);
    expect(sealMarks(render(card({ designs: [{ designKey: 'A', revisionNo: 1, customer: org('missing'), seven: org('missing') }] })))).toBe(0);
  });

  it('never stamps a pending, rejected or revoked organization, and names the state in words', () => {
    const html = render(card({ designs: [{ designKey: 'A', revisionNo: 1, customer: org('pending_manual_verification'), seven: org('rejected') }] }));
    expect(sealMarks(html)).toBe(0);
    expect(html).toContain('確認待ち');
    expect(html).toContain('相違あり');
    expect(render(card({ designs: [{ designKey: 'A', revisionNo: 1, customer: org('revoked'), seven: org('missing') }] }))).toContain('取消');
  });

  it('shows empty slots when the paper has no design yet', () => {
    const html = render(card({ designs: [] }));
    expect(sealSlots(html)).toBe(3);
    expect(sealMarks(html)).toBe(0);
  });

  it('shows the issuer mismatch text when the evidence issuer is not the organization', () => {
    const evidence = { filename: 'a.pdf', issuerEntity: 'customer_generated', expectedIssuerEntity: 'seven', issuerMatchesOrganization: false, evidenceSource: 'signed_document', identifierStatus: null };
    const html = render(card({ designs: [{ designKey: 'A', revisionNo: 1, customer: org('missing'), seven: org('pending_manual_verification', evidence) }] }));
    // p4/web3 (a): the same words as the server's declarationLine `issuer_differs`, as a warning.
    expect(html).toContain('申告された発行元が承認組織と異なります');
    expect(html).toContain('data-declaration="issuer_differs"');
  });

  it('shows a check mark, and no mismatch, when the issuer matches', () => {
    const evidence = { filename: 'a.eml', issuerEntity: 'seven', expectedIssuerEntity: 'seven', issuerMatchesOrganization: true, evidenceSource: 'email', identifierStatus: null };
    const html = render(card({ designs: [{ designKey: 'A', revisionNo: 1, customer: org('missing'), seven: org('approved', evidence) }] }));
    expect(html).not.toContain('承認組織と不一致');
    expect(html).toContain(' ✓');
  });

  it('shows the representative slot as 未承認 for a DRAFT paper and 承認済み otherwise', () => {
    const draft = render(card({ designs: [] }));
    expect(draft).toMatch(/代表[\s\S]*?未承認/);
    const approved = render(card({ designs: [], status: 'APPROVED_FOR_MANUAL_SEND', canApprove: false, canReturn: false }));
    expect(approved).toMatch(/代表<\/p><p class="p1-seal-empty">承認済み/);
  });

  it('notes that only the first design is shown when there are several', () => {
    const design = { designKey: 'A', revisionNo: 1, customer: org('approved'), seven: org('approved') };
    expect(render(card({ designs: [design, { ...design, designKey: 'B' }] }))).toContain('デザインが2つあります');
    expect(render(card())).not.toContain('デザインが');
  });
});

describe('ApprovalCard: blockers and warnings', () => {
  it('lists each blocker message and no approve form', () => {
    const html = render(card({ canApprove: false, blockers: [{ code: 'PAYMENT_GATE_UNSATISFIED', message: '支払条件が未定です' }, { code: 'DUAL_APPROVAL_REQUIRED', message: '承認がそろっていません' }] }));
    expect(html).toContain('承認できません');
    // Verifier M1: a known code is said in the dictionary's words, not the API's raw text.
    expect(html).toContain(ERROR_DICTIONARY.PAYMENT_GATE_UNSATISFIED!.ja);
    expect(html).not.toContain('支払条件が未定です');
    expect(html).toContain(ERROR_DICTIONARY.DUAL_APPROVAL_REQUIRED?.ja ?? '承認がそろっていません');
  });

  it('falls back to the dictionary text for a blocker without a message', () => {
    const html = render(card({ canApprove: false, blockers: [{ code: 'PAYMENT_GATE_UNSATISFIED', message: '' }] }));
    expect(html).toContain('支払条件が「未定」のため代表承認できません');
  });

  it('has no blocker section when there are none', () => {
    expect(render(card())).not.toContain('承認できません');
  });

  it('shows warnings', () => {
    const drifted = render(card({ warnings: [{ code: 'MAKER_PO_SNAPSHOT_DRIFTED', message: '作成後に変更があります' }] }));
    expect(drifted).toContain(ERROR_DICTIONARY.MAKER_PO_SNAPSHOT_DRIFTED!.ja);
    // An unknown code keeps the API's own sentence (never an empty line).
    expect(render(card({ warnings: [{ code: 'P1_UNKNOWN_WARNING', message: '未知の注意です' }] }))).toContain('未知の注意です');
  });
});

describe('Korean glosses (R29)', () => {
  it('shows no Korean (no lang="ko") when the bilingual mode is off', () => {
    const html = render(card({ canApprove: false, blockers: [{ code: 'PAYMENT_GATE_UNSATISFIED', message: '' }] }), false);
    expect(html).not.toContain('lang="ko"');
    expect(html).not.toContain('대표 승인');
  });

  it('shows Korean glosses marked lang="ko" when the bilingual mode is on', () => {
    const html = render(card(), true);
    expect(html).toContain('lang="ko"');
    expect(html).toContain('대표 승인');
    expect(html).toContain('금액');
    expect(html).toContain('data-korean="on"');
  });

  it('keeps every Japanese text when Korean is on', () => {
    const html = render(card(), true);
    expect(html).toContain('金額');
    expect(html).toContain('¥312,000');
  });

  it('shows the Korean text of a blocker only in the bilingual mode', () => {
    const blockers = [{ code: 'PAYMENT_GATE_UNSATISFIED', message: '' }];
    const on = render(card({ canApprove: false, blockers }), true);
    const off = render(card({ canApprove: false, blockers }), false);
    expect(on).toContain('<span class="form-result-ko" lang="ko">결제 조건이 미정');
    expect(off).not.toContain('결제 조건이 미정');
  });
});

describe('Bilingual', () => {
  const inContext = (value: { projectId: string; showKorean: boolean } | null) => renderToStaticMarkup(
    value ? <RenderedContextProvider value={value}><Bilingual ja="金額" ko="금액" /></RenderedContextProvider> : <Bilingual ja="金額" ko="금액" />
  );

  it('shows Japanese and a lang="ko" Korean span when showKorean is on', () => {
    expect(inContext({ projectId: 'p', showKorean: true })).toBe('金額<span class="p1-ko" lang="ko">금액</span>');
  });

  it('shows only the Japanese when showKorean is off', () => {
    expect(inContext({ projectId: 'p', showKorean: false })).toBe('金額');
  });

  it('shows only the Japanese without any rendered context', () => {
    expect(inContext(null)).toBe('金額');
  });
});
