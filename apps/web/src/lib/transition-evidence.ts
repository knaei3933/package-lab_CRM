import type { FilmSupplyOrderView, Workspace } from './project-data';

/**
 * UI batch E (F-06): the evidence a state stands for — デザイン受領 for a bound
 * document, 校正ゲラ準備完了 for a proof revision, フィルム納品完了 for a
 * recorded delivery. The API does not check it today (a policy decision for
 * the representative), so the screen only warns and asks for a confirming
 * reason before such a transition; it never blocks. A gap is claimed only
 * when the workspace shows the evidence is missing — evidence the role may not
 * see (withheld links) is never called missing.
 */
export interface EvidenceGap {
  /** The transition target the evidence belongs to. */
  target: string;
  /** What is missing, in one sentence. */
  message: string;
}

export const EVIDENCE_GAP_SUFFIX = '証跡がないまま進めると、画面の状態と実物の証跡が食い違います。';

export const EVIDENCE_NOTE_FIELD = 'evidenceNote';

export function evidenceGapsFor(
  order: Pick<FilmSupplyOrderView, 'id'>,
  workspace: Pick<Workspace, 'documents' | 'revisions' | 'revisionsWithheld' | 'deliveries'>,
  targets: readonly string[]
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  if (targets.includes('ARTWORK_RECEIVED')
    && !workspace.documents.some((document) => document.filmSupplyOrderId === order.id)) {
    gaps.push({
      target: 'ARTWORK_RECEIVED',
      message: 'この発注に紐付いた書類（デザイン入稿データ）が、文書画面にまだ登録されていません。'
    });
  }
  if (targets.includes('PROOF_READY')
    && workspace.revisionsWithheld === 0
    && !workspace.revisions.some((revision) => revision.filmSupplyOrderId === order.id)) {
    gaps.push({
      target: 'PROOF_READY',
      message: 'この発注の校正ゲラの版が、承認画面にまだ登録されていません。'
    });
  }
  const deliveryUnknown = workspace.deliveries.some((delivery) => delivery.orderId === null && delivery.detailsHidden);
  if (targets.includes('FILM_DELIVERED')
    && !deliveryUnknown
    && !workspace.deliveries.some((delivery) => delivery.kind === 'film' && delivery.orderId === order.id)) {
    gaps.push({
      target: 'FILM_DELIVERED',
      message: 'この発注の納品が、納品確認画面にまだ記録されていません。'
    });
  }
  return gaps;
}
