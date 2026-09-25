/**
 * Minimal async data hook: aborts on unmount and on dependency change (so a
 * slow stale response cannot overwrite a newer one), keeps previous data
 * while refetching, and never reports an AbortError.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

export function useAsync<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { pollMs?: number } = {},
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Held in a ref so changing the callback identity on every render does not
  // restart the request; the dependency array is the contract instead.
  const runRef = useRef(run);
  runRef.current = run;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);

    runRef
      .current(controller.signal)
      .then((value) => {
        if (!live) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const pollMs = options.pollMs;
  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(refresh, pollMs);
    // Polling pauses while the tab is hidden; a background tab would otherwise
    // poll the most expensive endpoint indefinitely.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollMs, refresh]);

  return { data, error, loading, refresh };
}
