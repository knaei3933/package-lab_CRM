/**
 * Shared inline styles for the operator UI. This is a daily ops tool: plain
 * readable tables and forms. UI batch A: every colour, size and radius here
 * reads a design token from app/globals.css (UI_AUDIT_AND_PLAN §3.2), so the
 * screens share one palette without changing their markup.
 */
export const cardStyle = {
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  padding: 'var(--space-4)',
  background: 'var(--surface)'
} as const;

export const noteStyle = { margin: '4px 0 12px', color: 'var(--ink-sub)', fontSize: 13 } as const;

export const fieldRowStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  alignItems: 'center',
  gap: 'var(--space-2)'
} as const;

export const inputStyle = {
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius)',
  padding: '6px 8px',
  fontSize: 'var(--text-sm)',
  background: 'var(--surface)'
} as const;

export const buttonStyle = {
  border: '1px solid var(--primary)',
  borderRadius: 'var(--radius)',
  padding: '6px 14px',
  fontSize: 'var(--text-sm)',
  background: 'var(--primary)',
  color: 'var(--surface)',
  cursor: 'pointer'
} as const;

export const subtleButtonStyle = {
  ...buttonStyle,
  background: 'var(--surface)',
  color: 'var(--primary)'
} as const;

export const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse' as const,
  fontSize: 'var(--text-sm)',
  fontVariantNumeric: 'tabular-nums'
} as const;

export const thStyle = {
  border: '1px solid var(--line)',
  padding: '6px 8px',
  background: 'var(--surface-sub)',
  textAlign: 'left' as const,
  whiteSpace: 'nowrap' as const
} as const;

export const tdStyle = {
  border: '1px solid var(--line)',
  padding: '6px 8px',
  verticalAlign: 'top' as const
} as const;

export const okMessageStyle = { color: 'var(--ok)', fontSize: 13 } as const;
export const errorMessageStyle = { color: 'var(--danger)', fontSize: 13 } as const;
export const infoBoxStyle = {
  padding: 'var(--space-3)',
  border: '1px solid var(--danger)',
  borderRadius: 'var(--radius)',
  background: 'var(--danger-tint)',
  color: 'var(--danger)',
  fontSize: 'var(--text-sm)'
} as const;
export const monoStyle = { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--ink-sub)' } as const;
export const badgeStyle = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid var(--line-strong)',
  fontSize: 'var(--text-xs)',
  whiteSpace: 'nowrap' as const
} as const;
