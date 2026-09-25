/**
 * How it works, what it costs, and the risks. Fees and issuer powers are read
 * live; questions only the issuer can answer link to the issuer.
 */

import type { Market } from "../lib/api.ts";
import { list } from "../lib/format.ts";
import { feeChangeWords, feeWords } from "../lib/words.ts";
import { go } from "../lib/router.ts";
import { PageHead } from "../components/PageHead.tsx";

const STEPS = [
  {
    title: "Get a Solana wallet",
    body: "Phantom and Solflare are free. On a computer it is a browser extension; on a phone, install the app and open this site from inside it.",
  },
  {
    title: "Add USDC and a little SOL",
    body: "USDC is a digital dollar, and it is what you buy with. SOL pays the network fee. Buy both on an exchange and withdraw to your wallet on the Solana network.",
  },
  {
    title: "Pick a company or a basket",
    body: "Put in any amount from $5 for one company, or $25 for a basket. You do not need to buy a whole token.",
  },
  {
    title: "See the exact price, then approve",
    body: "Before your wallet asks for anything you see what you pay, what it costs, and what you get. Nothing moves until you approve it in your wallet.",
  },
  {
    title: "Sell whenever you like",
    body: "Everything you own is under What I own. Selling works the same way in reverse, and the money comes back as USDC.",
  },
] as const;

export function Learn({ market }: { market: Market | null }) {
  const feeBps = list(market?.tokens)[0]?.transferFeeBps ?? null;
  const fee = feeBps === null ? "A fee on every buy and sell" : feeWords(feeBps).replace(/^./, (c) => c.toUpperCase());
  const feeChange = feeChangeWords(market?.pendingFeeChange, market?.epoch);

  return (
    <div className="learn">
      <PageHead title="How it works" />
      <section className="card">
        <h2>Five steps</h2>
        <ol className="learn-steps">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <span className="learn-num">{i + 1}</span>
              <span>
                <b>{step.title}</b>
                <span className="note" style={{ display: "block" }}>
                  {step.body}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <p className="note">
          <a href="/companies" onClick={go("/companies")} style={{ textDecoration: "underline" }}>
            Browse companies
          </a>{" "}
          or{" "}
          <a href="/baskets" onClick={go("/baskets")} style={{ textDecoration: "underline" }}>
            start with a basket
          </a>
          .
        </p>
      </section>

      <section className="card">
        <h2>What you are buying</h2>
        <p className="note">
          Each of these is a token issued by PreStocks, not by the company itself. The issuer says its price tracks the
          company's value. Owning one does not make you a shareholder, and it is not stock. What happens to the token
          if the company lists on an exchange or is sold is decided by the issuer: read their terms at{" "}
          <a href="https://prestocks.com" target="_blank" rel="noreferrer noopener" style={{ textDecoration: "underline" }}>
            prestocks.com
          </a>
          , which also say who is allowed to buy them where you live.
        </p>
        <p className="note">
          Bigsec never holds your money. It prepares each trade; your wallet signs it; the tokens go straight into your
          own wallet.
        </p>
      </section>

      <section className="card">
        <h2>What it costs</h2>
        <div className="kv">
          <span>The issuer's fee</span>
          <span>{fee}</span>
        </div>
        {feeChange ? (
          <p className="note down" style={{ marginTop: 6 }}>
            {feeChange}
          </p>
        ) : null}
        <div className="kv">
          <span>The price gap</span>
          <span style={{ textAlign: "right", maxWidth: "60%" }}>
            Small markets charge more to buy than they pay to sell. You see the exact figure before you approve.
          </span>
        </div>
        <div className="kv">
          <span>Network fee</span>
          <span>A fraction of a cent, paid in SOL</span>
        </div>
        <div className="kv">
          <span>First time you hold a company</span>
          <span style={{ textAlign: "right", maxWidth: "60%" }}>
            About 0.002 SOL goes into a new account for it in your wallet. You can get it back later by closing the
            empty account.
          </span>
        </div>
        <div className="kv">
          <span>Bigsec</span>
          <span>Nothing</span>
        </div>
      </section>

      <section className="card">
        <h2>The risks</h2>
        <ul className="learn-risks">
          <li>
            <b>Prices move a lot.</b> These are private companies traded in small markets. You can lose money, including
            all of it.
          </li>
          <li>
            <b>Selling can be slow or expensive.</b> If few people are buying, you may have to accept a lower price or
            sell a little at a time.
          </li>
          <li>
            <b>The price can differ from the official one.</b> The market price is what people pay; the issuer
            publishes its own. The gap can be large in either direction.
          </li>
          <li>
            <b>The issuer keeps powers over the tokens.</b> It can freeze them so they cannot be sold, pause all
            trading, and move them out of any wallet. Each company's page lists the ones that apply.
          </li>
          <li>
            <b>Baskets go through one company at a time.</b> You approve them together, but each is a separate
            transaction, so occasionally some go through and others do not. You always see exactly which.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>Questions</h2>
        <details className="faq">
          <summary>Is there a way to try it without spending anything?</summary>
          <p className="note">
            Yes. On the review screen, "Test run" runs the exact trade against the live market and throws the result
            away. Nothing is signed or spent. There is no practice mode with fake money, because these tokens only exist
            on the real network.
          </p>
        </details>
        <details className="faq">
          <summary>Where do my tokens go?</summary>
          <p className="note">
            Into your own wallet. You will see them in Phantom or Solflare as well as here, and you can send them
            anywhere you could send any other token.
          </p>
        </details>
        <details className="faq">
          <summary>What does copying a trader do?</summary>
          <p className="note">
            It buys the same mix of companies that trader holds right now, in proportion, with the amount you choose. It
            is a one-off: it does not follow their future trades, and nothing you already own is sold.
          </p>
        </details>
        <details className="faq">
          <summary>Why did my basket skip a company?</summary>
          <p className="note">
            Each company in a basket gets its share of your amount. When a share is under $5, the fees would eat too
            much of it, so it is skipped and the money stays in your wallet. The review always lists what was left out
            and why.
          </p>
        </details>
      </section>
    </div>
  );
}
