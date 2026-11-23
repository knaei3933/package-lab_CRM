/**
 * P1 R20: the list screens moved from app/<screen>/page.tsx (cookie-scoped) to
 * screens/<Screen>.tsx, drawn by /p/{案件コード}/<screen> for the URL's project.
 * The screen-content tests keep their setup (the mocked lib/api with a
 * "selected project"): this shim draws the screen for that project, as the
 * project route does for the URL's project. Without one it returns the old
 * 「案件を選んでいません」 notice — the screens never draw without a project.
 */
import type { ReactElement } from 'react';

type Screen<P> = (props: { projectId: string; projectCode: string } & P) => Promise<ReactElement | null>;

export const TEST_PROJECT_CODE = 'TEST-P';

export function projectScreen<P extends object>(screen: Screen<P>) {
  return async (props?: P): Promise<ReactElement | null> => {
    const api = await import('../../apps/web/src/lib/api.js');
    const data = await import('../../apps/web/src/lib/project-data.js');
    const projectId = await api.readSelectedProjectId();
    if (!projectId) return <div>{data.NO_PROJECT_SELECTED_MESSAGE}</div>;
    return screen({ projectId, projectCode: TEST_PROJECT_CODE, ...(props ?? ({} as P)) });
  };
}

/**
 * P4 web2a §0: the old lists only read now — a record is made on the order screen
 * (/p/{案件}/o/{発注}). The parity tests draw that screen for one order of the test project.
 */
export function orderScreen(orderCode: string) {
  return projectScreen(async (props: { projectId: string; projectCode: string }) => {
    const { OrderDetailScreen } = await import('../../apps/web/src/screens/OrderDetailScreen.js');
    return OrderDetailScreen({ ...props, orderCode, started: false });
  });
}

/** P4 web2a §0: the markup of one 「その他の操作」 panel of the order screen ('' when the menu has no such item). */
export function menuPanel(html: string, key: string): string {
  const start = html.indexOf(`data-menu-panel="${key}"`);
  if (start === -1) return '';
  const end = html.indexOf('data-menu-panel="', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}
