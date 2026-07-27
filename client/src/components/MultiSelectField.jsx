import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

const VIEWPORT_PADDING = 8;
const PANEL_MAX_HEIGHT = 16 * 16;

function normalizeValues(value) {
  return Array.isArray(value) ? value : [];
}

function formatDisplayLabel(selectedValues, options, placeholder, countSuffix) {
  if (selectedValues.length === 0) {
    return { text: placeholder, isPlaceholder: true };
  }

  const labels = selectedValues
    .map((selectedValue) => options.find((option) => option.value === selectedValue)?.label)
    .filter(Boolean);

  if (labels.length <= 2) {
    return { text: labels.join(', '), isPlaceholder: false };
  }

  return { text: `${labels.length} ${countSuffix}`, isPlaceholder: false };
}

export default function MultiSelectField({
  value,
  onChange,
  options = [],
  placeholder = 'Select…',
  countSuffix = 'selected',
  disabled = false,
  id: idProp,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  className = '',
}) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const listboxId = `${id}-listbox`;
  const selectedValues = normalizeValues(value);
  const selectedSet = new Set(selectedValues);
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: PANEL_MAX_HEIGHT,
  });
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const enabledOptions = options.filter((option) => !option.disabled);
  const { text: displayLabel, isPlaceholder } = formatDisplayLabel(
    selectedValues,
    options,
    placeholder,
    countSuffix,
  );

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

    function handleScroll(event) {
      if (event?.target instanceof Node && panelRef.current?.contains(event.target)) {
        return;
      }
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

  function openMenu() {
    if (disabled) return;
    const firstSelectedIndex = enabledOptions.findIndex((option) => selectedSet.has(option.value));
    setHighlightIndex(firstSelectedIndex >= 0 ? firstSelectedIndex : 0);
    setOpen(true);
  }

  function toggleOption(option) {
    if (option.disabled) return;

    const next = new Set(selectedValues);
    if (next.has(option.value)) {
      next.delete(option.value);
    } else {
      next.add(option.value);
    }

    onChange([...next]);
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
      if (option) toggleOption(option);
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
        className={`select-field multi-select-field${open ? ' select-field--open' : ''}${
          disabled ? ' select-field--disabled' : ''
        }${isPlaceholder ? ' select-field--placeholder' : ''}${className ? ` ${className}` : ''}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
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
              aria-multiselectable="true"
              className="select-field__panel multi-select-field__panel"
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
            >
              {options.map((option) => {
                const enabledIndex = enabledOptions.indexOf(option);
                const isSelected = selectedSet.has(option.value);
                const isHighlighted = enabledIndex === highlightIndex;
                return (
                  <button
                    key={option.value === '' ? '__empty__' : String(option.value)}
                    type="button"
                    role="option"
                    data-index={enabledIndex}
                    aria-selected={isSelected}
                    className={`multi-select-field__option${
                      isSelected ? ' multi-select-field__option--selected' : ''
                    }${isHighlighted ? ' multi-select-field__option--highlighted' : ''}`}
                    disabled={option.disabled}
                    onMouseEnter={() => {
                      if (!option.disabled && enabledIndex >= 0) {
                        setHighlightIndex(enabledIndex);
                      }
                    }}
                    onClick={() => toggleOption(option)}
                  >
                    <span className="multi-select-field__check" aria-hidden="true">
                      {isSelected ? '✓' : ''}
                    </span>
                    <span className="multi-select-field__label">{option.label}</span>
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
