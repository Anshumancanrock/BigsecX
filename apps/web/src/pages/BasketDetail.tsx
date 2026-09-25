/**
 * One basket: its current holdings and what $1,000 in it became, from the
 * same daily price history as every other chart.
 */

import { TokenLogo } from "../components/TokenLogo.tsx";
import { Ticking } from "../components/Ticker.tsx";
import { ApiError, api, type IndexDetail as Detail, type IndexList, type Market } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { list, shortAddress, usdCompact, weight } from "../lib/format.ts";
import { TradeLauncher } from "../features/trade/TradeLauncher.tsx";
import { go } from "../lib/router.ts";
import { PageHead } from "../components/PageHead.tsx";
import { PerformanceCard } from "../features/baskets/PerformanceCard.tsx";
import { BasketCover } from "../features/baskets/BasketCover.tsx";
import { schemeWords } from "../lib/words.ts";

/**
 * A system index or a published basket. Both are target weights behind
 * different endpoints: the index is tried first, then the strategy on a 404,
 * and the result decides whether a buy sends `indexId` or `strategyId`.
 */
type Resolved = { readonly kind: "index"; readonly value: Detail } | {
  readonly kind: "strategy";
  readonly value: Detail;
};

export function BasketDetail({ id, market }: { id: string; market: Market | null }) {
  const detail = useAsync<Resolved>(async (signal) => {
    try {
      return { kind: "index", value: await api.index(id, signal) };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      const strategy = await api.strategy(id, signal);
      return {
        kind: "strategy",
        value: {
          id: strategy.id,
          name: strategy.name,
          description: strategy.description ?? `Made by ${shortAddress(strategy.creator, 4, 4)}.`,
          scheme: strategy.rebalance,
          weights: strategy.weights,
          // Strategies carry no level history; the chart is simply absent.
          history: [],
        },
      };
    }
  }, [id]);
  // The whole market, for the dotted line a basket is measured against.
  const indexes = useAsync<IndexList>((signal) => api.indexes(signal), []);
  const everything = list(list(indexes.data?.indexes).find((i) => i.id === "pre8")?.weights);

  if (detail.error) {
    return (
      <div className="empty">
        This basket could not be found. It may have been a draft, or the link may be wrong.{" "}
        <a href="/baskets" onClick={go("/baskets")} style={{ textDecoration: "underline" }}>
          See all baskets
        </a>
        .
      </div>
    );
  }
  if (!detail.data) return <div className="shimmer" style={{ height: 380, marginTop: 18 }} />;

  const index = detail.data.value;
  const isStrategy = detail.data.kind === "strategy";
  const bySymbol = new Map(list(market?.tokens).map((t) => [t.symbol, t]));

  return (
    <>
      <PageHead title={index.name} back={{ href: "/baskets", label: "All baskets" }}>
        <TradeLauncher
          label="Buy this basket"
          title={`Buy ${index.name}`}
          prompt={`How much do you want to put in? It is split across the ${index.weights?.length ?? 0} companies below in the shares shown, paid for in USDC, and everything lands in your own wallet. Nothing you already own is sold.`}
          weights={index.weights}
          makeRequest={(owner, amountUsd) => ({
            kind: "mirror",
            owner,
            ...(isStrategy ? { strategyId: index.id } : { indexId: index.id }),
            deployUsd: amountUsd,
          })}
        />
      </PageHead>
      <div className="basket-hero">
        <BasketCover id={index.id} weights={index.weights} eager />
        <div>
          <p className="lede">{index.description}</p>
          {index.weights?.length ? (
            <p className="basket-hero-meta">
              {index.weights.length} {index.weights.length === 1 ? "company" : "companies"}
              {typeof index.scheme === "string" && schemeWords(index.scheme) ? ` · ${schemeWords(index.scheme)}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      {index.weights?.length ? (
        <PerformanceCard
          weights={index.weights}
          label="This basket"
          compare={index.id === "pre8" ? undefined : everything}
          compareLabel={index.id === "pre8" ? undefined : "Everything basket"}
        />
      ) : null}

      {!index.weights?.length ? (
        <div className="empty">
          Nothing in this basket can be bought right now — the market for these companies is too thin at the moment. Try again later.
        </div>
      ) : (
        <div className="card table-scroll" style={{ marginTop: 20 }}>
          <table className="table glass-table stacks">
            <thead>
              <tr>
                <th>Company</th>
                <th>Share of basket</th>
                <th>Price</th>
                <th>On offer</th>
              </tr>
            </thead>
            <tbody>
              {list(index.weights).map((w) => {
                const token = bySymbol.get(w.symbol);
                return (
                  <tr key={w.symbol}>
                    <td data-label="Company">
                      <a
                        className="cell-name"
                        href={`/companies/${w.symbol.toLowerCase()}`}
                        onClick={go(`/companies/${w.symbol.toLowerCase()}`)}
                      >
                        <TokenLogo symbol={w.symbol} size={34} />
                        <span>
                          <b>{token?.name ?? w.symbol}</b>
                          <small>{w.symbol}</small>
                        </span>
                      </a>
                    </td>
                    <td data-label="Share of basket" className="num">{weight(w.weight)}</td>
                    <td data-label="Price" className="num">
                      <Ticking value={token?.marketUsd ?? null} />
                    </td>
                    <td data-label="On offer" className="num">{usdCompact(token?.liquidityUsd ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
