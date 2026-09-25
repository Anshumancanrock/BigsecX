/**
 * The copy-trading section under the hero: a headline in a panel surrounded
 * by nine trade cards on slow orbits, the six behind the headline blurred.
 * The cards are illustrations; real wallets are on the leaderboard. Bigsec
 * trades spot tokens only, so every card is a Buy or a Sell.
 */

import { useEffect, useRef, useState } from "react";

interface Pod {
  readonly handle: string;
  readonly ago: string;
  readonly note: string;
  readonly side: "buy" | "sell";
  readonly symbol: string;
  readonly mark: string;
  readonly size: string;
  readonly change: string;
  readonly sharp: boolean;
  readonly r: number;
  readonly dur: number;
  readonly delay: number;
  readonly reverse: boolean;
  readonly tilt: number;
}

const PODS: readonly Pod[] = [
  { handle: "@anya.sol", ago: "2h", note: "Launch cadence keeps climbing", side: "buy", symbol: "SPACEX", mark: "X", size: "$420", change: "+41.2%", sharp: false, r: 37, dur: 16, delay: -3, reverse: false, tilt: -2 },
  { handle: "@dkessler", ago: "5h", note: "Defence budgets only go one way", side: "buy", symbol: "ANDURIL", mark: "A", size: "$180", change: "+12.8%", sharp: false, r: 35, dur: 19, delay: -9, reverse: true, tilt: 2.5 },
  { handle: "@marisol_v", ago: "1d", note: "Took profit after the run", side: "sell", symbol: "KALSHI", mark: "K", size: "$95", change: "+9.4%", sharp: false, r: 32, dur: 14, delay: -6, reverse: false, tilt: 1.5 },
  { handle: "@ananyaq", ago: "3h", note: "Still early on the enterprise side", side: "buy", symbol: "ANTHROPIC", mark: "A", size: "$1.2k", change: "+63.0%", sharp: true, r: 38, dur: 17, delay: -12, reverse: true, tilt: -1.5 },
  { handle: "@devinchu", ago: "6h", note: "Rotating out before the next round", side: "sell", symbol: "OPENAI", mark: "O", size: "$640", change: "−8.1%", sharp: true, r: 27, dur: 15, delay: -2, reverse: false, tilt: 3 },
  { handle: "@lenamoss", ago: "4h", note: "Small bet on the long shot", side: "buy", symbol: "NEURALINK", mark: "N", size: "$60", change: "+17.8%", sharp: false, r: 28, dur: 13, delay: -7, reverse: true, tilt: -3 },
  { handle: "@okuchi", ago: "9h", note: "Trimming into the quiet months", side: "sell", symbol: "POLYMARKET", mark: "P", size: "$210", change: "−4.6%", sharp: false, r: 33, dur: 18, delay: -14, reverse: false, tilt: 2 },
  { handle: "@b.fontaine", ago: "12h", note: "Rebalanced into the whole basket", side: "buy", symbol: "EVERYTHING", mark: "E", size: "$2k", change: "+2.3%", sharp: false, r: 36, dur: 12.5, delay: -5, reverse: true, tilt: -2.5 },
  { handle: "@lucasbrt", ago: "30m", note: "Robots on the line, finally", side: "buy", symbol: "FIGUREAI", mark: "F", size: "$300", change: "+22.4%", sharp: true, r: 30, dur: 14.5, delay: -10, reverse: false, tilt: 1 },
];

const AVATAR = ["#f6d7c3", "#cfe3f7", "#d9f0d3", "#efd9f3", "#f7ecc4", "#d6ecec"];

function avatarFor(handle: string): string {
  let h = 0;
  for (const c of handle) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR[h % AVATAR.length]!;
}

export function TradersSection() {
  const root = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShown(true);
        seen.disconnect();
      },
      { rootMargin: "0px 0px -80px 0px" },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const watch = new IntersectionObserver(([entry]) => setLive(entry?.isIntersecting ?? false));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  return (
    <section className={`tr${shown ? " in" : ""}${live ? " live" : ""}`} ref={root}>
      <div className="tr-head">
        {/* In a line box of its own, so it aligns with the heading's first line rather
   than flush with its top. */}
        <div>
          <span className="tr-eyebrow">
            <span className="tr-eyebrow-box" aria-hidden="true" />
            Copy trading
          </span>
        </div>
        <h2 className="tr-title">
          <span>Follow the best wallets</span>
          <span className="tr-muted">Copy them at your size</span>
        </h2>
      </div>

      <div className="tr-panel">
        {PODS.map((pod, i) => (
          <div key={pod.handle} className={`tr-pod tr-pod-${i + 1}${pod.sharp ? " sharp" : ""}`} aria-hidden="true">
            <div
              className={`tr-orbit${pod.reverse ? " reverse" : ""}`}
              style={{ "--pod-r": `${pod.r}px`, "--pod-dur": `${pod.dur}s`, animationDelay: `${pod.delay}s` } as React.CSSProperties}
            >
              <div className="tr-card" style={{ transform: `rotate(${pod.tilt}deg)` }}>
                <div className="tr-card-body">
                  <div className="tr-card-top">
                    <span className="tr-avatar" style={{ background: avatarFor(pod.handle) }}>
                      {pod.handle.slice(1, 2).toUpperCase()}
                    </span>
                    <span className="tr-handle">{pod.handle}</span>
                    <span className="tr-ago">{pod.ago}</span>
                  </div>
                  <p className="tr-note">{pod.note}</p>
                  <div className="tr-card-foot">
                    <span className={`tr-side ${pod.side}`}>{pod.side === "buy" ? "Buy" : "Sell"}</span>
                    <span className="tr-mark">{pod.mark}</span>
                    <span className="tr-symbol">{pod.symbol}</span>
                    <span className="tr-size">{pod.size}</span>
                    <span className={`tr-change ${pod.change.startsWith("+") ? "up" : "down"}`}>{pod.change}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}

        <div className="tr-centre">
          <p className="tr-headline">Own what they own.</p>
          <p className="tr-lede">
            Every trader on the leaderboard is a real wallet on Solana. See what they hold and how it has
            done, then copy the same mix in one approval, at your own size.
          </p>
        </div>
      </div>
    </section>
  );
}
