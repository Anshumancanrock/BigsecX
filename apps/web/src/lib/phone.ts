/**
 * Whether the viewport is phone-sized, by the stylesheet's breakpoint.
 * Screens with a different structure on phones (home, profiles, leaderboard)
 * switch on this; everything else is CSS.
 */

import { useEffect, useState } from "react";

export const PHONE_QUERY = "(max-width: 720px)";

const query = () => (typeof matchMedia === "function" ? matchMedia(PHONE_QUERY) : null);

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const list = query();
    if (!list) return;
    const sync = () => setPhone(list.matches);
    sync();
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, []);
  return phone;
}
