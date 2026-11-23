import type { Metadata } from 'next';
import { NotFoundNotice, NOT_FOUND_TITLE } from '../components/NotFoundNotice';

export const metadata: Metadata = { title: NOT_FOUND_TITLE };

/** P4 N7: any address the app has no page for. */
export default function NotFound() {
  return <NotFoundNotice scope="site" />;
}
