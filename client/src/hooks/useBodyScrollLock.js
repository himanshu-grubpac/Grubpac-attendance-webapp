import { useEffect } from 'react';

let lockCount = 0;

function acquireLock() {
  if (lockCount === 0) {
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function releaseLock() {
  if (lockCount <= 0) return;
  lockCount -= 1;
  if (lockCount === 0) {
    // Always clear instead of restoring a saved value. The app's base
    // overflow comes from the stylesheet (`overflow-x: clip` on body), and
    // nothing in the codebase sets a meaningful inline body overflow besides
    // modal locks — so clearing heals a stale `hidden` left behind by the
    // old naive save/restore code (or by mixed naive/counted pairs) instead
    // of faithfully preserving it forever.
    document.body.style.overflow = '';
  }
}

/**
 * Reference-counted body scroll lock for stacked modals.
 *
 * Several flows (e.g. bulk-upload review popup + confirm dialog) stack one
 * modal above another, and each one locks body scroll while open. The naive
 * save-previous/restore pattern breaks for nesting: the inner modal saves
 * `'hidden'` as its previous value, so whichever cleanup runs last decides
 * the final value and `body { overflow: hidden }` can leak after all modals
 * close. A leaked inline `overflow: hidden` overrides the stylesheet's
 * `overflow-x: clip` on `body`, which both degrades scrolling and breaks
 * `position: sticky` ancestors such as the app sidebar (it scrolls away
 * with the page instead of sticking).
 *
 * With counting, the last release clears the lock, so any close order ends
 * clean — including healing a stale inline `hidden` left by earlier code.
 * Visuals and layout are untouched — this only manages the inline
 * `body.style.overflow` bookkeeping.
 */
export function useBodyScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    acquireLock();
    return () => {
      releaseLock();
    };
  }, [active]);
}
