/** Common questions, answered with the live fee and company list where they apply. */

import type { Market } from "../lib/api.ts";
import { list, usd } from "../lib/format.ts";
import { MIN_BASKET_USD, MIN_BUY_USD } from "../lib/limits.ts";
import { go } from "../lib/router.ts";

const FALLBACK_COMPANIES = ["OpenAI", "Anthropic", "SpaceX", "Anduril", "Neuralink", "Figure AI", "Kalshi", "Polymarket"];

function percentOf(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

function sentenceList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function FaqSection({ market }: { market: Market | null }) {
  const names = list(market?.tokens).map((t) => t.name);
  const companies = names.length > 0 ? names : FALLBACK_COMPANIES;
  const feeBps = market?.tokens[0]?.transferFeeBps ?? null;
  const pending = market?.pendingFeeChange ?? null;
  const whole = (value: number) => usd(value).replace(".00", "");

  const items: readonly { q: string; a: string }[] = [
    {
      q: "What is BasketX?",
      a: "An app for buying tokenized pre-IPO companies on Solana, one at a time or as a basket, straight from your own wallet. It also ranks traders by their on-chain results and lets you follow or copy them.",
    },
    {
      q: "What exactly am I buying?",
      a: "PreStocks tokens: Solana tokens issued by PreStocks that track private companies through a special-purpose vehicle. They give you economic exposure to the company, not shares in it, so there are no voting rights, and what happens at an IPO is set by the issuer.",
    },
    {
      q: "Which companies can I buy?",
      a: `${sentenceList(companies)}. Buy any of them on its own, in a ready-made basket such as the AI labs or space and defence, or in a basket you build yourself.`,
    },
    {
      q: "Does BasketX hold my money?",
      a: "No. Every trade is a Solana transaction that your wallet signs, and the tokens go straight to your own account. BasketX builds and relays the transaction, but it never holds your keys or your funds.",
    },
    {
      q: "What does it cost?",
      a:
        "BasketX adds no fee of its own. You pay the market price, the issuer's transfer fee" +
        (feeBps === null ? "" : ` of ${percentOf(feeBps)}`) +
        (pending ? ` (rising to ${percentOf(pending.toBps)} from Solana epoch ${pending.atEpoch})` : "") +
        ", and Solana network costs, including a small refundable deposit for each new token account. The review screen shows the total before you sign.",
    },
    {
      q: "What do I need to get started?",
      a: `A Solana wallet such as Phantom, Solflare or Backpack, some USDC to buy with, and a little SOL for network fees. The smallest order is ${whole(MIN_BUY_USD)} for one company and ${whole(MIN_BASKET_USD)} for a basket.`,
    },
    {
      q: "How is the leaderboard worked out?",
      a: "From trades read off the chain, never from anything a trader reports. Profit is measured against what each wallet actually paid, holdings are valued at today's price, and wallets whose history is incomplete are left out.",
    },
    {
      q: "What are the risks?",
      a: "The issuer can freeze, pause or move these tokens and can change the transfer fee. Liquidity is thin, so large orders move the price, and the market price can stay well away from the issuer's own valuation for long periods. Only put in what you can afford to lose.",
    },
  ];

  return (
    <section className="section qa">
      <div className="qa-head">
        <h2>
          Before you buy.
          <span>The questions people ask first.</span>
        </h2>
        <a className="qa-more" href="/learn" onClick={go("/learn")}>
          Read how it works
        </a>
      </div>
      <div className="qa-list">
        {items.map((item) => (
          <details key={item.q} className="qa-item">
            <summary>
              {item.q}
              <i aria-hidden="true" />
            </summary>
            <p className="qa-answer">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
