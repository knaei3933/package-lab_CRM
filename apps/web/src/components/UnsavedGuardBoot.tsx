'use client';

import { installUnsavedGuard } from './unsaved-guard-dom';

/**
 * P4 M9: puts the unsaved-input guard on the page with the first script, from the root layout.
 * Until now it was installed by the first form that mounted — for a screen reached by a client-side move that is
 * AFTER the router has added its own popstate listener, so 「戻る」 redrew the previous screen (unmounting, and
 * so forgetting, the typed form) before the guard could ask (found live, ego-browser 2026-11-23).
 * The listener is added when this module loads, which is before the router's effect.
 */
installUnsavedGuard();

export function UnsavedGuardBoot() {
  return null;
}
