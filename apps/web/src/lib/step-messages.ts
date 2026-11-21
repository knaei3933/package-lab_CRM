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
