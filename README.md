# PreStocks foundation

Backend foundation for a Solana app built on PreStocks tokenized pre-IPO equity.

## Layout

| Package | Responsibility |
| --- | --- |
| `packages/core` | Pure domain. Token-2022 unit math, transfer-fee arithmetic, the token universe, price models. No I/O, fully unit-tested. |
| `packages/chain` | Solana JSON-RPC reads and Token-2022 mint/account parsing. |
| `packages/market` | Issuer API and Jupiter clients, with caching and rate limiting. |
| `apps/indexer` | Composes a consistent market snapshot. `src/cli.ts` prints it. |

## Running

```bash
bun install
bun test                       # domain tests
bun run typecheck
bun run apps/indexer/src/cli.ts   # live mainnet snapshot
```

`SOLANA_RPC_URL` overrides the default public endpoint.

## Facts this codebase is built on

All verified against mainnet and against `spl-token-2022` source on 2026-09-19.

**Quotes are in raw units.** Jupiter's `/swap/v1/quote` returns `outAmount` in raw
base units and ignores the ScaledUiAmount multiplier. A price derived straight
from it overstates OPENAI by 49% and SPACEX by 400%. `packages/core/src/units.ts`
converts correctly. Jupiter's *Price v3* endpoint is different — its `usdPrice`
is already corrected, and exposes the raw figure as `usdPricePrescaled`.

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
