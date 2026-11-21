import { callApi } from './api';

/**
 * P2 R33 (contract v1.2 §4): the maker (メーカー) master and the recipient
 * addresses a maker PO can be sent to. Reads only; the writes are the server
 * actions of app/makers/actions.ts and the create actions (recipientAddressId).
 * The API decides who may read: the project list for admin and assigned staff,
 * the company-wide master for admin only (403 CEO_ONLY for everyone else).
 */

export interface MakerRecipientAddressView {
  id: string;
  email: string;
  label: string | null;
  isDefault: boolean;
  isActive: boolean;
  updatedAt: string | null;
}

export interface MakerAccountView {
  id: string;
  name: string;
  externalCode: string | null;
  isActive: boolean;
  recipientAddresses: MakerRecipientAddressView[];
}

/** The radio value of 「直接入力する」 (never an address id). */
export const TYPED_RECIPIENT = '__typed';

/** The radio group's posted name. */
export const RECIPIENT_CHOICE_FIELD = 'recipientChoice';

/** P2 R33: the chosen master address is no longer usable for this project's maker. */
export const RECIPIENT_UNAVAILABLE_CODE = 'MAKER_RECIPIENT_ADDRESS_UNAVAILABLE';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The API's ids are UUIDs; anything else is never sent as an id. */
export function isUuidLike(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * What the create form's recipient fields say, before any check of the typed
 * address: a master address id, the typed address, or an id that is not one.
 * A form without the radio group (typed input only) is the typed path.
 */
export type RecipientChoice =
  | { kind: 'id'; recipientAddressId: string }
  | { kind: 'typed'; recipientAddress: string }
  | { kind: 'bad_id' };

export function recipientChoiceOf(formData: FormData): RecipientChoice {
  const raw = formData.get(RECIPIENT_CHOICE_FIELD);
  const choice = typeof raw === 'string' ? raw.trim() : '';
  if (choice.length === 0 || choice === TYPED_RECIPIENT) {
    const typed = formData.get('recipientAddress');
    return { kind: 'typed', recipientAddress: typeof typed === 'string' ? typed.trim() : '' };
  }
  return isUuidLike(choice) ? { kind: 'id', recipientAddressId: choice } : { kind: 'bad_id' };
}

export const RECIPIENT_CHOICE_INVALID_MESSAGE = '選んだ送信先を読み取れませんでした。画面を再読み込みして、送信先を選び直してください。';

/** One answered address, or null when the shape is not the contract's. */
function addressOf(value: unknown): MakerRecipientAddressView | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!isUuidLike(row.id) || typeof row.email !== 'string' || row.email.length === 0) return null;
  return {
    id: row.id,
    email: row.email,
    label: typeof row.label === 'string' && row.label.length > 0 ? row.label : null,
    isDefault: row.isDefault === true,
    isActive: row.isActive !== false,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null
  };
}

/** One answered maker (its addresses in the answered order, malformed rows dropped). */
export function makerOf(value: unknown): MakerAccountView | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!isUuidLike(row.id) || typeof row.name !== 'string') return null;
  const addresses = Array.isArray(row.recipientAddresses) ? row.recipientAddresses : [];
  return {
    id: row.id,
    name: row.name,
    externalCode: typeof row.externalCode === 'string' && row.externalCode.length > 0 ? row.externalCode : null,
    isActive: row.isActive !== false,
    recipientAddresses: addresses.map(addressOf).filter((address): address is MakerRecipientAddressView => address !== null)
  };
}

/**
 * The recipient choices of one project's maker PO form:
 * - list: the maker's usable addresses, the default first (preselected);
 * - no_maker / no_addresses / unreadable: the typed address only, with the reason;
 * - not_loaded: the screen did not read the list (typed address only, no reason line).
 */
export type RecipientChoices =
  | { kind: 'list'; makerName: string; addresses: MakerRecipientAddressView[] }
  | { kind: 'no_maker' }
  | { kind: 'no_addresses'; makerName: string }
  | { kind: 'unreadable'; error: string }
  | { kind: 'not_loaded' };

/** Pure: the GET …/maker-recipient-addresses answer as choices (only active addresses, default first). */
export function recipientChoicesFrom(data: unknown): RecipientChoices {
  if (typeof data !== 'object' || data === null || !('maker' in data)) {
    return { kind: 'unreadable', error: '送信先の一覧の形式を読み取れませんでした' };
  }
  const raw = (data as { maker: unknown }).maker;
  if (raw === null) return { kind: 'no_maker' };
  const maker = makerOf(raw);
  if (!maker) return { kind: 'unreadable', error: '送信先の一覧の形式を読み取れませんでした' };
  const usable = maker.recipientAddresses.filter((address) => address.isActive);
  if (usable.length === 0) return { kind: 'no_addresses', makerName: maker.name };
  // The API answers the default first; kept stable here for any other order.
  const ordered = [...usable.filter((address) => address.isDefault), ...usable.filter((address) => !address.isDefault)];
  return { kind: 'list', makerName: maker.name, addresses: ordered };
}

/** The project's recipient choices (admin and the assigned staff may read them; the API decides). */
export async function loadMakerRecipients(projectId: string): Promise<RecipientChoices> {
  try {
    const result = await callApi<unknown>(`/api/projects/${encodeURIComponent(projectId)}/maker-recipient-addresses`);
    if (!result.ok) return { kind: 'unreadable', error: result.error ?? '送信先の一覧を取得できませんでした' };
    return recipientChoicesFrom(result.data);
  } catch {
    return { kind: 'unreadable', error: '送信先の一覧を取得できませんでした' };
  }
}

export type MakerAccountsRead =
  | { kind: 'ok'; makers: MakerAccountView[] }
  | { kind: 'forbidden' }
  | { kind: 'error'; error: string };

/** The company-wide maker master (admin only; 403 is a notice, never data). */
export async function loadMakerAccounts(): Promise<MakerAccountsRead> {
  try {
    const result = await callApi<{ makers?: unknown }>('/api/maker-accounts');
    if (result.status === 403) return { kind: 'forbidden' };
    if (!result.ok) return { kind: 'error', error: result.error ?? 'メーカーの一覧を取得できませんでした' };
    const makers = Array.isArray(result.data?.makers) ? result.data.makers : null;
    if (!makers) return { kind: 'error', error: 'メーカーの一覧の形式を読み取れませんでした' };
    return { kind: 'ok', makers: makers.map(makerOf).filter((maker): maker is MakerAccountView => maker !== null) };
  } catch {
    return { kind: 'error', error: 'メーカーの一覧を取得できませんでした' };
  }
}

/** P2: on /makers a DUPLICATE is a name or an e-mail, never a number (the dictionary's 「この番号は…」 does not fit). */
export const MAKER_NAME_DUPLICATE_MESSAGE = 'この名前のメーカーはすでに登録されています。一覧で確認してください。';
export const RECIPIENT_DUPLICATE_MESSAGE = 'このメールアドレスは、このメーカーの宛先にすでに登録されています。一覧で確認してください。';
