/**
 * P2 R05 (contract v1.2 §1): the fixed lines next to the two durable-key answers.
 * Client-safe (the form shell renders them). The dictionary sentence of each code
 * (lib/error-dictionary-data) stays the first line; these say what to do next.
 */

/** IDEMPOTENCY_OUTCOME_UNKNOWN — the conductor's wording (2026-11-21 brief). */
export const OUTCOME_UNKNOWN_LINE = '処理結果が確認できません。一覧で確認してください。';

/** The button that ends the check and allows a new submit (a new key). */
export const OUTCOME_UNKNOWN_CHECKED_LABEL = '一覧を確認しました（記録されていなければ、新しい入力として送信できるようにする）';

/** IDEMPOTENCY_IN_PROGRESS — keep the input as it is and send it again a little later. */
export const IN_PROGRESS_HINT = '入力はそのままにして、少し待ってから同じボタンをもう一度押してください（二重に記録されることはありません）。';
