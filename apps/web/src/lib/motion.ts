import { useEffect, useRef, useState } from "react";

export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useCountUp(target: number | null, duration = 800): number | null {
  const [shown, setShown] = useState<number | null>(() =>
    target === null ? null : reducedMotion() ? target : 0,
  );
  const current = useRef<number | null>(shown);

  useEffect(() => {
    if (target === null) {
      current.current = null;
      setShown(null);
      return;
    }
    if (reducedMotion()) {
      current.current = target;
      setShown(target);
      return;
    }
    const from = current.current ?? 0;
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      const eased = 1 - (1 - t) ** 3;
      const value = from + (target - from) * eased;
      current.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return shown;
}
