import { revalidatePath } from 'next/cache';
import { callApi } from './api';
import { isSettledRefusal, recordIdOf, refreshesListOn, refusalState } from './action-result';
import { idempotencyKeyOf } from './project-context';
import { writeProjectOf } from './project-guard';
import type { ActionState } from './types';

/**
 * P1 R21–R23 (web half): one submit of a step panel may need several API
 * writes that the operator used to send one by one (upload the proof → register
 * the 版 → 校正準備完了 → 校了確認待ち). They are sent here in order, each a
 * normal API call the API checks on its own — no rule is skipped or relaxed
 * (承認済みサーバー規則: 段階の飛ばしは API が拒否する). This is the contract
 * adapter for the server-side automatic transitions (R23, p1/server): when the
 * API does them itself, the chain shrinks to its first write.
 *
 * Idempotency (P0 R05, review H1/NM1): every write carries `${formKey}.${n}`.
 * When a later write fails, the earlier ones are stored, so the result is NOT
 * settled — the form keeps its key and a retry replays the stored writes (the
 * API answers them from its 24h store) and runs the failed one again. A failure
 * of the first write follows the usual rule (an answered 4xx renews the key).
 */
export interface ChainRequest {
  path: string;
  method?: 'POST' | 'PATCH';
  body?: unknown;
}

export interface ChainStep {
  /** The step's name in the operator's words (「校正ファイルの登録」). */
  label: string;
  /**
   * Contract adapter (p1-server API_CONTRACT §1-2): when the API refuses this
   * write with one of these codes, the alternative request is sent instead —
   * e.g. a manual transition the server now makes itself (AUTO_TRANSITION_ONLY)
   * becomes POST …/auto-advance. Null: no alternative, the refusal stands.
   */
  fallback?: { codes: readonly string[]; request: (answers: readonly unknown[]) => ChainRequest | null } | undefined;
  /**
   * The request, from the earlier answers; null skips the step (already done);
   * MISSING_ANSWER when an earlier answer lacks what this one needs (nothing is sent).
   */
  request: (answers: readonly unknown[]) => ChainRequest | null | typeof MISSING_ANSWER;
}

export interface ChainOptions {
  /** The success line; a function reads the answers (P4 H7②: the order code the server numbered). */
  success: string | ((answers: readonly unknown[]) => string);
  /** P4 H7②: receives the answers of the chain (the caller reads what the server created). */
  answersOut?: unknown[] | undefined;
  link?: ActionState['link'];
  /** P4 N3: the id of the record the chain had already written when it stopped (from the answers so far). */
  partialId?: ((answers: readonly unknown[]) => string | null) | undefined;
  /** Maps a refusal of one step to the operator's words (else the dictionary text). */
  refusal?: (code: string | null, stepIndex: number, data?: unknown) => ActionState | null;
}

export const CHAIN_KEY_SEPARATOR = '.';

/** A step whose input (an id from an earlier answer) is not there. */
export const MISSING_ANSWER = 'missing-answer' as const;

export const MISSING_ANSWER_MESSAGE = '前の手順の結果を読み取れませんでした。画面を再読み込みして、記録された内容を確認してください。';

/** The request built from an earlier answer's id, or MISSING_ANSWER when it is absent. */
export function withAnswer(value: string | null, build: (value: string) => ChainRequest): ChainRequest | typeof MISSING_ANSWER {
  return value ? build(value) : MISSING_ANSWER;
}

/** The derived key of the n-th write (1-based); undefined without a form key. */
export function chainKey(formKey: string | undefined, index: number): string | undefined {
  if (!formKey) return undefined;
  const key = `${formKey}${CHAIN_KEY_SEPARATOR}${index + 1}`;
  return key.length <= 128 ? key : undefined;
}

function codeOf(data: unknown): string | null {
  return typeof data === 'object' && data !== null && typeof (data as { code?: unknown }).code === 'string'
    ? (data as { code: string }).code
    : null;
}

export async function runChain(formData: FormData, steps: readonly ChainStep[], options: ChainOptions): Promise<ActionState> {
  const formKey = idempotencyKeyOf(formData);
  const answers: unknown[] = [];
  let written = 0;
  let lastId: string | null = null;
  for (const [index, step] of steps.entries()) {
    const request = step.request(answers);
    if (request === null) {
      answers.push(null);
      continue;
    }
    if (request === MISSING_ANSWER) {
      revalidatePath('/', 'layout');
      return {
        ok: false,
        message: written > 0 ? `「${step.label}」で止まりました（その前の手順は記録済みです）。${MISSING_ANSWER_MESSAGE}` : MISSING_ANSWER_MESSAGE,
        settled: false
      };
    }
    let result = await callApi(request.path, {
      method: request.method ?? 'POST',
      body: request.body,
      idempotencyKey: chainKey(formKey, index),
      expectedProjectId: writeProjectOf(formData)
    });
    const alternative = !result.ok && step.fallback && step.fallback.codes.includes(codeOf(result.data) ?? '')
      ? step.fallback.request(answers)
      : null;
    if (alternative) {
      result = await callApi(alternative.path, {
        method: alternative.method ?? 'POST',
        body: alternative.body,
        idempotencyKey: chainKey(formKey, index) ? `${chainKey(formKey, index)}a` : undefined,
        expectedProjectId: writeProjectOf(formData)
      });
    }
    if (!result.ok) {
      if (written > 0 || refreshesListOn(result.code)) revalidatePath('/', 'layout');
      const specific = options.refusal?.(codeOf(result.data), index, result.data) ?? null;
      const base = specific ?? refusalState(result);
      const prefix = written > 0
        ? `「${step.label}」で止まりました（その前の手順は記録済みです）。`
        : '';
      return {
        ...base,
        message: `${prefix}${base.message}`,
        code: base.code ?? result.code ?? null,
        // A partly stored chain is never settled: the same key replays what was stored.
        settled: written > 0 ? false : (specific ? isSettledRefusal(result) : base.settled),
        ...(options.partialId && written > 0 ? { partialPoId: options.partialId(answers) } : {})
      };
    }
    answers.push(result.data);
    written += 1;
    lastId = recordIdOf(result.data) ?? lastId;
  }
  revalidatePath('/', 'layout');
  if (options.answersOut) options.answersOut.push(...answers);
  return {
    ok: true,
    message: typeof options.success === 'function' ? options.success(answers) : options.success,
    changedId: lastId,
    link: options.link ?? null
  };
}

/** The id of a document version in an upload answer ({ document, version }). */
export function uploadedVersionId(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const version = (answer as { version?: { id?: unknown } }).version;
  return typeof version?.id === 'string' ? version.id : null;
}

/** The id of a created record in an answer ({ revision }, { purchaseOrder }, { id } …). */
export function answerId(answer: unknown): string | null {
  return recordIdOf(answer);
}

/**
 * The order status an answer reports after the API's own automatic transitions
 * (p1-server API_CONTRACT §1-4: `status` / `orderStatus` with `autoAdvanced`).
 * Null when the answer does not say (the current API: the step is then sent).
 */
export function answeredOrderStatus(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const record = answer as { status?: unknown; orderStatus?: unknown; autoAdvanced?: unknown };
  if (!Array.isArray(record.autoAdvanced)) return null;
  const status = typeof record.orderStatus === 'string' ? record.orderStatus : record.status;
  return typeof status === 'string' ? status : null;
}

/** States a step needs to reach, in flow order (for "already there or beyond"). */
const FLOW_ORDER = ['DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY'];

/** Whether an answered status is already at (or past) the target: the manual transition is then skipped. */
export function alreadyAt(answered: string | null, target: string): boolean {
  if (answered === null) return false;
  const at = FLOW_ORDER.indexOf(answered);
  const want = FLOW_ORDER.indexOf(target);
  return at !== -1 && want !== -1 && at >= want;
}

/** The contract's auto-advance call for a transition the server makes itself (AUTO_TRANSITION_ONLY). */
export function autoAdvanceRequest(orderId: string, projectId: string | null): ChainRequest {
  return {
    path: `/api/film-supply-orders/${encodeURIComponent(orderId)}/auto-advance`,
    body: projectId ? { expectedProjectId: projectId } : {}
  };
}

export const AUTO_TRANSITION_CODES = ['AUTO_TRANSITION_ONLY'] as const;
