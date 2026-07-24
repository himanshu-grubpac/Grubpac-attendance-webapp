import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

const MENU_MIN_WIDTH = 176;

export default function ActionMenu({ label, items, onOpenChange }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  function setMenuOpen(next) {
    setOpen(next);
    onOpenChange?.(next);
  }

  useEscapeKey(open, () => setMenuOpen(false));

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? items.length * 40 + 8;
    const viewportPadding = 8;

    let left = rect.right - MENU_MIN_WIDTH;
    if (left < viewportPadding) left = rect.left;
    if (left + MENU_MIN_WIDTH > window.innerWidth - viewportPadding) {
      left = window.innerWidth - MENU_MIN_WIDTH - viewportPadding;
    }

    let top = rect.bottom + 4;
    if (top + menuHeight > window.innerHeight - viewportPadding) {
      top = rect.top - menuHeight - 4;
    }

    setPosition({ top, left });
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

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
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
        onClick={(event) => {
          event.stopPropagation();
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
              style={{ top: position.top, left: position.left }}
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
                  onClick={(event) => {
                    event.stopPropagation();
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
