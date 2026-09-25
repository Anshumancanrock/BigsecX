/** Minimal History API router: real, shareable URLs without a routing library. */

import { useEffect, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";

/*
 * Navigation runs inside a view transition where supported (see the
 * view-transition rules in app.css). The state update is flushed
 * synchronously so the browser captures the new page, not a partial render.
 * Skipped without the API or with reduced motion.
 */
function canTransition(): boolean {
  return (
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const sync = (event: Event) => {
      const next = window.location.pathname;
      const apply = () => {
        flushSync(() => setPath(next));
        if (event.type === "bx:navigate") window.scrollTo(0, 0);
      };
      if (canTransition()) document.startViewTransition(apply);
      else apply();
    };
    window.addEventListener("popstate", sync);
    // `navigate` dispatches this so a programmatic push re-renders too;
    // popstate alone only fires for back/forward.
    window.addEventListener("bx:navigate", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("bx:navigate", sync);
    };
  }, []);

  return path;
}

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState({}, "", to);
  window.dispatchEvent(new Event("bx:navigate"));
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!;
    const actual = pathParts[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(actual);
    else if (p !== actual) return null;
  }
  return params;
}

export function go(to: string) {
  return (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(to);
  };
}
