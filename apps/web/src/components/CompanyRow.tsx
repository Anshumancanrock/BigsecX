import { type MarketToken } from "../lib/api.ts";
import { price } from "../lib/format.ts";
import { Ticking } from "./Ticker.tsx";
import { go } from "../lib/router.ts";
import { TokenLogo } from "./TokenLogo.tsx";

export function CompanyRow({ token, onPick }: { token: MarketToken; onPick?: () => void }) {
  const page = `/companies/${token.symbol.toLowerCase()}`;
  const move = token.change24hPct;
  return (
    <a
      className="row"
      href={page}
      onClick={(event) => {
        onPick?.();
        go(page)(event);
      }}
    >
      <TokenLogo symbol={token.symbol} size={42} />
      <span className="row-main">
        <b>{token.symbol}</b>
        <small>{token.name}</small>
      </span>
      <span className="row-side">
        <b className="num">
          <Ticking value={token.marketUsd} format={price} />
        </b>
        <small className={`num ${move == null ? "muted" : move >= 0 ? "up" : "down"}`}>
          {move == null ? "—" : `${move >= 0 ? "+" : ""}${move.toFixed(2)}%`}
        </small>
      </span>
    </a>
  );
}
