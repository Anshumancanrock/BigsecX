/**
 * Modal sheet: moves focus in on open and back on close, and closes on Escape
 * or a backdrop click. `dismissible` is false while a trade is in flight, so
 * the only record of what was submitted cannot be closed.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function Sheet({
  title,
  onClose,
  dismissible = true,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  dismissible?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const latest = useRef({ onClose, dismissible });
  useEffect(() => {
    latest.current = { onClose, dismissible };
  });

  // Runs once per opening. Callers pass a new onClose on every render, so
  // depending on it would pull focus out of any input on each keystroke.
  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && latest.current.dismissible) latest.current.onClose();
    };
    document.addEventListener("keydown", onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, []);

  // Portalled into <body> so the sheet does not inherit layout rules from
  // wherever it was opened, such as a card or a table cell.
  return createPortal(
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="sheet"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sheet-head">
          <h2>{title}</h2>
          {dismissible ? (
            <button className="sheet-close" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </div>
        {children}
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>,
    // The sheet reads the app's theme tokens, which are scoped to .app; a
    // bare <body> child would fall back to the light landing palette.
    document.querySelector(".app") ?? document.body,
  );
}
