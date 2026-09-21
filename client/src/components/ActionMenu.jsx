import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

const MENU_MIN_WIDTH = 176;
const VIEWPORT_PADDING = 8;
const GAP = 4;

// App-wide single-open registry: row action cells swallow pointerdown (to
// keep row navigation from firing), so a sibling trigger click never reaches
// the open menu's document outside-click handler — without this, every
// clicked Manage menu stays open and they pile up.
let activeMenuCloser = null;

function stopCardActivation(event) {
  event.stopPropagation();
}

export default function ActionMenu({ label, items, onOpenChange }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, ready: false });
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const closeMenu = useCallback(() => {
    if (activeMenuCloser === closeMenuRef.current) {
      activeMenuCloser = null;
    }
    setOpen(false);
    setPosition((prev) => ({ ...prev, ready: false }));
    onOpenChangeRef.current?.(false);
  }, []);
  const closeMenuRef = useRef(closeMenu);
  closeMenuRef.current = closeMenu;

  // Unmounted rows (search reloads, pagination appends) must not leave a
  // stale closer behind.
  useEffect(() => () => {
    if (activeMenuCloser === closeMenuRef.current) {
      activeMenuCloser = null;
    }
  }, []);

  function setMenuOpen(next) {
    if (next) {
      if (activeMenuCloser && activeMenuCloser !== closeMenuRef.current) {
        activeMenuCloser();
      }
      activeMenuCloser = closeMenuRef.current;
    } else if (activeMenuCloser === closeMenuRef.current) {
      activeMenuCloser = null;
    }
    setOpen(next);
    if (!next) {
      setPosition((prev) => ({ ...prev, ready: false }));
    }
    onOpenChange?.(next);
  }

  useEscapeKey(open, () => setMenuOpen(false));

  // Viewport-clamped panel placement. Shared by the open layout pass and
  // the scroll/resize tracker below so the fixed panel follows its trigger.
  const reposition = useCallback(() => {
    if (!triggerRef.current || !menuRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const menuEl = menuRef.current;
    const menuWidth = Math.max(menuEl.offsetWidth, MENU_MIN_WIDTH);
    const menuHeight = menuEl.offsetHeight || items.length * 40 + 8;

    let left = rect.right - menuWidth;
    if (left < VIEWPORT_PADDING) left = rect.left;
    if (left + menuWidth > window.innerWidth - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, window.innerWidth - menuWidth - VIEWPORT_PADDING);
    }

    let top = rect.bottom + GAP;
    if (top + menuHeight > window.innerHeight - VIEWPORT_PADDING) {
      const above = rect.top - menuHeight - GAP;
      if (above >= VIEWPORT_PADDING) {
        top = above;
      } else {
        top = Math.max(VIEWPORT_PADDING, window.innerHeight - menuHeight - VIEWPORT_PADDING);
      }
    }

    setPosition({ top, left, ready: true });
  }, [items.length]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (
        triggerRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      setMenuOpen(false);
    }

    // Track-and-follow: the panel is viewport-fixed, so any scroll moves it
    // off its trigger — reposition instead of closing. That also makes menu
    // opening immune to programmatic scrolls (sticky-scrollbar sync,
    // scroll-into-view on trigger click), which used to instantly kill a
    // just-opened menu. Only when the trigger itself leaves the viewport
    // is there nothing to anchor to — then close.
    function handleScroll() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (
        !rect ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        closeMenuRef.current();
        return;
      }
      reposition();
    }

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open, reposition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="action-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onPointerDown={stopCardActivation}
        onMouseDown={stopCardActivation}
        onClick={(event) => {
          stopCardActivation(event);
          setMenuOpen(!open);
        }}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              className="action-menu__panel"
              style={{
                top: position.top,
                left: position.left,
                visibility: position.ready ? 'visible' : 'hidden',
              }}
              onPointerDown={stopCardActivation}
              onMouseDown={stopCardActivation}
              onClick={stopCardActivation}
            >
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  className={`action-menu__item${
                    item.variant === 'danger' ? ' action-menu__item--danger' : ''
                  }`}
                  disabled={item.disabled}
                  title={item.title || undefined}
                  onPointerDown={stopCardActivation}
                  onMouseDown={stopCardActivation}
                  onClick={(event) => {
                    stopCardActivation(event);
                    setMenuOpen(false);
                    item.onClick();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
