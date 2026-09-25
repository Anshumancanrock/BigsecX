/**
 * Read access to strategies. Routes reach a strategy without a creator
 * signature only through `publicStrategy`, so drafts stay private. Callers
 * answer 404 rather than 403, since confirming that an id exists is a disclosure.
 */

import type { Store } from "@ps/db";

type StrategyRow = NonNullable<ReturnType<Store["getStrategy"]>>;

/**
 * The strategy if it is published, else null. Only routes that verify the
 * creator's signature (list-mine, update, delete) may read a draft.
 */
export function publicStrategy(store: Store, id: string): StrategyRow | null {
  const row = store.getStrategy(id);
  if (!row || !row.published) return null;
  return row;
}
