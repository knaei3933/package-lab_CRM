import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCurrentNavItem } from '../apps/web/src/components/NavLinks.js';
import {
  decodeDisplayNameCookie,
  encodeDisplayNameCookie,
  operatorName,
  roleLabel,
  sessionCookieAttributes
} from '../apps/web/src/lib/session-display.js';
import * as ui from '../apps/web/src/lib/ui.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webSrc = path.join(repoRoot, 'apps/web/src');
const USER_ID = '01a1ec52-a730-7596-aff1-4072d76c1cf8';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '.omc' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('header operator name (UI batch A, P1-6)', () => {
  it('prefers the API display name', () => {
    expect(operatorName({ role: 'admin', displayName: '合成代表者' }, 'admin_composite')).toBe('合成代表者');
  });

  it('falls back to the remembered login name, then to a role label — never the UUID', () => {
    expect(operatorName({ role: 'staff' }, 'staff_composite')).toBe('staff_composite');
    expect(operatorName({ role: 'viewer', displayName: '   ' }, null)).toBe('閲覧者アカウント');
    expect(operatorName({ role: 'admin' }, null)).not.toContain(USER_ID);
    expect(roleLabel('unknown-role')).toBe('閲覧者');
  });

  it('round-trips the display cookie only for the same user id', () => {
    const raw = encodeDisplayNameCookie(USER_ID, '合成代表者');
    expect(raw).not.toBeNull();
    expect(decodeDisplayNameCookie(raw, USER_ID)).toBe('合成代表者');
    expect(decodeDisplayNameCookie(raw, '01a1ec52-0000-7000-8000-000000000000')).toBeNull();
  });

  it('rejects empty, malformed or tampered cookie values', () => {
    expect(encodeDisplayNameCookie(USER_ID, '')).toBeNull();
    expect(encodeDisplayNameCookie(undefined, 'name')).toBeNull();
    expect(decodeDisplayNameCookie(undefined, USER_ID)).toBeNull();
    expect(decodeDisplayNameCookie('%E0%A4%A', USER_ID)).toBeNull();
    expect(decodeDisplayNameCookie(encodeURIComponent('"just a string"'), USER_ID)).toBeNull();
    const control = encodeDisplayNameCookie(USER_ID, 'a\u0000b\nc');
    expect(decodeDisplayNameCookie(control, USER_ID)).toBe('abc');
    const long = encodeDisplayNameCookie(USER_ID, 'x'.repeat(500));
    expect(decodeDisplayNameCookie(long, USER_ID)).toHaveLength(64);
  });

  it('accepts the value already URI-decoded by Next without decoding it twice', () => {
    const raw = encodeDisplayNameCookie(USER_ID, '100%確認');
    expect(decodeDisplayNameCookie(decodeURIComponent(raw!), USER_ID)).toBe('100%確認');
    expect(decodeDisplayNameCookie(raw, USER_ID)).toBe('100%確認');
  });

  it('copies only lifetime and transport attributes from the session cookie', () => {
    expect(
      sessionCookieAttributes('kanei_mvp_session=abc; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=Wed, 18 Nov 2026 13:00:00 GMT')
    ).toBe('; Secure; Expires=Wed, 18 Nov 2026 13:00:00 GMT');
    expect(sessionCookieAttributes('kanei_mvp_session=abc; Path=/; Max-Age=3600; Domain=evil.example')).toBe('; Max-Age=3600');
    expect(sessionCookieAttributes(undefined)).toBe('');
  });
});

describe('header navigation current item (UI batch A)', () => {
  it('marks the screen and its sub-paths only', () => {
    expect(isCurrentNavItem('/orders', '/orders')).toBe(true);
    expect(isCurrentNavItem('/maker-po/123', '/maker-po')).toBe(true);
    expect(isCurrentNavItem('/orders-archive', '/orders')).toBe(false);
    expect(isCurrentNavItem('/', '/orders')).toBe(false);
    expect(isCurrentNavItem(null, '/orders')).toBe(false);
  });
});

describe('design tokens and copy (UI batch A)', () => {
  const css = readFileSync(path.join(webSrc, 'app/globals.css'), 'utf8');

  it('lib/ui.ts styles use tokens only, and every token they read is defined', () => {
    const serialized = JSON.stringify(ui);
    expect(serialized).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    const used = new Set([...serialized.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
    expect(used.size).toBeGreaterThan(5);
    for (const token of used) expect(css).toContain(`${token}:`);
  });

  it('defines a visible keyboard focus ring and loads the stylesheet from the root layout', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/);
    expect(readFileSync(path.join(webSrc, 'app/layout.tsx'), 'utf8')).toContain("import './globals.css';");
  });

  it('gives every screen its own title', () => {
    // P1 R20: the lists live at /p/{案件コード}/<screen>; the old addresses only redirect.
    for (const route of ['p/[project]/orders', 'p/[project]/documents', 'p/[project]/approvals', 'p/[project]/maker-po', 'p/[project]/deliveries', 'p/[project]/new', 'p/[project]', 'status']) {
      const page = readFileSync(path.join(webSrc, 'app', route, 'page.tsx'), 'utf8');
      expect(page, route).toMatch(/export const metadata: Metadata = \{ title: '[^']+' \}/);
    }
  });

  // The 本登録 form gate is pinned by rendering the orders screen for admin,
  // staff and viewer in tests/web-ui-batch-a-followup.test.tsx (it replaced the
  // source-text check that stood here).

  it('no longer says 大代表承認 anywhere in the web UI', () => {
    for (const file of sourceFiles(webSrc)) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('大代表');
    }
  });
});
