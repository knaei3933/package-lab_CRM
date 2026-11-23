import type { Metadata } from 'next';
import { NotFoundNotice } from '../../../components/NotFoundNotice';

export const metadata: Metadata = { title: 'ページが見つかりません' };

/** P4 N7: a path under /p/{案件} with no screen (the project itself is handled by ProjectNotFound). */
export default function ProjectNotFound() {
  return <NotFoundNotice scope="project" />;
}
