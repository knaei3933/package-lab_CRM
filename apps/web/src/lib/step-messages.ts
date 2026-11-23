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
    case DELIVERY_EVIDENCE_BOUND_CODE:
      return deliveryEvidenceBoundState({ alternativeBelow: true });
    default:
      return null;
  }
}

/**
 * p4/web4 (server2 §11-2 / §12-2): 422 DELIVERY_EVIDENCE_MAKER_PO_BOUND — the cited receipt is the maker's
 * 受領書 (tied to the maker paper) or a byte-identical copy of it, so it cannot confirm a delivery. The
 * way forward is the customer's own receipt: it is registered first and then cited. The order screen has the
 * form for it right below (`alternativeBelow`); the old filling list sends the operator to the 文書 screen.
 */
export const DELIVERY_EVIDENCE_BOUND_CODE = 'DELIVERY_EVIDENCE_MAKER_PO_BOUND';
/** The anchor of the order screen's 「別の受領証跡」 form (an <a href> inside the refusal opens it). */
export const ALTERNATIVE_RECEIPT_ANCHOR = 'receipt-alternative';

export function deliveryEvidenceBoundState(options: { alternativeBelow: boolean }): ActionState {
  const way = options.alternativeBelow
    ? '下の「お客様の受領証跡を登録して確認する」から、お客様から受け取った納品受領の証跡（受領書・受領メール）を登録してください。'
    : '文書の画面で、お客様から受け取った納品受領の証跡（受領書・受領メール）を登録し、確認済みにしてから選び直してください。';
  const wayKo = options.alternativeBelow
    ? '아래 「고객 수령 증빙을 등록하고 확인」에서 고객에게서 받은 납품 수령 증빙(수령서·수령 메일)을 등록하세요.'
    : '문서 화면에서 고객에게서 받은 납품 수령 증빙(수령서·수령 메일)을 등록하고 확인 완료로 한 뒤 다시 선택하세요.';
  return {
    ok: false,
    code: DELIVERY_EVIDENCE_BOUND_CODE,
    message: `選んだ受領証跡は、メーカー発注書の受領書（またはその写し）と同じ内容のため、納品の確認には使えません。${way}`,
    messageKo: `선택한 수령 증빙은 메이커 발주서의 수령서(또는 그 사본)와 같은 내용이라 납품 확인에 쓸 수 없습니다. ${wayKo}`,
    ...(options.alternativeBelow ? { link: { href: `#${ALTERNATIVE_RECEIPT_ANCHOR}`, label: 'お客様の受領証跡を登録する' } } : {})
  };
}

/** P4 H14: said when the uploader may not confirm on their own evidence (P-4, SELF_VERIFICATION_FORBIDDEN). */
export const RECEIPT_WAITS_FOR_REPRESENTATIVE = '登録した人は自分の証跡で納品を確認できないため、代表が確認します（代表の承認箱に「納品の確認」として出ます）。';
