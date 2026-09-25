# Bigsec

Non-custodial trading for [PreStocks](https://prestocks.com) tokenized pre-IPO equity on Solana.

Buy a single company or a full basket with one signature, follow the traders who are right, copy their
positions by weight, and see where you rank on a leaderboard built entirely from on-chain history. The
server never holds a key: it returns unsigned transactions, your wallet signs them in the browser, and the
API only verifies and relays what you signed.

Live prices, baskets, social trading and execution live in one app. No custody, no extra wallets to fund,
and the issuer's powers over every token are shown where you trade.

## Features

- **One-signature buys** for a single company or a whole basket, packed into as few transactions as fit.
- **Baskets**: seven system baskets plus user-published ones, every leg sized against live Jupiter depth.
- **Selling**: exit any position, in full or in part, sized from real on-chain balances.
- **Social trading**: profiles, follows, a feed of followed wallets, and copy trading by weight.
- **On-chain leaderboard**: profit against the cost basis actually paid, never self-reported.
- **Disclosure**: freeze, pause, permanent delegate and fee authority shown on every company.
- **Responsive**: the same features on phone and desktop, each with its own layout.

## How trading works

1. **Plan.** Pick a target: a system basket, a published basket or custom weights. Every leg is quoted at
   its real size against live depth, and legs a pool cannot absorb are resized or deferred.
2. **Build.** The API returns unsigned v0 transactions with per-leg slippage and the Token-2022 transfer
   fee built in. A build is refused, with every reason listed, if the wallet lacks USDC or SOL or a token
   is paused.
3. **Simulate.** The bundle runs against live mainnet state before anything is signed. PreStocks exist
   only on mainnet, so there is no testnet to rehearse on.
4. **Sign and submit.** The wallet signs in the browser; the app checks that the wallet signed what it was
   given, and the API verifies every signature before relaying.
5. **Confirm.** Statuses come back with the current block height, so a slow transaction is never mistaken
   for an expired one. Landed trades are recorded immediately.

Transactions in a bundle settle independently, so partial fills are possible and reported per leg.

## Architecture

| Path | Responsibility |
| --- | --- |
| `packages/core` | Pure domain logic: Token-2022 unit and fee math, indexes, rebalancing, execution policy, P&L |
| `packages/chain` | Solana RPC client with endpoint failover, mint parsing, trade reconstruction |
| `packages/market` | Jupiter, PreStocks, Pyth and GeckoTerminal clients, market snapshot, execution planner |
| `packages/tx` | Unsigned swap transaction building and packing |
| `packages/db` | SQLite schema, migrations and the store |
| `apps/api` | Hono HTTP API: routes in `src/routes`, shared helpers in `src/lib` |
| `apps/indexer` | Snapshots, index levels and trade history on an interval |
| `apps/web` | React app and landing page, served as a static build with `/api` proxied |

Built with Bun, TypeScript, React and Hono.

## Getting started

Requires [Bun](https://bun.sh) 1.3 or later.

```bash
bun install
cp .env.example .env   # optional, every variable has a default
bun run start          # API on :3111, indexer, site on :4000
```

| Command | Purpose |
| --- | --- |
| `bun test` | Full test suite, no network needed |
| `bun run typecheck` / `bun run typecheck:web` | Type checks for the server side and the web app |
| `bun run api` / `bun run indexer` / `bun run web` | Run a single process |

### Configuration

| Variable | Purpose |
| --- | --- |
| `SOLANA_RPC_URL` | RPC endpoints, comma separated, in failover order |
| `INDEXER_RPC_URL` | A separate endpoint for the indexer |
| `JUPITER_API_KEY` | Jupiter's keyed tier |
| `DATABASE_PATH` | SQLite file; defaults to `data/prestocks.db` |
| `ALLOWED_ORIGINS` | Browser origins allowed to call the API in production |

See `.env.example` for the full list.

## Deployment

The `Dockerfile` builds the site at image build time and runs the API, indexer and web server in one
container on `$PORT`. Mount a volume for the SQLite file, or profiles, follows and published baskets reset
on restart.

`.github/workflows/master_bigsec.yml` deploys every push to `master` to Azure App Service.

## Security

- State-changing writes require an Ed25519 wallet signature bound to the action, resource and request body,
  and each signature is accepted once.
- Profiles and follows use a session token from one signed sign-in message, stored hashed.
- Writes must be JSON, so every cross-origin request is preflighted against `ALLOWED_ORIGINS`.
- Requests are rate limited per client, weighted by upstream cost.
- Uploaded pictures are verified from their bytes and refused if they carry metadata.
- The production server sends a strict CSP with its one inline script pinned by hash.

## Disclaimer

PreStocks tokens are issuer-controlled SPV exposure, not shares. Liquidity is thin, prices can diverge
from the issuer's mark, and the issuer can freeze, pause or claw back tokens. Bigsec is experimental
software and not financial advice.
