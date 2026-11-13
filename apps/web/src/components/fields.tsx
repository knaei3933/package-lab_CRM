import type { ReactNode } from 'react';
import type { Choice } from '../lib/types';
import { fieldRowStyle, inputStyle, noteStyle } from '../lib/ui';

/**
 * Presentational form fields shared by every screen. No hooks and no server
 * imports, so they render the same inside server components and inside the
 * client forms that post through server actions.
 */

interface FieldProps {
  name: string;
  label: string;
  /** Optional props declare `| undefined` so call sites may pass undefined. */
  required?: boolean | undefined;
  hint?: string | undefined;
}

function LabelWrapper({ label, required, hint, children }: FieldProps & { children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 2, minWidth: 220 }}>
      <span style={{ fontSize: 13, color: '#172033' }}>
        {label}
        {required ? <span style={{ color: '#b91c1c' }}>（必須）</span> : null}
      </span>
      {children}
      {hint ? <span style={noteStyle}>{hint}</span> : null}
    </label>
  );
}

export function TextField({
  name,
  label,
  required,
  hint,
  type = 'text',
  defaultValue,
  placeholder,
  width
}: FieldProps & {
  type?: 'text' | 'password' | 'datetime-local' | 'date' | 'number';
  defaultValue?: string | undefined;
  placeholder?: string | undefined;
  width?: number | undefined;
}) {
  return (
    <LabelWrapper name={name} label={label} required={required} hint={hint}>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        style={{ ...inputStyle, width: width ?? 260 }}
      />
    </LabelWrapper>
  );
}

export function SelectField({
  name,
  label,
  choices,
  required,
  hint,
  includeBlank = false,
  blankLabel = '（選択なし）',
  defaultValue,
  width
}: FieldProps & {
  choices: Choice[];
  includeBlank?: boolean | undefined;
  blankLabel?: string | undefined;
  defaultValue?: string | undefined;
  width?: number | undefined;
}) {
  return (
    <LabelWrapper name={name} label={label} required={required} hint={hint}>
      <select name={name} defaultValue={defaultValue} required={required} style={{ ...inputStyle, width: width ?? 280 }}>
        {includeBlank ? <option value="">{blankLabel}</option> : null}
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </LabelWrapper>
  );
}

export function CheckboxField({ name, label, hint }: FieldProps) {
  return (
    <label style={{ ...fieldRowStyle, minWidth: 200, fontSize: 13 }}>
      <input type="checkbox" name={name} />
      <span>{label}</span>
      {hint ? <span style={noteStyle}>{hint}</span> : null}
    </label>
  );
}
