/**
 * A segmented control whose highlight slides to the selected option. The pill
 * is measured from the selected button; until then the button is styled
 * directly so the first paint is correct.
 */

import { useLayoutEffect, useRef, useState } from "react";

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  options: readonly { readonly value: T; readonly label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const measure = () => {
      const chosen = root.querySelector<HTMLButtonElement>(`button[data-value="${CSS.escape(String(value))}"]`);
      if (chosen) setThumb({ left: chosen.offsetLeft, width: chosen.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [value, options]);

  return (
    <div className={`seg${thumb ? " has-thumb" : ""}${className ? ` ${className}` : ""}`} role="group" aria-label={label} ref={box}>
      {thumb ? (
        <span
          className="seg-thumb"
          aria-hidden="true"
          style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
        />
      ) : null}
      {options.map((option) => (
        <button
          key={String(option.value)}
          data-value={String(option.value)}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
