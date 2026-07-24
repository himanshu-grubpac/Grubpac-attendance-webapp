import { useEffect } from 'react';

/**
 * Calls `onEscape` when Escape is pressed while `active` is true.
 * Matches the NotificationBell pattern for closing overlays/panels.
 */
export function useEscapeKey(active, onEscape) {
  useEffect(() => {
    if (!active) return undefined;

    function handleKeyDown(event) {
      if (event.key === 'Escape') onEscape();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, onEscape]);
}
