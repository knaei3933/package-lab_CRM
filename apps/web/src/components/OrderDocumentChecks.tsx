import { ActionForm } from './ActionForm';
import { SelectField, TextField } from './fields';
import { verifyDocumentAction } from '../app/actions';
import type { DocumentView, FilmSupplyOrderView, SevenPurchaseOrderView } from '../lib/project-data';
import { isOwnDocumentOfStaff, SELF_VERIFICATION_NOTICE } from '../lib/self-verification';
import { DOCUMENT_TYPE_LABELS, formatTimestamp, VERIFICATION_STATUS_LABELS } from '../lib/vocabulary';

/**
 * P4 §0: the 「確認を記録する」 of the old 文書 table, for the documents of ONE order —
 * the order's own files and its セブン化学発注書's files — that are not checked yet.
 * Same server action (POST /api/documents/:id/verify). A send record's mail is
 * checked by its own send verification (step 9) and an approval evidence by step 6's
 * manual check, so neither is listed here.
 * P-4: staff never check a document they registered (the API refuses it too).
 */
/** Checked by their own step: the send mail (step 9) and the approval evidence (step 6's manual check). */
const SEPARATELY_CHECKED: ReadonlySet<string> = new Set(['send_evidence', 'approval_evidence']);

export function orderDocumentsToCheck(
  documents: readonly DocumentView[],
  order: Pick<FilmSupplyOrderView, 'id'>,
  po: Pick<SevenPurchaseOrderView, 'id'> | null
): DocumentView[] {
  return documents.filter((document) => !document.verificationHidden
    && document.verificationStatus !== 'verified'
    && !SEPARATELY_CHECKED.has(document.documentType)
    && (document.filmSupplyOrderId === order.id
      || (po !== null && document.filmSupplyOrderId === null && document.sevenPurchaseOrderId === po.id)));
}

const RESULT_CHOICES = [
  { value: 'verified', label: VERIFICATION_STATUS_LABELS.verified ?? '確認済み' },
  { value: 'mismatch', label: VERIFICATION_STATUS_LABELS.mismatch ?? '相違あり' }
];

export function OrderDocumentChecks({
  documents,
  role,
  userId,
  orderCode
}: {
  documents: readonly DocumentView[];
  role: string | null;
  userId: string | null;
  orderCode: string;
}) {
  return (
    <ul className="p4w2-doc-checks" aria-label={`${orderCode} の未確認の書類`}>
      {documents.map((document) => (
        <li key={document.id} className="p4w2-doc-check">
          <p>
            <span translate="no">{document.filename}</span>
            <span className="p1-muted-inline">
              {' '}{DOCUMENT_TYPE_LABELS[document.documentType as keyof typeof DOCUMENT_TYPE_LABELS] ?? document.documentType}
              {document.designKey ? `・デザイン ${document.designKey}` : ''}
              ・{VERIFICATION_STATUS_LABELS[document.verificationStatus] ?? document.verificationStatus}
              ・登録 {formatTimestamp(document.createdAt)}
            </span>
          </p>
          {isOwnDocumentOfStaff(role, userId, document) ? (
            <p className="ui-note">{SELF_VERIFICATION_NOTICE}</p>
          ) : (
            <ActionForm
              action={verifyDocumentAction}
              submitLabel="確認を記録する"
              submitContext={`${orderCode}・${document.filename}`}
              hint="確認結果は書類ごとに上書き記録されます（実施者と日時も記録されます）。"
              confirm={{
                title: '書類の確認結果を記録しますか？',
                body: `「${document.filename}」の確認結果を記録します。前の確認結果は上書きされ、実施者と日時が記録されます。`,
                summaryFields: ['verificationStatus', 'verificationNote']
              }}
            >
              <input type="hidden" readOnly name="documentId" value={document.id} />
              <SelectField name="verificationStatus" label="確認結果" required includeBlank blankLabel="（選ぶ）" choices={RESULT_CHOICES} width={220} />
              <TextField name="verificationNote" label="確認メモ（任意）" width={320} />
            </ActionForm>
          )}
        </li>
      ))}
    </ul>
  );
}
