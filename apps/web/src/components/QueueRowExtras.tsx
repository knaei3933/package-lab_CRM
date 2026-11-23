import { Bilingual } from './Bilingual';
import { queueDueText } from '../lib/representative-queue';
import type { RepresentativeTask } from '../lib/representative-queue';
import { ISSUER_DECLARED_LABEL, senderStatusText } from '../lib/sender-check';
import { ISSUER_ENTITY_LABELS } from '../lib/vocabulary';

/**
 * P4 M18 / N4: what an 承認箱 row adds to its title — 希望納期 and the days left, and for an
 * 承認証跡の確認 row the evidence itself: file name, From address, who uploaded it, and the server's sender
 * warnings. The issuer label says the issuer is the registrant's declaration, not read from the file.
 */
export function QueueRowExtras({ task, now }: { task: RepresentativeTask; now: Date }) {
  const due = queueDueText(task, now);
  const evidence = task.evidence ?? null;
  const warnings = task.warnings ?? [];
  const statusText = senderStatusText(evidence?.senderStatus ?? null);
  const reason = task.manualCheckReason ?? null;
  if (!due && !evidence && warnings.length === 0 && !reason) return null;
  return (
    // One full-width line under the row (the row's own grid has four narrow cells).
    <div className="p4-inbox-extra">
      {due ? (
        <p className={`p4-inbox-line p4-inbox-due${due.late ? ' p4-inbox-due--late' : ''}`} data-due={due.late ? 'late' : 'ok'}>
          {due.late ? <span aria-hidden="true">⚠ </span> : null}{due.text}
        </p>
      ) : null}
      {reason ? (
        // N4(b) (2026-11-23): why this row waits for the representative — e.g. a mail from another domain.
        <p className="p4-inbox-line p5-inbox-reason" data-reason="">
          確認が必要な理由: {reason}
        </p>
      ) : null}
      {evidence ? (
        <p className="p4-inbox-line p4-inbox-evidence" data-evidence="">
          {/* web2b review L-3: the declared value itself, then what a declaration is. */}
          {ISSUER_DECLARED_LABEL}: {evidence.issuerEntity ? ISSUER_ENTITY_LABELS[evidence.issuerEntity as keyof typeof ISSUER_ENTITY_LABELS] ?? '不明' : '記録なし'}
          <span className="p1-muted-inline">（登録した人の申告で、ファイルの中身から確かめたものではありません）</span>{' '}
          {evidence.filename ? <>ファイル <span translate="no">{evidence.filename}</span></> : null}
          {/* web2b review L-2: with several From lines the server keeps the first one — said so. */}
          {evidence.fromAddress ? <> ・ {evidence.senderStatus === 'multiple_from' ? '差出人（1件目）' : '差出人'} <span translate="no">{evidence.fromAddress}</span></> : null}
          {evidence.uploadedBy ? <> ・ 登録した人 {evidence.uploadedBy}</> : null}
          {statusText ? <> ・ <Bilingual ja={statusText.ja} ko={statusText.ko} /></> : null}
        </p>
      ) : null}
      {warnings.map((warning) => (
        <p key={warning.code} className="field-warning p4-inbox-line" role="note" data-warning={warning.code}>
          <span aria-hidden="true">⚠</span> <Bilingual ja={warning.ja} ko={warning.ko ?? ''} />
        </p>
      ))}
    </div>
  );
}
