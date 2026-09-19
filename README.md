# PreStocks foundation

Backend foundation for a Solana app built on PreStocks tokenized pre-IPO equity.

## Layout

| Package | Responsibility |
| --- | --- |
| `packages/core` | Pure domain. Token-2022 unit math, transfer-fee arithmetic, the token universe, price models. No I/O, fully unit-tested. |
| `packages/chain` | Solana JSON-RPC reads and Token-2022 mint/account parsing. |
| `packages/market` | Issuer API and Jupiter clients, with caching and rate limiting. |
| `packages/tx` | Builds the unsigned transactions that move a wallet onto a target allocation. |
| `apps/indexer` | Composes market snapshots, indexes and mirror bundles. CLIs under `src/`. |

## Running

```bash
bun install
bun test                       # domain tests
bun run typecheck
bun run apps/indexer/src/cli.ts              # live mainnet snapshot
bun run apps/indexer/src/indexes-cli.ts pre8 1000   # indexes + priced execution plan
bun run apps/indexer/src/mirror-cli.ts <wallet> pre8 3000   # build + simulate real transactions
```

`SOLANA_RPC_URL` overrides the default public endpoint.

## Facts this codebase is built on

All verified against mainnet and against `spl-token-2022` source on 2026-09-19.

**Quotes are in raw units.** Jupiter's `/swap/v1/quote` returns `outAmount` in raw
base units and ignores the ScaledUiAmount multiplier. A price derived straight
from it overstates OPENAI by 49% and SPACEX by 400%. `packages/core/src/units.ts`
converts correctly. Jupiter's *Price v3* endpoint is different — its `usdPrice`
is already corrected, and exposes the raw figure as `usdPricePrescaled`.

**Quotes are net of the transfer fee.** Established by simulating a swap against
mainnet: a $500 buy quoted `outAmount` 486,197,930 and credited exactly
486,197,930 spendable base units, with 2,443,206 withheld separately in the
destination account's fee extension — 0.5000% of the 488,641,136 gross the pool
sent. So the fee is already inside the price, and adding it to a cost total
charges the user twice. `packages/core/src/execution.ts` measures cost as
realized fill versus reference price, which cannot double-count by construction.

**The transfer fee is 50 bps, not 100.** Each mint carries two fee schedules.
`newerTransferFee` is 100 bps but only applies from epoch 1039; until then the
50 bps `olderTransferFee` is live. Reading the newer schedule unconditionally
doubles every quoted cost. `epochFee()` implements the on-chain selection rule.

**The fee is a ceiling division**, so any non-zero transfer pays at least one
base unit. Tests port the upstream Rust vectors directly.

**Liquidity is thin.** Roughly $2.6M quotable across all eight tokens, from
$766k (OPENAI) down to $98k (KALSHI). Any feature that moves size has to be
quoted against real depth, not assumed.

**Mark and market disagree, persistently.** There is no retail redemption path,
so dislocations survive. Measured on 2026-09-19: SPACEX 19% below mark,
NEURALINK 25% above.

**The issuer controls the asset.** One key
(`WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc`) holds mint, freeze, pause,
permanent-delegate and fee authority on every mint. This is a property of the
asset and must be disclosed to users.

**Both upstreams rate limit.** `prestocks.com/api/prestocks` returns 429 under
light polling; `lite-api.jup.ag` reports single-digit remaining quota. All
outbound calls go through a token bucket, and cache misses are single-flighted.

**Undocumented endpoint.** `prestocks.com/api/stats` returns 412 days of
cumulative volume and 60 weeks of holder counts per symbol. Volume is
cumulative; `dailyVolume()` differences it.

**Routes do not always fit in a transaction.** An unconstrained PreStocks route
can compile to 1335 bytes against a 1232-byte limit, and some venues reject a
swap in simulation that quoted cleanly. `packages/tx` answers both with a retry
ladder: tighten `maxAccounts`, then exclude the venue that rejected the leg,
then fall back to direct routes. Measured on mainnet, this fills all eight legs
of the PRE8 basket where a single unconstrained attempt fills five.

## Mirroring

A portfolio is a set of target weights. `planRebalance` turns the gap between a
wallet and those weights into orders; `buildExecutionPlan` prices each order
against a live quote and refuses or resizes what the pools cannot absorb;
`buildMirrorBundle` turns the survivors into unsigned versioned transactions.

The user signs once, via `signAllTransactions`. Nothing is deposited and no key
is held here. The cost is that a basket is not atomic — it is several
transactions, and a partial fill is a real outcome callers must handle.
