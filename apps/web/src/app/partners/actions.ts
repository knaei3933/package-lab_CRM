'use server';

import { revalidatePath } from 'next/cache';
import { callApi } from '../../lib/api';
import { recordIdOf, refreshesListOn, refusalState } from '../../lib/action-result';
import { isContactEmail, isPartnerAccountId } from '../../lib/partner-contacts';
import { idempotencyKeyOf } from '../../lib/project-context';
import type { ActionState } from '../../lib/types';

/**
 * P5 R5: the representative's 取引先の連絡先 — set or clear the registered
 * contact address of one customer / セブン化学 account (PATCH
 * /api/partner-accounts/:id/contact-email). Like /makers this write belongs to
 * no project (no rendered project, no X-Kanei-Expected-Project); the API is the
 * gate — admin only (403 CEO_ONLY otherwise) — and writes the audit row. The
 * form's Idempotency-Key is forwarded.
 */

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

const missing = (message: string): ActionState => ({ ok: false, message });

export async function updatePartnerContactEmailAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const accountId = field(formData, 'accountId');
  const clear = field(formData, 'clear') === 'yes';
  const email = field(formData, 'contactEmail');
  if (!isPartnerAccountId(accountId)) return missing('取引先を読み取れませんでした。画面を再読み込みしてください。');
  if (!clear && email.length === 0) return missing('メールアドレスを入力してください。消すときは「連絡先を消す」を使います。');
  if (!clear && !isContactEmail(email)) return missing('連絡先はメールアドレスの形式で入力してください（例: approvals@customer.example.jp）。');
  const result = await callApi(`/api/partner-accounts/${encodeURIComponent(accountId)}/contact-email`, {
    method: 'PATCH',
    body: { contactEmail: clear ? null : email },
    idempotencyKey: idempotencyKeyOf(formData)
  });
  if (result.ok) {
    revalidatePath('/partners');
    const changed = (result.data as { changed?: unknown } | null)?.changed !== false;
    return {
      ok: true,
      message: clear
        ? '連絡先を消しました。この取引先のメールの差出人は照合されなくなります。'
        : changed ? `連絡先を ${email.toLowerCase()} にしました。これからの承認メールの差出人はこのドメインと照合します。` : '同じ連絡先がすでに登録されています（変更なし）。',
      changedId: recordIdOf(result.data)
    };
  }
  if (refreshesListOn(result.code)) revalidatePath('/partners');
  return refusalState(result);
}
