'use server';

import { revalidatePath } from 'next/cache';
import { callApi } from '../../lib/api';
import { recordIdOf, refreshesListOn, refusalState } from '../../lib/action-result';
import { RECIPIENT_EMAIL_INVALID_MESSAGE } from '../../lib/form-messages';
import { isUuidLike } from '../../lib/maker-master';
import { idempotencyKeyOf } from '../../lib/project-context';
import type { ActionState } from '../../lib/types';

/**
 * P2 R33 (contract v1.2 §4): the representative's メーカーの宛先 page — add a
 * maker, add an address, make one the default, stop or resume one. No delete.
 *
 * These writes belong to no project (the master is company-wide, the page lives
 * outside /p/{案件}/), so they carry no rendered project and no
 * X-Kanei-Expected-Project: refuseIfProjectSwitched is for project writes and
 * would refuse every form here (the root layout renders project ''). The API is
 * the gate — admin only (403 CEO_ONLY otherwise); the web checks only the shape
 * of what it sends. Every write forwards the form's Idempotency-Key.
 */

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

const missing = (message: string): ActionState => ({ ok: false, message });

/** P0 R10: the same e-mail shape the maker PO's typed recipient is checked with. */
function isEmailAddress(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(value);
}

async function send(formData: FormData, method: 'POST' | 'PATCH', path: string, body: unknown, success: string): Promise<ActionState> {
  const result = await callApi(path, { method, body, idempotencyKey: idempotencyKeyOf(formData) });
  if (result.ok) {
    revalidatePath('/makers');
    return { ok: true, message: success, changedId: recordIdOf(result.data) };
  }
  // P2 R05: the earlier submit with this key may be stored — the list is read again.
  if (refreshesListOn(result.code)) revalidatePath('/makers');
  // The dictionary's words (DUPLICATE, MAKER_*_INVALID, *_NOT_FOUND, CEO_ONLY …).
  return refusalState(result);
}

export async function createMakerAccountAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const name = field(formData, 'name');
  const externalCode = field(formData, 'externalCode');
  if (name.length === 0) return missing('メーカーの名前を入力してください。');
  if (name.length > 200) return missing('メーカーの名前は200文字までです。');
  if (externalCode.length > 64) return missing('取引先コードは64文字までです。');
  return send(
    formData,
    'POST',
    '/api/maker-accounts',
    externalCode.length > 0 ? { name, externalCode } : { name },
    `メーカー「${name}」を追加しました。`
  );
}

export async function addRecipientAddressAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const accountId = field(formData, 'accountId');
  const email = field(formData, 'email');
  const label = field(formData, 'label');
  if (!isUuidLike(accountId)) return missing('メーカーを読み取れませんでした。画面を再読み込みしてください。');
  if (email.length === 0) return missing('メールアドレスを入力してください。');
  if (!isEmailAddress(email)) return missing(RECIPIENT_EMAIL_INVALID_MESSAGE);
  if (label.length > 100) return missing('表示名は100文字までです。');
  const body: Record<string, unknown> = { email, isDefault: formData.get('isDefault') === 'on' };
  if (label.length > 0) body.label = label;
  return send(
    formData,
    'POST',
    `/api/maker-accounts/${encodeURIComponent(accountId)}/recipient-addresses`,
    body,
    body.isDefault ? '宛先を追加し、既定にしました。これまでの既定は外れます。' : '宛先を追加しました。'
  );
}

const ADDRESS_CHANGES: Readonly<Record<string, { body: Record<string, boolean>; success: string }>> = {
  default: { body: { isDefault: true }, success: '既定を変更しました。これまでの既定は外れます。' },
  deactivate: { body: { isActive: false }, success: '宛先の使用を止めました（既定だった場合は既定もなくなります）。' },
  reactivate: { body: { isActive: true }, success: '宛先の使用を再開しました。' }
};

export async function updateRecipientAddressAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const addressId = field(formData, 'addressId');
  const change = ADDRESS_CHANGES[field(formData, 'change')];
  if (!isUuidLike(addressId)) return missing('宛先を読み取れませんでした。画面を再読み込みしてください。');
  if (!change) return missing('変更の内容を読み取れませんでした。画面を再読み込みしてください。');
  return send(formData, 'PATCH', `/api/maker-recipient-addresses/${encodeURIComponent(addressId)}`, change.body, change.success);
}
