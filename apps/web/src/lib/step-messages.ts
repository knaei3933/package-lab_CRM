import type { ActionState } from './types';

/**
 * P1 R21: refusals of a step write that need the step's own words (the rest
 * come from the error dictionary by code, P0 R09). Each says what happened and
 * the one way forward; no enum, no English.
 */
export function STEP_REFUSALS(code: string | null): ActionState | null {
  switch (code) {
    case 'CHANGE_REQUEST_ORGANIZATION_REQUIRED':
      return {
        ok: false,
        message: 'このデザインには承認の記録があるため、新しい校正は「変更依頼」として登録します。承認一覧の画面で、依頼した組織・理由・証憑を入力して登録してください。'
      };
    default:
      return null;
  }
}

/** P4 H14: said when the uploader may not confirm on their own evidence (P-4, SELF_VERIFICATION_FORBIDDEN). */
export const RECEIPT_WAITS_FOR_REPRESENTATIVE = '登録した人は自分の証跡で納品を確認できないため、代表が確認します（代表の承認箱に「納品の確認」として出ます）。';
