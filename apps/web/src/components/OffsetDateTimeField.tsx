'use client';

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { datetimeLocalToIso } from '../lib/datetime';
import { inputStyle, noteStyle } from '../lib/ui';

interface OffsetDateTimeFieldProps {
  /** The form/API field name carrying the explicit-offset value. */
  name: string;
  label: string;
  required?: boolean | undefined;
  hint?: string | undefined;
  defaultValue?: string | undefined;
  width?: number | undefined;
}

/**
 * Shows datetime-local to the operator while submits carry UTC ISO. The visible
 * field uses `...Local` so the browser cannot submit an ambiguous duplicate.
 */
export function OffsetDateTimeField({
  name,
  label,
  required,
  hint,
  defaultValue,
  width = 240
}: OffsetDateTimeFieldProps) {
  const [localValue, setLocalValue] = useState(defaultValue ?? '');
  // SSR must not convert a naive default using the server timezone. Keep the
  // hidden field empty until mounted; a pre-hydration submit uses the action's
  // Local fallback, which has explicit Asia/Tokyo semantics.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  function onChange(event: ChangeEvent<HTMLInputElement>): void {
    setLocalValue(event.target.value);
  }

  return (
    <>
      <input
        readOnly
        type="hidden"
        name={name}
        value={mounted ? datetimeLocalToIso(localValue) ?? '' : ''}
      />
      <label style={{ display: 'grid', gap: 2, minWidth: 220 }}>
        <span style={{ fontSize: 13, color: 'var(--ink)' }}>
          {label}
          {required ? <span style={{ color: 'var(--danger)' }}>（必須）</span> : null}
        </span>
        <input
          name={`${name}Local`}
          type="datetime-local"
          value={localValue}
          onChange={onChange}
          required={required}
          style={{ ...inputStyle, width }}
        />
        {hint ? <span style={noteStyle}>{hint}</span> : null}
      </label>
    </>
  );
}
