/**
 * P4 H10① (N10): the order screen is the operators' (担当者・代表者) and the auditor's read-only view;
 * a viewer — or a role this web does not know, read as one — is told it is a permission, never
 * 「この発注は見つかりません」.
 *
 * p6 int round 2: until p6 H10 the viewer's order codes were withheld, so the order of the address was
 * never found for a viewer and the refusal came from that lookup. Since the viewer reads the codes (H10:
 * code and stage on the overview), the refusal is decided by the role itself. Pure.
 */
export function orderScreenRefused(role: string | null | undefined): boolean {
  return role !== 'admin' && role !== 'staff' && role !== 'auditor';
}

export const ORDER_FORBIDDEN_TITLE = '閲覧権限では発注の画面を開けません';
export const ORDER_FORBIDDEN_BODY = '発注の画面を開けるのは、担当者と代表者です。履歴は「履歴」画面で見られます。';
