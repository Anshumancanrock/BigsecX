import type { LeaderboardEntry } from "../../lib/api.ts";
import { go } from "../../lib/router.ts";
import { Face } from "../people/Face.tsx";
import { FollowButton } from "../people/FollowButton.tsx";
import { displayName, signedMoney, signedReturn } from "../../lib/format.ts";
import { TIER, PLACE, Trophy } from "./Trophy.tsx";
import { HoldingLogos, holdingsOf } from "./HoldingLogos.tsx";

export type Metric = "pnl" | "return";

export function TopThree({
  entries,
  metric,
  me,
  followed,
}: {
  entries: readonly LeaderboardEntry[];
  metric: Metric;
  me: string | null;
  followed: ReadonlySet<string>;
}) {
  return (
    <section className="podium" aria-label="Top three traders">
      {entries.slice(0, 3).map((entry, i) => {
        const rank = (i + 1) as 1 | 2 | 3;
        const main = metric === "pnl" ? signedMoney(entry.pnlUsd) : signedReturn(entry.returnFraction);
        const side = metric === "pnl" ? signedReturn(entry.returnFraction) : signedMoney(entry.pnlUsd);
        const up = (metric === "pnl" ? entry.pnlUsd : entry.returnFraction) >= 0;
        const page = `/traders/${entry.owner}`;
        return (
          <div key={entry.owner} className={`podium-card ${TIER[i]}`}>
            <a className="podium-person" href={page} onClick={go(page)}>
              <span className="podium-trophy">
                <Trophy rank={rank} size={rank === 1 ? 60 : 50} />
              </span>
              <span className="podium-place">{PLACE[i]} place</span>
              <span className="podium-face">
                <Face wallet={entry.owner} avatar={entry.avatar} size={rank === 1 ? 68 : 56} />
              </span>
              <b className="podium-name">{displayName(entry.owner, entry.name, entry.handle)}</b>
              <HoldingLogos symbols={holdingsOf(entry)} size={16} label={false} />
              <span className={`podium-main num ${up ? "up" : "down"}`}>{main}</span>
              <span className="podium-side">
                <span className="num">{side}</span> {metric === "pnl" ? "return" : "profit"}
              </span>
            </a>
            <span className="podium-action">
              {me === entry.owner ? (
                <span className="you-tag">You</span>
              ) : (
                <FollowButton wallet={entry.owner} following={followed.has(entry.owner)} size="sm" />
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}

export function PodiumGhost() {
  return (
    <div className="podium" aria-hidden="true">
      {TIER.map((tier) => (
        <span key={tier} className={`podium-card ${tier} ghost`} />
      ))}
    </div>
  );
}
