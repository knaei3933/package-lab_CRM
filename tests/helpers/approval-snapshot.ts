/**
 * P1 integration: the 代表承認 now requires the snapshot hash the approval card
 * showed (expectedSnapshotSha256, API_CONTRACT v3 decision). Test callers read it
 * the way the screen does — GET /api/maker-purchase-orders/:id/approval-card —
 * and send it with the approval body. When the card cannot be read (a refused or
 * missing paper) the body goes without it, so the API's own earlier refusal
 * (payment gate, dual approval, state …) is still what the test sees.
 */
interface RequestApp {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
}

export async function withApprovalSnapshot(
  app: RequestApp,
  sessionToken: string,
  poId: string,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const response = await app.request(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/approval-card`, {
    headers: { cookie: `kanei_mvp_session=${sessionToken}` }
  });
  if (!response.ok) return body;
  const card = (await response.json()) as { makerPurchaseOrder?: { approvalSnapshotSha256?: unknown } };
  const hash = card.makerPurchaseOrder?.approvalSnapshotSha256;
  return typeof hash === 'string' ? { expectedSnapshotSha256: hash, ...body } : body;
}
