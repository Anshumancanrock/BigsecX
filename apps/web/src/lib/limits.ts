/**
 * Order limits the API enforces. The UI checks them first so an order the
 * server would refuse never reaches the wallet.
 */

export const MIN_BUY_USD = 5;

/** Smallest basket purchase, since the amount is split across several companies. */
export const MIN_BASKET_USD = 25;

export const MAX_BUY_USD = 250_000;

export const MIN_SELL_USD = 1;

/** SOL the wallet must hold for fees before anything is built. */
export const MIN_LAMPORTS = 3_000_000;
