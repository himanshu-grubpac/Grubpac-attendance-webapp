import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

const VIEWPORT_PADDING = 8;
const PANEL_MAX_HEIGHT = 16 * 16;

function findSelectedIndex(options, value) {
  return options.findIndex((option) => option.value === value);
}

export default function SelectField({
  value,
  onChange,
  options = [],
  placeholder = 'Select…',
  disabled = false,
  id: idProp,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className = '',
}) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const listboxId = `${id}-listbox`;
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: PANEL_MAX_HEIGHT });
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const selectedOption = options.find((option) => option.value === value);
  const displayLabel = selectedOption?.label ?? placeholder;
  const isPlaceholder = !selectedOption;

  const enabledOptions = options.filter((option) => !option.disabled);

  const close = useCallback(() => {
    setOpen(false);
    setHighlightIndex(-1);
  }, []);

  useEscapeKey(open, close);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const panelHeight = Math.min(
      panelRef.current?.scrollHeight ?? enabledOptions.length * 40 + 8,
      PANEL_MAX_HEIGHT,
    );

    let top = rect.bottom + 4;
    let maxHeight = PANEL_MAX_HEIGHT;

    if (top + panelHeight > window.innerHeight - VIEWPORT_PADDING) {
      const spaceAbove = rect.top - VIEWPORT_PADDING;
      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;

      if (spaceAbove > spaceBelow && spaceAbove > 120) {
        maxHeight = Math.min(PANEL_MAX_HEIGHT, spaceAbove - 8);
        top = rect.top - Math.min(panelHeight, maxHeight) - 4;
      } else {
        maxHeight = Math.min(PANEL_MAX_HEIGHT, spaceBelow - 8);
      }
    }

    setPosition({
      top,
      left: rect.left,
      width: rect.width,
      maxHeight,
    });
  }, [open, enabledOptions.length, options.length]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (
        triggerRef.current?.contains(event.target) ||
        panelRef.current?.contains(event.target)
      ) {
        return;
      }
      close();
    }

    function handleScroll() {
      close();
    }

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open, close]);

  useEffect(() => {
    close();
  }, [value, close]);

  function openMenu() {
    if (disabled) return;
    const selectedIndex = findSelectedIndex(enabledOptions, value);
    setHighlightIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function selectOption(option) {
    if (option.disabled) return;
    onChange(option.value);
    close();
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event) {
    if (disabled) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
    }

    if (!open) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIndex((current) => {
        const next = current + 1;
        return next >= enabledOptions.length ? 0 : next;
      });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIndex((current) => {
        const next = current - 1;
        return next < 0 ? enabledOptions.length - 1 : next;
      });
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlightIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightIndex(enabledOptions.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = enabledOptions[highlightIndex];
      if (option) selectOption(option);
    }
  }

  useEffect(() => {
    if (!open || highlightIndex < 0 || !panelRef.current) return;
    const item = panelRef.current.querySelector(`[data-index="${highlightIndex}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [open, highlightIndex]);

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`select-field${open ? ' select-field--open' : ''}${
          disabled ? ' select-field--disabled' : ''
        }${isPlaceholder ? ' select-field--placeholder' : ''}${className ? ` ${className}` : ''}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="select-field__value">{displayLabel}</span>
        <span className="select-field__chevron" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={listboxId}
              role="listbox"
              className="select-field__panel"
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
            >
              {options.map((option) => {
                const enabledIndex = enabledOptions.indexOf(option);
                const isSelected = option.value === value;
                const isHighlighted = enabledIndex === highlightIndex;
                return (
                  <button
                    key={option.value === '' ? '__empty__' : String(option.value)}
                    type="button"
                    role="option"
                    data-index={enabledIndex}
                    aria-selected={isSelected}
                    className={`select-field__option${
                      isSelected ? ' select-field__option--selected' : ''
                    }${isHighlighted ? ' select-field__option--highlighted' : ''}`}
                    disabled={option.disabled}
                    onMouseEnter={() => {
                      if (!option.disabled && enabledIndex >= 0) {
                        setHighlightIndex(enabledIndex);
                      }
                    }}
                    onClick={() => selectOption(option)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
