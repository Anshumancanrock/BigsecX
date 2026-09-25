/**
 * Every basket: the system indexes, then community baskets. A null `weights`
 * is a valid state (a liquidity floor selected nothing), not an error.
 */

import { api, type History, type IndexList, type StrategyDto } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { ago, list, pct, shortAddress, weight } from "../lib/format.ts";
import { schemeWords } from "../lib/words.ts";
import { navigate, go } from "../lib/router.ts";
import { PageHead } from "../components/PageHead.tsx";
import { growthOf } from "../features/baskets/PerformanceCard.tsx";
import { useCompanyName, useMarket } from "../lib/market.ts";
import { useLivePrices } from "../lib/live.ts";
import { BasketCover } from "../features/baskets/BasketCover.tsx";

export function Baskets() {
  const indexes = useAsync<IndexList>((signal) => api.indexes(signal), [], { pollMs: 60_000 });
  const community = useAsync((signal) => api.strategies(signal), []);
  const fetched = useAsync<History>((signal) => api.history(365, signal), []);
  // Each basket's figure follows the live prices between fetches (lib/live.ts).
  const history = { data: useLivePrices(fetched.data, useMarket()) };
  const nameOf = useCompanyName();

  return (
    <>
      <PageHead title="Baskets">
        <a className="btn-ghost with-icon" href="/build" onClick={go("/build")}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Build your own
        </a>
      </PageHead>

      {/* Short enough to stay on one line when the age is added, so the
          grid below does not drop when the baskets arrive. */}
      <p className="lede">
        Ready-made mixes, bought in one go. Prices update live
        {indexes.data ? ` · ${ago(indexes.data.takenAt)}` : ""}.
      </p>

      {indexes.error ? (
        <div className="banner bad">Could not load the baskets just now. This page will retry on its own.</div>
      ) : !indexes.data ? (
        <div className="grid wide">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="shimmer" key={i} style={{ height: 220 }} />
          ))}
        </div>
      ) : (
        <div className="grid wide">
          {list(indexes.data.indexes).map((index, i) => (
            <button
              style={{ "--i": i } as React.CSSProperties}
              className="tile basket-tile cascade"
              key={index.id}
              // Link to the current /baskets/ path; the legacy /indexes/ path still
              // resolves but is not a navigation target.
              onClick={() => navigate(`/baskets/${index.id}`)}
            >
              <BasketCover id={index.id} weights={index.weights} />
              <span className="basket-body">
                <span className="tile-name">{index.name}</span>
                <BasketGrowth history={history.data} weights={index.weights} />
                <span className="tile-note basket-desc">{index.description}</span>
              </span>

              {index.weights?.length ? (
                <span className="basket-foot">
                  <span className="stack" style={{ width: "100%", display: "flex" }}>
                    {list(index.weights).map((w, i) => (
                      <i
                        key={w.symbol}
                        title={`${nameOf(w.symbol)} ${weight(w.weight)}`}
                        style={{ width: `${w.weight * 100}%`, opacity: 1 - i * 0.09 }}
                      />
                    ))}
                  </span>
                  <span className="tile-note" style={{ marginTop: 9, display: "block" }}>
                    {list(index.weights).length} companies · {schemeWords(index.scheme)}
                  </span>
                  <span className="tile-cta">Buy this basket →</span>
                </span>
              ) : (
                <span className="basket-foot">
                  <span className="pill warn">nothing buyable right now</span>
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="section-head">
        <h2>Made by other people</h2>
        <a href="/build" onClick={go("/build")}>
          Build your own
        </a>
      </div>
      {!community.data && !community.error ? (
        <div className="shimmer" style={{ height: 120 }} />
      ) : list(community.data?.strategies).length ? (
        <div className="grid wide">
          {list(community.data?.strategies).map((strategy: StrategyDto) => (
            <button className="tile basket-tile" key={strategy.id} onClick={() => navigate(`/baskets/${strategy.id}`)}>
              <BasketCover id={strategy.id} weights={strategy.weights} />
              <span className="basket-body">
                <span className="tile-name">{strategy.name}</span>
                <BasketGrowth history={history.data} weights={strategy.weights} />
              </span>
              <span className="basket-foot">
                <span className="tile-note">
                  {list(strategy.weights).length} companies · by {shortAddress(strategy.creator, 4, 4)}
                </span>
                <span className="tile-cta">Buy this basket →</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty">
          Nobody has shared a basket yet.{" "}
          <a href="/build" onClick={go("/build")} style={{ textDecoration: "underline" }}>
            Be the first
          </a>
          .
        </div>
      )}
    </>
  );
}

/**
 * The basket's return over the available price history, the same figure its
 * own page leads with. The line keeps its height while the history loads.
 */
function BasketGrowth({
  history,
  weights,
}: {
  history: History | null;
  weights: readonly { readonly symbol: string; readonly weight: number }[] | null | undefined;
}) {
  const growth = history && weights?.length ? growthOf(history, weights) : null;
  return (
    <span className="tile-growth">
      {growth ? (
        <>
          <b className={growth.change >= 0 ? "up" : "down"}>{pct(growth.change * 100, 1)}</b> since {growth.since}
        </>
      ) : (
        " "
      )}
    </span>
  );
}
