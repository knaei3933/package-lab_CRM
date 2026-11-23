import { callApi } from './api';

/**
 * P5 R5 (audit44b REMAINING §1, the premise of N4): 取引先の連絡先 — the
 * registered contact address of each customer / セブン化学 account. The sender
 * check of an approval mail compares the mail's From domain with it; without
 * it every mail reads 「照合していません」. Reads only; the write is the server
 * action of app/partners/actions.ts. Admin only (the API answers 403 CEO_ONLY
 * to everyone else, shown as a notice — never data).
 */

export interface PartnerAccountView {
  id: string;
  name: string;
  role: 'end_customer' | 'seven';
  externalCode: string | null;
  contactEmail: string | null;
  isActive: boolean;
  projectCodes: string[];
}

export type PartnerAccountsRead =
  | { kind: 'ok'; accounts: PartnerAccountView[] }
  | { kind: 'forbidden' }
  | { kind: 'error'; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PARTNER_ROLE_LABELS: Readonly<Record<PartnerAccountView['role'], string>> = {
  end_customer: '顧客',
  seven: 'セブン化学'
};

/** One answered account, or null when the shape is not the contract's (malformed rows are dropped). */
export function partnerAccountOf(value: unknown): PartnerAccountView | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.name !== 'string') return null;
  if (row.role !== 'end_customer' && row.role !== 'seven') return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    externalCode: typeof row.externalCode === 'string' && row.externalCode.length > 0 ? row.externalCode : null,
    contactEmail: typeof row.contactEmail === 'string' && row.contactEmail.length > 0 ? row.contactEmail : null,
    isActive: row.isActive !== false,
    projectCodes: Array.isArray(row.projectCodes) ? row.projectCodes.filter((code): code is string => typeof code === 'string').slice(0, 20) : []
  };
}

export async function loadPartnerAccounts(): Promise<PartnerAccountsRead> {
  try {
    const result = await callApi<{ accounts?: unknown }>('/api/partner-accounts');
    if (result.status === 403) return { kind: 'forbidden' };
    if (!result.ok) return { kind: 'error', error: result.error ?? '取引先の一覧を取得できませんでした' };
    const accounts = Array.isArray(result.data?.accounts) ? result.data.accounts : null;
    if (!accounts) return { kind: 'error', error: '取引先の一覧の形式を読み取れませんでした' };
    return { kind: 'ok', accounts: accounts.map(partnerAccountOf).filter((account): account is PartnerAccountView => account !== null) };
  } catch {
    return { kind: 'error', error: '取引先の一覧を取得できませんでした' };
  }
}

/** The same e-mail shape the maker PO's typed recipient and /makers are checked with (the API decides). */
export function isContactEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(value);
}

export function isPartnerAccountId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
