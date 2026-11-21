import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buttonStyle, inputStyle } from '../apps/web/src/lib/ui.js';

/** P1 R27: styles live in classes (ui.css / screens.css), with 3 dynamic inline exceptions; touch targets 44px/16px. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
const SCREENS = ['screens/OrdersScreen.tsx', 'screens/ApprovalsScreen.tsx', 'screens/DocumentsScreen.tsx', 'screens/MakerPoScreen.tsx', 'screens/DeliveriesScreen.tsx', 'app/status/page.tsx'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

describe('inline styles on the five screens and the status page', () => {
  it('keeps exactly the 3 dynamic exceptions (two state-coloured info boxes, the status rowStyle)', () => {
    const uses = SCREENS.flatMap((file) => (read(file).match(/\bstyle=\{/g) ?? []).map(() => file));
    expect(uses.sort()).toEqual(['app/status/page.tsx', 'screens/MakerPoScreen.tsx', 'screens/MakerPoScreen.tsx']);
  });

  it('the exceptions are the dynamic ones: colours computed from state', () => {
    const maker = read('screens/MakerPoScreen.tsx');
    expect(maker).toMatch(/style=\{\{ \.\.\.infoBoxStyle, marginTop: 12, borderColor: gate\?\.gate\.satisfied/);
    expect(maker).toMatch(/style=\{\{ \.\.\.infoBoxStyle, borderColor: colors\.line/);
    expect(read('app/status/page.tsx')).toContain('style={rowStyle}');
  });
});

describe('classes used exist in the stylesheets', () => {
  const ui = read('app/ui.css');
  const screens = read('app/screens.css');
  const used = new Set<string>();
  for (const file of sources(root)) {
    for (const [, value] of readFileSync(file, 'utf8').matchAll(/className="([^"]*)"/g)) for (const token of value!.split(/\s+/)) used.add(token);
  }
  const defined = (css: string, token: string) => new RegExp(`\\.${token.replace(/[-]/g, '\\-')}(?![\\w-])`).test(css);

  it('finds the classes the screens use', () => {
    expect([...used].filter((token) => token.startsWith('ui-')).length).toBeGreaterThan(4);
    expect([...used].filter((token) => /^sx-[0-9a-f]+$/.test(token)).length).toBeGreaterThan(5);
  });

  it('every ui-* class used is defined in ui.css', () => {
    const missing = [...used].filter((token) => token.startsWith('ui-') && !defined(ui, token));
    expect(missing).toEqual([]);
  });

  it('every sx-* class used is defined in screens.css', () => {
    const missing = [...used].filter((token) => /^sx-[0-9a-f]+$/.test(token) && !defined(screens, token));
    expect(missing).toEqual([]);
  });

  it('ui.css defines the named set', () => {
    for (const token of ['ui-card', 'ui-note', 'ui-field-row', 'ui-input', 'ui-button', 'ui-button--subtle', 'ui-button--danger', 'ui-table', 'ui-th', 'ui-td', 'ui-ok', 'ui-error', 'ui-info', 'ui-mono']) {
      expect(defined(ui, token), token).toBe(true);
    }
  });
});

describe('ui.css behaviour rules', () => {
  const ui = read('app/ui.css');

  it('has hover rules for the buttons that inline styles could not give', () => {
    expect(ui).toMatch(/\.ui-button:hover/);
    expect(ui).toMatch(/\.ui-button--subtle:hover/);
  });

  it('has a coarse-pointer rule giving inputs and buttons 44px and 16px', () => {
    const block = /@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/.exec(ui)?.[1] ?? '';
    for (const selector of ['.ui-input', '.ui-button', '.ui-button--subtle', '.ui-button--danger']) expect(block).toContain(selector);
    expect(block).toMatch(/min-height:\s*44px/);
    expect(block).toMatch(/font-size:\s*16px/);
  });

  it('calms transitions for reduced motion', () => {
    expect(ui).toMatch(/prefers-reduced-motion: reduce[\s\S]*transition: none/);
  });
});

describe('touch tokens (§8-5)', () => {
  it('inputStyle and buttonStyle read --control-h and --control-text', () => {
    for (const style of [inputStyle, buttonStyle] as Array<Record<string, unknown>>) {
      expect(style.minHeight).toBe('var(--control-h, 40px)');
      expect(style.fontSize).toBe('var(--control-text, 15px)');
    }
  });

  it('p1.css defaults the tokens to 40px/15px and raises them to 44px/16px under (pointer: coarse)', () => {
    const css = read('app/p1.css');
    expect(css).toMatch(/--control-h:\s*40px/);
    expect(css).toMatch(/--control-text:\s*15px/);
    const coarse = /@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(coarse).toMatch(/--control-h:\s*44px/);
    expect(coarse).toMatch(/--control-text:\s*16px/);
  });
});
