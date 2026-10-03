import { flushSync } from 'react-dom';

/**
 * Applies a state change as a view transition in which `from` (before) and
 * `to` (after) are one element changing shape: a block opening into its
 * dialog, and the dialog closing back into its block. The dialog takes part
 * through html[data-morph] (see index.css). Without the API, or when motion
 * is reduced, the change is applied plainly.
 */
export function morph(update: () => void, from: () => HTMLElement | null, to: () => HTMLElement | null = () => null) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduced) {
    update();
    return;
  }
  const root = document.documentElement;
  const before = from();
  before?.style.setProperty('view-transition-name', 'morph');
  root.dataset['morph'] = '';
  let after: HTMLElement | null = null;
  const transition = document.startViewTransition(() => {
    before?.style.removeProperty('view-transition-name');
    flushSync(update);
    after = to();
    after?.style.setProperty('view-transition-name', 'morph');
  });
  transition.finished.finally(() => {
    after?.style.removeProperty('view-transition-name');
    delete root.dataset['morph'];
  });
}
