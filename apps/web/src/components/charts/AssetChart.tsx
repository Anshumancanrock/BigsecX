import { useMemo, useState } from "react";
import { api, type History, type Intraday } from "../../lib/api.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { useLivePrices } from "../../lib/live.ts";
import { useMarket } from "../../lib/market.ts";
import { PriceChart, type Grain, type PricePoint } from "./PriceChart.tsx";
import { Segmented } from "../Segmented.tsx";

const RANGES = [
  { key: "1D", grain: "hour", hours: 24, words: "the last day" },
  { key: "1W", grain: "week", hours: 168, words: "the last week" },
  { key: "1M", grain: "day", days: 30, words: "the last month" },
  { key: "1Y", grain: "year", days: 365, words: "the last year" },
] as const satisfies readonly { key: string; grain: Grain; hours?: number; days?: number; words: string }[];

type RangeKey = (typeof RANGES)[number]["key"];

export function AssetChart({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<RangeKey>("1M");
  const intraday = useAsync<Intraday>((signal) => api.intraday(168, signal), [], { pollMs: 5 * 60_000 });
  const history = useAsync<History>((signal) => api.history(365, signal), []);
  // The newest point follows the live price between fetches (lib/live.ts).
  const market = useMarket();
  const liveIntraday = useLivePrices(intraday.data, market);
  const liveHistory = useLivePrices(history.data, market);
  const active = RANGES.find((r) => r.key === range)!;

  const points = useMemo<PricePoint[]>(() => {
    if ("hours" in active) {
      const data = liveIntraday;
      if (!data) return [];
      const series = data.prices[symbol] ?? [];
      const from = Math.max(0, data.times.length - active.hours - 1);
      return data.times.slice(from).map((t, i) => ({ t: t * 1000, v: series[from + i] ?? null }));
    }
    const data = liveHistory;
    if (!data) return [];
    const series = data.prices[symbol] ?? [];
    const from = Math.max(0, data.days.length - active.days - 1);
    const lastDay = data.days.length - 1;
    return data.days.slice(from).map((day, i) => ({
      // Today's point is the live price, so it sits at now, not midnight.
      t: from + i === lastDay ? Date.parse(data.asOf) : Date.parse(`${day}T00:00:00Z`),
      v: series[from + i] ?? null,
    }));
  }, [active, liveIntraday, liveHistory, symbol]);

  const drawn = points.filter((p) => p.v !== null);
  const change = drawn.length > 1 ? drawn[drawn.length - 1]!.v! / drawn[0]!.v! - 1 : null;
  const loading = "hours" in active ? !intraday.data && !intraday.error : !history.data && !history.error;

  return (
    <section className="card asset-chart">
      <div className="asset-chart-head">
        <span className="eyebrow">Market price</span>
        <Segmented
          label="Time range"
          options={RANGES.map((r) => ({ value: r.key, label: r.key }))}
          value={range}
          onChange={setRange}
        />
      </div>
      {loading ? (
        <div className="chart-empty" style={{ height: 320 }}>
          <span className="spin" /> Fetching prices…
        </div>
      ) : (
        <PriceChart points={points} grain={active.grain} height={320} />
      )}
      <p className="note asset-chart-note">
        {change === null ? (
          " "
        ) : (
          <>
            <b className={change >= 0 ? "up" : "down"}>
              {change >= 0 ? "+" : ""}
              {(change * 100).toFixed(2)}%
            </b>{" "}
            over {active.words}, at the price the market actually pays.
          </>
        )}
      </p>
    </section>
  );
}
