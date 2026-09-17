import { useEffect, useRef, useState } from 'react';

/**
 * Sticky bottom horizontal-scrollbar proxy for a wide table wrapper.
 *
 * Long tables keep page-level vertical scroll (onscroll append/pagination),
 * so the wrapper's own horizontal scrollbar sits far below the fold. This
 * bar pins to the viewport bottom while its section is in view and mirrors
 * the target wrapper's horizontal scroll in both directions.
 *
 * Renders nothing until the target actually overflows, so card-layout
 * tables (mobile) and fitting tables are completely unaffected.
 *
 * Pass `syncKey` (e.g. row count) when the bar mounts before the table
 * data loads, so measuring (re)runs once rows arrive.
 */
export default function StickyHScrollBar({ targetRef, syncKey = 0 }) {
  const barRef = useRef(null);
  const spacerRef = useRef(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const target = targetRef?.current;
    const bar = barRef.current;
    const spacer = spacerRef.current;
    if (!target || !bar || !spacer) {
      setHasOverflow(false);
      return undefined;
    }

    let frame = 0;
    const measure = () => {
      spacer.style.width = `${target.scrollWidth}px`;
      const overflow = target.scrollWidth > target.clientWidth + 1;
      setHasOverflow(overflow);
      // Single-scrollbar UX: hide the wrapper's native bar while the
      // sticky proxy is active (the wrapper itself stays scrollable).
      target.classList.toggle('table-wrap--proxy', overflow);
      if (bar.scrollLeft !== target.scrollLeft) {
        bar.scrollLeft = target.scrollLeft;
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    // Assign only on mismatch: the resulting scroll event on the other side
    // then sees equal values and returns early (no feedback loop, no flags).
    const syncTargetToBar = () => {
      if (bar.scrollLeft !== target.scrollLeft) target.scrollLeft = bar.scrollLeft;
    };
    const syncBarToTarget = () => {
      if (bar.scrollLeft !== target.scrollLeft) bar.scrollLeft = target.scrollLeft;
    };

    measure();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(target);
    const table = target.querySelector('table');
    if (table) resizeObserver.observe(table);
    // Rows appended on scroll / column toggles change scrollWidth.
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(target, { childList: true, subtree: true, characterData: true });
    target.addEventListener('scroll', syncBarToTarget, { passive: true });
    bar.addEventListener('scroll', syncTargetToBar, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      target.removeEventListener('scroll', syncBarToTarget);
      bar.removeEventListener('scroll', syncTargetToBar);
      target.classList.remove('table-wrap--proxy');
    };
  }, [targetRef, syncKey]);

  return (
    <div
      ref={barRef}
      className="table-hscroll"
      hidden={!hasOverflow}
      aria-hidden="true"
      tabIndex={-1}
    >
      <div ref={spacerRef} className="table-hscroll__spacer" />
    </div>
  );
}
