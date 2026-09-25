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
