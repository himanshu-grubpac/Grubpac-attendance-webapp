import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

const MENU_MIN_WIDTH = 176;
const VIEWPORT_PADDING = 8;
const GAP = 4;

function stopCardActivation(event) {
  event.stopPropagation();
}

export default function ActionMenu({ label, items, onOpenChange }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, ready: false });
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  function setMenuOpen(next) {
    setOpen(next);
    if (!next) {
      setPosition((prev) => ({ ...prev, ready: false }));
    }
    onOpenChange?.(next);
  }

  useEscapeKey(open, () => setMenuOpen(false));

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;

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
  }, [open, items.length]);

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

    function handleScroll() {
      setMenuOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open]);

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
