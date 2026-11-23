/**
 * P1 integration: the 代表承認 now requires the snapshot hash the approval card
 * showed (expectedSnapshotSha256, API_CONTRACT v3 decision). Test callers read it
 * the way the screen does — GET /api/maker-purchase-orders/:id/approval-card —
 * and send it with the approval body. When the card cannot be read (a refused or
 * missing paper) the body goes without it, so the API's own earlier refusal
 * (payment gate, dual approval, state …) is still what the test sees.
 *
 * P4 H4① (conductor decision): the approval also requires 金額 and 希望納期. A
 * fixture that reaches the approval without them is completed the way the
 * representative completes it on the card — PATCH …/amounts for the amount and
 * PATCH …/delivery-dates for the date — before the hash is read, so the hash
 * sent is the one of the completed paper. Only the facts the card lists as
 * missing (blockers AMOUNT_REQUIRED / DELIVERY_DATE_REQUIRED) are written, so a
 * fixture that already carries them is untouched. `fillApprovalFacts: false`
 * keeps the paper as it is (tests of the H4① refusal itself).
 */
interface RequestApp {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
}

/** The amount and date a fixture is completed with (synthetic). */
export const FIXTURE_APPROVAL_AMOUNTS = { currency: 'JPY', totalAmount: '480000' } as const;
export const FIXTURE_REQUESTED_DELIVERY_DATE = '2027-03-31';

interface CardShape {
  makerPurchaseOrder?: { approvalSnapshotSha256?: unknown };
  order?: { id?: unknown };
  blockers?: Array<{ code?: unknown }>;
}

async function readCard(app: RequestApp, sessionToken: string, poId: string): Promise<CardShape | null> {
  const response = await app.request(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/approval-card`, {
    headers: { cookie: `kanei_mvp_session=${sessionToken}` }
  });
  if (!response.ok) return null;
  return (await response.json()) as CardShape;
}

async function write(app: RequestApp, sessionToken: string, method: string, url: string, body: unknown): Promise<void> {
  await app.request(url, {
    method,
    headers: { cookie: `kanei_mvp_session=${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/**
 * Completes the H4① facts of a DRAFT paper when the card says they are missing
 * (no-op otherwise). Answers the card read after the completion (or null).
 */
export async function completeApprovalFacts(app: RequestApp, sessionToken: string, poId: string): Promise<CardShape | null> {
  let card = await readCard(app, sessionToken, poId);
  if (!card) return null;
  const codes = new Set((card.blockers ?? []).map((blocker) => blocker.code));
  let changed = false;
  if (codes.has('DELIVERY_DATE_REQUIRED') && typeof card.order?.id === 'string') {
    await write(app, sessionToken, 'PATCH', `/api/film-supply-orders/${encodeURIComponent(card.order.id)}/delivery-dates`, {
      requestedDeliveryDate: FIXTURE_REQUESTED_DELIVERY_DATE
    });
    changed = true;
  }
  if (codes.has('AMOUNT_REQUIRED')) {
    // The amount write pins the hash the card showed; re-read it after a date change.
    if (changed) card = (await readCard(app, sessionToken, poId)) ?? card;
    const hash = card.makerPurchaseOrder?.approvalSnapshotSha256;
    if (typeof hash === 'string') {
      await write(app, sessionToken, 'PATCH', `/api/maker-purchase-orders/${encodeURIComponent(poId)}/amounts`, {
        amounts: FIXTURE_APPROVAL_AMOUNTS,
        expectedSnapshotSha256: hash
      });
      changed = true;
    }
  }
  return changed ? await readCard(app, sessionToken, poId) : card;
}

export async function withApprovalSnapshot(
  app: RequestApp,
  sessionToken: string,
  poId: string,
  body: Record<string, unknown> = {},
  options: { fillApprovalFacts?: boolean } = {}
): Promise<Record<string, unknown>> {
  const card = options.fillApprovalFacts === false
    ? await readCard(app, sessionToken, poId)
    : await completeApprovalFacts(app, sessionToken, poId);
  if (!card) return body;
  const hash = card.makerPurchaseOrder?.approvalSnapshotSha256;
  return typeof hash === 'string' ? { expectedSnapshotSha256: hash, ...body } : body;
}
