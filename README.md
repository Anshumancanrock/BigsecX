# PreStocks foundation

Backend foundation for a Solana app built on PreStocks tokenized pre-IPO equity.

## Layout

| Package | Responsibility |
| --- | --- |
| `packages/core` | Pure domain. Token-2022 unit math, transfer-fee arithmetic, the token universe, price models. No I/O, fully unit-tested. |
| `packages/chain` | Solana JSON-RPC reads and Token-2022 mint/account parsing. |
| `packages/market` | Issuer API and Jupiter clients, with caching and rate limiting. |
| `packages/tx` | Builds the unsigned transactions that move a wallet onto a target allocation. |
| `packages/db` | SQLite schema, migrations and repositories. |
| `apps/indexer` | Snapshot, trade and index-level indexing job, plus CLIs. |
| `apps/api` | HTTP API over the above. |

## Running

```bash
bun install
bun test                       # domain tests
bun run typecheck
bun run apps/indexer/src/cli.ts              # live mainnet snapshot
bun run apps/indexer/src/indexes-cli.ts pre8 1000   # indexes + priced execution plan
bun run apps/indexer/src/mirror-cli.ts <wallet> pre8 3000   # build + simulate real transactions
bun run apps/indexer/src/index.ts            # indexing job (INDEXER_ONCE=1 for one pass)
bun run apps/api/src/index.ts                # HTTP API on :3000
```

Configuration is environment-driven; see `.env.example`. Two variables matter
most. `SOLANA_RPC_URL` raises the ceiling for the trade indexer, which the free
tier starves. `JUPITER_API_KEY` moves quoting onto the keyed host and lets the
client raise its own rate budget — without it, the keyless tier reports a
remaining quota in single digits while a single eight-leg basket needs sixteen
calls.

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

**Quotes and balances are not the same question.** Jupiter spends from the
associated token account, not from everything an owner holds. A mainnet wallet
inspected here held 133 ANTHROPIC across 49 accounts while its ATA held 0.0001;
a sell sized against the total fails on chain with custom program error 0x1788,
*after* the user has signed. `POST /api/mirror/build` reads ATA balances and
refuses uncovered sell legs with a 409 instead.

**Setup instructions cannot be deduplicated across a bundle.** Every sell leg
emits the same "create the USDC destination account" instruction. Dropping it
from all but the first leg looks like an optimisation, but those legs are
packed into different transactions, so a wallet without that account would have
the first transaction create it and every later one fail. Deduplication is
scoped to a single transaction; `packages/tx/test/pack.test.ts` locks this down.

**Free RPC endpoints refuse the obvious holder query.** `getTokenLargestAccounts`
returns 429 from every public endpoint tested, even for a single call, and
`getProgramAccounts` over 68,000 accounts is worse. Traders are reconstructed
from transaction history instead, attributed to the signer so liquidity pools
do not appear as traders. This is also the better source: it finds people who
trade rather than whales who hold, and each transaction carries both legs.

**Routes do not always fit in a transaction.** An unconstrained PreStocks route
can compile to 1335 bytes against a 1232-byte limit, and some venues reject a
swap in simulation that quoted cleanly. `packages/tx` answers both with a retry
ladder: tighten `maxAccounts`, then exclude the venue that rejected the leg,
then fall back to direct routes. Measured on mainnet, this fills all eight legs
of the PRE8 basket where a single unconstrained attempt fills five.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/market` | Latest prices, basis, liquidity, active fee, pending fee change |
| `GET /api/indexes` | All indexes with current weights and level |
| `GET /api/indexes/:id` | One index with its level history |
| `GET /api/leaderboard?hours=24` | Wallets ranked by flow-adjusted return |
| `POST /api/mirror/plan` | Price a basket against live depth, before any wallet opens |
| `POST /api/mirror/build` | Unsigned versioned transactions for `signAllTransactions` |

Verified end to end on mainnet: `POST /api/mirror/build` for the eight-token
PRE8 basket returns seven transactions, and all seven simulate successfully.

## Strategies

A thematic index, a user's own basket and a portfolio someone copies are the
same object with different authors, so they share one type. Authoring is the
creator side of the product:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/strategies` | Published strategies, or a creator's own including drafts |
| `GET /api/strategies/:id` | One strategy with weights, guardrails and sector exposure |
| `POST /api/strategies` | Create. Returns every validation problem at once |
| `PUT /api/strategies/:id` | Replace. Scoped to the creator |
| `DELETE /api/strategies/:id` | Remove. Scoped to the creator |
| `POST /api/strategies/overlap` | Combined exposure across several held strategies |
| `POST /api/strategies/:id/drift` | Whether a wallet has drifted past the threshold |

Guardrails — position cap, position floor, sector ceiling, drift threshold —
are the author's promises and are opt-in. A default never reshapes an
allocation: a position over the cap is scaled down, but a position under the
floor is *rejected* rather than raised, because raising it would ship weights
the author did not choose.

**These routes have no authentication.** A caller asserts its own wallet
address. That is workable for a demo and the ownership checks are real, but
the assertion is not proof, and the routes need a signed message bound to the
request before they are exposed publicly.

## Portfolio

| Endpoint | Purpose |
| --- | --- |
| `GET /api/portfolio/:wallet` | Live holdings, value, weights, sectors, cash, frozen accounts |
| `GET /api/portfolio/:wallet?compare=:id` | The same, measured against a saved strategy |
| `GET /api/portfolio/:wallet/:symbol` | One position, for an asset page |

Balances come from the associated token accounts, never from anything the
caller supplies: a claimed holding is a hint, a chain balance is what can
actually be sold. A position that cannot be priced is named in `unpriced` and
left with a null weight rather than counted as worthless, and a frozen
account is flagged rather than reported as sellable.

## Traders

| Endpoint | Purpose |
| --- | --- |
| `GET /api/leaderboard` | Wallets ranked by profit, return or volume |
| `GET /api/traders/:wallet` | Profile: profit, return, win rate, allocation, sectors |
| `GET /api/traders/:wallet/trades` | Raw trade history |

Nobody reports their own performance; it is reconstructed from indexed
on-chain activity. Positions on a profile come from trades, not from chain
balances, because attaching profit to shares whose cost was never observed
would invent it.

Win rate counts closed round trips, not individual trades — a position is
closed when its quantity returns to zero, and it wins if more cash came out
than went in. Counting sells would score every exit a win.

Return is measured against peak capital committed, not the closing balance:
after a round trip the closing balance *is* the profit or loss, so dividing
by it reports every loss as exactly -100%.

Each response carries its own limits. `coverageComplete` is false when any
trade in the window had no observable cost, which makes the profit figure
unreliable.

## Price Truth

`GET /api/price-truth` compares each token against every reference available
for it.

PreStocks publishes a mark, but that is the issuer valuing its own SPV. Pyth
publishes a 24/7 price for some of the same private companies from an
unrelated source — `Equity.Index.OPENAI/USD`, `ANTHROPIC/USD`, `SPCX/USD` —
so where it has coverage the token can be judged against something the issuer
does not control. Where the two references disagree, `referenceSpread` is
itself the finding: the token can only be mispriced *relative to* a
reference, and two references that disagree say the reference is uncertain.

Coverage is three of eight names, which is a fact about Pyth. Feed ids are
pinned rather than resolved by search, because a newly listed feed with a
similar name must never silently become the price money is judged against.

Hermes now rejects price reads without a key (HTTP 401) while leaving feed
discovery open. Without `PYTH_API_KEY` the oracle column is absent and the
response says so, rather than reporting a price of zero.

## What the API refuses, and why

A build is refused with 409 and *every* applicable reason, not the first one:
a wallet can simultaneously be short of balance and be asking for a shape that
cannot settle here.

| Refusal | Cause |
| --- | --- |
| `not-atomic` | The rebalance funds buys from sells. These are separate transactions, so the buy can land first. |
| `insufficient-balance` | The associated token account cannot cover a sell leg. |
| `insufficient-usdc` / `insufficient-sol` | Buy legs spend stablecoin, and every transaction pays a fee. |
| `paused` | The issuer has halted transfers on a constituent. Paused mints are also excluded from every index. |
| `unpriced-holding` | Part of the wallet could not be valued, so every other leg would be sized against a portfolio value that is too low. |

Frozen accounts are detected too: a frozen account reports its full balance,
so comparing amounts alone passes it and the swap fails on chain after the
user has signed.

## Mirroring

A portfolio is a set of target weights. `planRebalance` turns the gap between a
wallet and those weights into orders; `buildExecutionPlan` prices each order
against a live quote and refuses or resizes what the pools cannot absorb;
`buildMirrorBundle` turns the survivors into unsigned versioned transactions.

The user signs once, via `signAllTransactions`. Nothing is deposited and no key
is held here. The cost is that a basket is not atomic — it is several
transactions, and a partial fill is a real outcome callers must handle.
