'use client';

import { useEffect, useRef, useState } from 'react';
import { draftKey, draftValues, markDirty } from '../lib/unsaved-guard';

/**
 * P1 R34 (M9): a long form keeps a draft in sessionStorage while it is typed
 * (key: the screen path — 案件・発注 are in it — and the form's name). Opening
 * the screen again restores it with 「前回の入力を復元しました」 and a 破棄
 * button. A successful submit (the form's reset) drops the draft. Storage that
 * is blocked or full is ignored: the form works the same without it. Only
 * plain, uncontrolled fields are kept (no hidden keys, files or passwords).
 */
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function controlsOf(form: HTMLFormElement): Control[] {
  return [...form.elements].filter((element): element is Control =>
    element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement);
}

function read(key: string): Record<string, string> | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

function write(key: string, values: Record<string, string> | null): void {
  try {
    if (values && Object.keys(values).length > 0) window.sessionStorage.setItem(key, JSON.stringify(values));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Blocked or full storage: no draft, the form still works.
  }
}

/** P4 N15: asked before the restored draft is thrown away. */
export const DISCARD_CONFIRM_MESSAGE = '復元した入力を破棄します。元に戻せません。破棄しますか？';

export function DraftAutosave({ name }: { name: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [restored, setRestored] = useState(false);
  const keyRef = useRef('');

  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form) return undefined;
    const key = draftKey(window.location.pathname, name);
    keyRef.current = key;
    const saved = read(key);
    if (saved) {
      let applied = 0;
      for (const control of controlsOf(form)) {
        const value = saved[control.name];
        if (value === undefined || control.type === 'hidden' || control.type === 'file') continue;
        if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
          control.checked = control.value === value || value === 'on';
        } else {
          control.value = value;
        }
        applied += 1;
      }
      if (applied > 0) {
        setRestored(true);
        markDirty(form, true);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        write(key, draftValues(controlsOf(form).map((control) => ({
          name: control.name,
          type: control instanceof HTMLSelectElement ? 'select' : control instanceof HTMLTextAreaElement ? 'textarea' : control.type,
          value: control.value,
          checked: control instanceof HTMLInputElement ? control.checked : false
        }))));
      }, 400);
    };
    const drop = () => {
      if (timer) clearTimeout(timer);
      write(key, null);
      setRestored(false);
    };
    form.addEventListener('input', save);
    form.addEventListener('change', save);
    form.addEventListener('reset', drop);
    return () => {
      if (timer) clearTimeout(timer);
      form.removeEventListener('input', save);
      form.removeEventListener('change', save);
      form.removeEventListener('reset', drop);
    };
  }, [name]);

  function discard(): void {
    // P4 N15: 「破棄」 deletes what was typed — asked first (it used to delete at once).
    if (!window.confirm(DISCARD_CONFIRM_MESSAGE)) return;
    const form = anchor.current?.closest('form');
    write(keyRef.current, null);
    setRestored(false);
    if (form) {
      form.reset();
      markDirty(form, false);
    }
  }

  return (
    <span ref={anchor} className="p1-draft-anchor">
      {restored ? (
        <span className="p1-draft" role="status">
          前回の入力を復元しました
          <button type="button" className="p1-link-button" onClick={discard}>破棄</button>
        </span>
      ) : null}
    </span>
  );
}
