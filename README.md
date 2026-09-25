# BasketX

Non-custodial trading for [PreStocks](https://prestocks.com) tokenized pre-IPO
equity on Solana. Buy a single company or a whole basket in one signature,
follow and copy traders, and rank them on a leaderboard built from on-chain
trade history.

Nothing on the server holds a key. The API returns unsigned versioned
transactions; the wallet signs them in the browser and the API relays them.

## Features

- **Companies and baskets.** Live prices, liquidity, the gap between market
  price and issuer mark, and daily price history for every PreStocks token.
  Seven system baskets (thematic, valuation, liquidity and value weighted)
  and baskets published by users.
- **One-signature baskets.** A basket is quoted leg by leg against live
  Jupiter depth, resized where a pool cannot absorb the order, and packed into
  as few transactions as fit. Every leg is simulated against mainnet before
  anything is signed.
- **Selling.** Sell all or part of any position, sized from on-chain balances.
- **Social trading.** Profiles, follows, a feed of followed wallets' trades,
  copy trading by weight, and a leaderboard ranked by profit against the cost
  basis observed on chain.
- **Disclosure.** The issuer's on-chain powers (freeze, pause, permanent
  delegate, fee authority) and any scheduled transfer-fee change are shown
  where users trade.

## Architecture

```
            browser (React, Wallet Standard)
                 │  unsigned tx ▲   │ signed tx
                 ▼              │   ▼
   apps/web ──── /api proxy ──► apps/api (Hono) ────► Solana RPC, Jupiter,
                                   │                   PreStocks API, Pyth,
                                   │ SQLite            GeckoTerminal
                                   ▼
                              packages/db ◄──── apps/indexer (every 5 min)
```

| Path | Responsibility |
| --- | --- |
| `packages/core` | Pure domain logic: Token-2022 unit and transfer-fee math, the token universe, index construction, rebalancing, execution policy, trader P&L. No I/O. |
| `packages/chain` | Read-only Solana JSON-RPC client with endpoint failover; Token-2022 mint and account parsing; trade reconstruction from transaction history. |
| `packages/market` | Jupiter, PreStocks, Pyth and GeckoTerminal clients, the market snapshot, and the execution planner. |
| `packages/tx` | Builds and packs the unsigned swap transactions for a target allocation. |
| `packages/db` | SQLite schema, forward-only migrations and the `Store` repository. |
| `apps/api` | HTTP API. `src/app.ts` composes middleware and the route modules in `src/routes/`; shared helpers live in `src/lib/`. |
| `apps/indexer` | Records market snapshots, index levels and trades on an interval, plus diagnostic CLIs. |
| `apps/web` | The site: landing page, app shell, pages, and the build and preview servers. |

The web app is organised by responsibility:

```
apps/web/src
├── app/          shell, routes, desktop frame, phone tab bar
├── pages/        one component per route
├── features/     trade, wallet, people, leaderboard, baskets
├── components/   shared UI: sheets, charts, toasts, logos
├── landing/      marketing page and its three.js phone
├── lib/          API client, wallet protocol, formatting, hooks
└── styles/       design tokens and stylesheets
```

## Getting started

Requires [Bun](https://bun.sh) 1.3 or later.

```bash
bun install
cp .env.example .env    # optional; every variable has a default
bun run start
```

`bun run start` typechecks and builds the web app, then runs the API on
`:3111`, the indexer, and the site on `:4000` with `/api` proxied to the API.
Open <http://localhost:4000>. Ctrl+C stops all three.

To run the processes separately:

```bash
bun run api                     # API with hot reload
bun run indexer                 # INDEXER_ONCE=1 for a single pass
bun run web                     # dev server that rebuilds on each page load
```

### Scripts

| Command | What it does |
| --- | --- |
| `bun test` | All tests. No network access is needed. |
| `bun run typecheck` | Packages, API, indexer and scripts. |
| `bun run typecheck:web` | The web app, with DOM types and JSX. |
| `cd apps/web && bun run build` | Production bundle in `apps/web/.build`. |
| `cd apps/web && bun run preview` | Serves the build with `/api` proxied, as a deployment would. |

Diagnostic CLIs, run against mainnet:

```bash
bun run apps/indexer/src/cli.ts                             # live market snapshot
bun run apps/indexer/src/indexes-cli.ts pre8 1000           # index weights and a priced plan
bun run apps/indexer/src/mirror-cli.ts <wallet> pre8 3000   # build and simulate real transactions
```

### Configuration

All configuration is environment variables; `.env.example` documents each one.

| Variable | Purpose |
| --- | --- |
| `SOLANA_RPC_URL` | RPC endpoints, comma separated, in order of preference. Defaults to public endpoints. |
| `INDEXER_RPC_URL` | A separate endpoint for the indexer, so its passes do not share the API's rate limit. |
| `JUPITER_API_KEY` | Moves quoting to Jupiter's keyed tier. Recommended: a basket needs two calls per leg. |
| `PYTH_API_KEY` | Enables the Pyth reference price in `/api/price-truth`. |
| `DATABASE_PATH` | SQLite file. Defaults to `data/prestocks.db` at the repository root. |
| `ALLOWED_ORIGINS` | Browser origins allowed to call the API. Unset allows any, which is only right locally. |
| `TRUST_PROXY` | Set to `1` only behind a proxy that overwrites `X-Forwarded-For`. |
| `API_BASE` | Build-time API origin for the web bundle. Empty (the default) means same origin. |

## How trading works

1. **Plan.** `POST /api/mirror/plan` resolves the target (a system index, a
   published basket, or inline weights), plans the orders, and quotes each leg
   at its real size. Legs that exceed a pool's depth are resized or deferred,
   and the cost is reported against a reference price.
2. **Build.** `POST /api/mirror/build` repeats the same planning and returns
   unsigned v0 transactions. Slippage is set per leg from its measured impact,
   plus the Token-2022 transfer fee the leg will pay when it lands. The build
   is refused, with every problem listed, when the wallet lacks the USDC or
   SOL it needs or a token is paused.
3. **Rehearse.** `POST /api/simulate` executes the bundle against mainnet
   state without signatures. PreStocks mints exist only on mainnet and Jupiter
   has no devnet router, so there is no testnet to use instead.
4. **Sign and submit.** The browser signs through the Wallet Standard and
   checks that every returned message is byte-identical to what it sent.
   `POST /api/submit` verifies each signature before relaying.
5. **Confirm.** `POST /api/confirm` returns statuses together with the current
   block height, so an unconfirmed transaction can be told apart from one
   whose blockhash has expired. Landed trades are recorded immediately via
   `POST /api/trades/record`; the indexer picks up everything else.

Transactions in a bundle settle independently, so a partial fill is possible
and is reported per leg.

## Protocol notes

- **Raw units.** Jupiter quotes are in raw base units and ignore the
  ScaledUiAmount multiplier (5 for SpaceX). `packages/core/src/units.ts` ports
  the on-chain conversion exactly.
- **Transfer fees change at epoch boundaries.** Each mint carries an older and
  a newer fee schedule. The fee in force is selected per epoch, and a build
  close to a scheduled change allows for the higher fee.
- **Whether a quote nets the transfer fee depends on the route**, so the
  planner takes the fee off every quote.
- **Only the associated token account is spendable by a swap.** Balances held
  in other accounts are reported separately and never used to size a sale.
- **Liquidity is thin**, about $2.6M quotable across eight tokens, which is
  why every leg is quoted at its actual size.
- **The issuer controls the asset.** A single key holds mint, freeze, pause,
  permanent delegate and fee authority on every PreStocks mint. The app
  discloses this; a non-custodial app cannot remove it.

## Security

- Write routes that change state a wallet owns require an Ed25519 signature
  over a canonical message bound to the action, resource, wallet, time and a
  digest of the body. Signatures are single use.
- Profiles and follows use a 30-day session token obtained by signing one
  sign-in message; tokens are stored hashed.
- Mutating requests must be `application/json`, which forces a CORS preflight
  so `ALLOWED_ORIGINS` is enforced.
- Requests are rate limited per client, weighted by upstream cost.
- User-supplied text is normalised and stripped of bidi, invisible and control
  characters. Uploaded pictures are verified from their bytes (PNG, JPEG or
  WebP only) and refused if they carry metadata.
- The production server sends a strict CSP with the one inline script pinned
  by hash, `frame-ancestors 'none'`, and it overwrites forwarding headers.

## API reference

| Area | Endpoints |
| --- | --- |
| Market | `GET /api/market`, `/api/universe`, `/api/price-truth`, `/api/assets`, `/api/assets/:symbol`, `/api/history`, `/api/history/intraday` |
| Indexes | `GET /api/indexes`, `/api/indexes/:id` |
| Trading | `POST /api/mirror/plan`, `/api/mirror/build`, `/api/exit/plan`, `/api/exit/build`, `/api/simulate`, `/api/submit`, `/api/confirm` |
| Portfolio | `GET /api/portfolio/:wallet`, `/api/portfolio/:wallet/:symbol`, `/api/cash/:wallet` |
| Strategies | `GET /api/strategies`, `/api/strategies/:id`; `POST /api/strategies`, `/api/strategies/mine`, `/api/strategies/overlap`, `/api/strategies/:id/drift`; `PUT` and `DELETE /api/strategies/:id` |
| Traders | `GET /api/leaderboard`, `/api/traders/:wallet`, `/api/traders/:wallet/trades`, `/api/trades/recent`; `POST /api/trades/record` |
| Copy trading | `POST /api/copy/preview`, `/api/copy/build`, `/api/copy/stop-check` |
| Social | `POST /api/auth/message`, `/api/session`, `/api/session/end`, `/api/profile`, `/api/profile/avatar`, `/api/follows`; `GET /api/profiles`, `/api/profiles/:wallet`, `/api/handles/:handle`, `/api/feed/:wallet`, `/api/avatars/:wallet` |

## Deployment

The API and indexer need a persistent disk for the SQLite database; the web
bundle is static. A single small VM runs all three with `bun run start`.
Behind a reverse proxy, set `ALLOWED_ORIGINS` and `TRUST_PROXY=1`, and make
sure the proxy overwrites `X-Forwarded-For` rather than appending the
client's value.

The `Dockerfile` builds the site while the image is built and runs all three
processes in one container on `$PORT` (10000 by default):

```bash
docker build -t basketx .
docker run -p 10000:10000 -v basketx-data:/app/data basketx
```

Without a persistent volume the database starts empty on every restart: the
indexer refills recent trades, but profiles, follows and published baskets
are lost.

## Disclaimer

PreStocks tokens give economic exposure through an issuer-controlled SPV; they
are not shares. Prices can diverge from the issuer's mark for long periods,
liquidity is thin, and the issuer can freeze, pause or claw back tokens. This
project is experimental software and not financial advice.
