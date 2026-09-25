export interface Digit {
  readonly char: string;
  readonly key: number;
  readonly stagger: number | null;
}

/**
 * Which characters changed since the last render. Unchanged characters keep
 * their key so React leaves them alone; changed ones get a new key (and play
 * the pop-in) with a stagger over the changed ones only, capped at 4.
 */
export function popDigits(
  previous: readonly Digit[] | null,
  value: string,
  nextKey: number,
): { digits: Digit[]; nextKey: number } {
  let key = nextKey;
  let changed = 0;
  const digits = [...value].map((char, i) => {
    const before = previous?.[i];
    if (before && before.char === char) return { char, key: before.key, stagger: null };
    return { char, key: key++, stagger: Math.min(changed++, 4) };
  });
  return { digits, nextKey: key };
}
