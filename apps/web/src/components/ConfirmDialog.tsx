'use client';

import { useEffect, useId, useRef } from 'react';

export interface ConfirmSummaryItem {
  label: string;
  value: string;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  summary: readonly ConfirmSummaryItem[];
  confirmLabel: string;
  tone?: 'primary' | 'danger' | undefined;
  onConfirm: () => void;
  /** Esc, the キャンセル button, or any other close. */
  onCancel: () => void;
}

/**
 * UI batch C (1-③): the confirmation before a consequential record. A native
 * <dialog> opened with showModal() — the browser supplies the focus trap, Esc
 * and the inert page behind it. キャンセル takes focus first, so Enter never
 * confirms by accident. The closed element stays in the markup (hidden by the
 * browser) so the form keeps one stable tree.
 */
export function ConfirmDialog({ open, title, body, summary, confirmLabel, tone = 'primary', onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={tone === 'danger' ? 'confirm-dialog confirm-dialog--danger' : 'confirm-dialog'}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={() => {
        if (open) onCancel();
      }}
    >
      <div className="confirm-dialog-body">
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId} className="confirm-dialog-text">
          {body}
        </p>
        {summary.length > 0 ? (
          <dl className="confirm-dialog-summary">
            {summary.map((item, index) => (
              <div key={`${item.label}-${index}`}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="ui-button--subtle" onClick={onCancel}>
            キャンセル
          </button>
          <button type="button" className={tone === 'danger' ? 'ui-button--danger' : 'ui-button'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
