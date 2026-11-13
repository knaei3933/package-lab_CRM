/**
 * Shared inline styles for the operator UI. This is a daily ops tool: plain
 * readable tables and forms, no design system.
 */
export const cardStyle = {
  border: '1px solid #d8dfeb',
  borderRadius: 8,
  padding: 16,
  background: '#ffffff'
} as const;

export const noteStyle = { margin: '4px 0 12px', color: '#526173', fontSize: 13 } as const;

export const fieldRowStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  alignItems: 'center',
  gap: 8
} as const;

export const inputStyle = {
  border: '1px solid #b9c3d2',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 14,
  background: '#ffffff'
} as const;

export const buttonStyle = {
  border: '1px solid #1d4ed8',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 14,
  background: '#1d4ed8',
  color: '#ffffff',
  cursor: 'pointer'
} as const;

export const subtleButtonStyle = {
  ...buttonStyle,
  background: '#ffffff',
  color: '#1d4ed8'
} as const;

export const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse' as const,
  fontSize: 14
} as const;

export const thStyle = {
  border: '1px solid #d8dfeb',
  padding: '6px 8px',
  background: '#f2f5fa',
  textAlign: 'left' as const,
  whiteSpace: 'nowrap' as const
} as const;

export const tdStyle = {
  border: '1px solid #d8dfeb',
  padding: '6px 8px',
  verticalAlign: 'top' as const
} as const;

export const okMessageStyle = { color: '#166534', fontSize: 13 } as const;
export const errorMessageStyle = { color: '#b91c1c', fontSize: 13 } as const;
export const infoBoxStyle = {
  padding: 12,
  border: '1px solid #e4b9b9',
  borderRadius: 8,
  color: '#8a3b3b',
  fontSize: 14
} as const;
export const monoStyle = { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#526173' } as const;
export const navStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: 20,
  borderTop: '1px solid #eef1f6',
  paddingTop: 8
} as const;
export const badgeStyle = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid #b9c3d2',
  fontSize: 12,
  whiteSpace: 'nowrap' as const
} as const;
