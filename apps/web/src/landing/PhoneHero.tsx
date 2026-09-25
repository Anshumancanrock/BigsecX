/**
 * The hero: headline, the 3D phone, a row of company marks, and the call to
 * action. three.js is a separate chunk loaded after first paint, so the app
 * never downloads it. The phone appears once both the scene and the basket
 * history are ready; the stage keeps its size meanwhile, and without WebGL
 * the same screen is shown in a flat frame.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type History, type IndexList, type Market } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { navigate } from "../lib/router.ts";
import { list, price } from "../lib/format.ts";
import { fallbackFrames, fmtChange, fmtUsd, framesFromHistory } from "./phone-model.ts";
import { PhoneScreen, type PhoneHolding } from "./PhoneScreen.tsx";

const SECTOR_TAG: Readonly<Record<string, string>> = {
  "ai-lab": "AI lab",
  robotics: "Robotics",
  space: "Space",
  defense: "Defence",
  "prediction-market": "Prediction",
  neurotech: "Neurotech",
};

const HISTORY_WAIT_MS = 2500;

const MARK: Readonly<Record<string, string>> = {
  SPACEX: "X",
  OPENAI: "O",
  ANTHROPIC: "A",
  ANDURIL: "A",
  NEURALINK: "N",
  FIGUREAI: "F",
  KALSHI: "K",
  POLYMARKET: "P",
};

export function PhoneHero({ market, indexes }: { market: Market | null; indexes: IndexList | null }) {
  const history = useAsync<History>((signal) => api.history(365, signal), []);
  const weights = useMemo(
    () => list(list(indexes?.indexes).find((i) => i.id === "pre8")?.weights),
    [indexes],
  );

  // The demo line is only for when the history cannot be had: after an
  // error, or once it has been waited for long enough.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setWaited(true), HISTORY_WAIT_MS);
    return () => clearTimeout(id);
  }, []);
  const frames = useMemo(() => {
    const real = history.data ? framesFromHistory(history.data, weights) : null;
    return real ?? (waited || history.error ? fallbackFrames() : null);
  }, [history.data, history.error, weights, waited]);
  const ready = frames !== null;

  const holdings = useMemo<PhoneHolding[]>(() => {
    const balance = frames?.get("Max")?.balance ?? 0;
    return [...weights]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2)
      .map((w) => {
        const token = list(market?.tokens).find((t) => t.symbol === w.symbol);
        const series = history.data?.prices[w.symbol] ?? [];
        const now = series[series.length - 1] ?? null;
        const then = series[Math.max(0, series.length - 31)] ?? null;
        const move = now && then ? now / then - 1 : 0;
        const value = balance * w.weight;
        const delta = value - value / (1 + move);
        return {
          symbol: w.symbol,
          name: token?.name ?? w.symbol,
          glyph: MARK[w.symbol] ?? w.symbol.slice(0, 1),
          tag: SECTOR_TAG[token?.sectors[0] ?? ""] ?? "Basket",
          price: price(token?.marketUsd ?? null),
          value: fmtUsd(value),
          change: fmtChange(delta, value - delta),
          up: delta >= 0,
        };
      });
  }, [weights, market, history.data, frames]);

  const hero = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const flatSlot = useRef<HTMLDivElement>(null);
  const [screen] = useState(() => {
    const el = document.createElement("div");
    el.className = "ps-root";
    return el;
  });
  const [mode, setMode] = useState<"loading" | "3d" | "flat">("loading");
  const [active, setActive] = useState(true);

  const [sceneModule, setSceneModule] = useState<typeof import("./PhoneScene.ts") | null>(null);
  useEffect(() => {
    let live = true;
    import("./PhoneScene.ts")
      .then((module) => live && setSceneModule(module))
      .catch(() => live && setMode("flat"));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!sceneModule || !ready || !stage.current || !hero.current) return;
    const scene = sceneModule.mountPhoneScene(stage.current, screen, { tiltArea: hero.current, onVisible: setActive });
    setMode(scene ? "3d" : "flat");
    return () => scene?.dispose();
  }, [sceneModule, ready, screen]);

  // Without WebGL the screen lives in a flat frame instead.
  useEffect(() => {
    if (mode === "flat" && ready && flatSlot.current && screen.parentElement !== flatSlot.current) {
      flatSlot.current.append(screen);
    }
  }, [mode, ready, screen]);

  return (
    <div className="phone-hero" ref={hero}>
      <h1 className="rise">
        You know the names.
        <br />
        Now own them.
      </h1>

      <div className="phone-stage rise" ref={stage} aria-hidden="true">
        {mode === "flat" && ready ? <FlatPhone slot={flatSlot} /> : null}
      </div>
      {frames ? createPortal(<PhoneScreen frames={frames} holdings={holdings} active={active} />, screen) : null}

      <p className="phone-sub rise">Own SpaceX, AI labs and prediction markets. Buy or sell, any hour. Self-custodial.</p>

      <div className="rise">
        <button className="phone-cta" onClick={() => navigate("/dashboard")}>
          Open Bigsec
        </button>
      </div>
    </div>
  );
}

/**
 * The phone without WebGL: a titanium gradient ring, four buttons, a black
 * bezel and the screen inside, in plain DOM.
 */
function FlatPhone({ slot }: { slot: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const fit = () => el.style.setProperty("--s", String(el.clientWidth / 390));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [slot]);

  return (
    <div className="flat-phone">
      <div className="flat-ring">
        {[
          { side: "left", top: 20.8, height: 5.2 },
          { side: "left", top: 29, height: 6.2 },
          { side: "left", top: 37.5, height: 6.2 },
          { side: "right", top: 31.5, height: 12.5 },
        ].map((b) => (
          <span key={`${b.side}-${b.top}`} className={`flat-button ${b.side}`} style={{ top: `${b.top}%`, height: `${b.height}%` }} />
        ))}
        <div className="flat-bezel">
          <div className="flat-screen" ref={slot} />
        </div>
      </div>
    </div>
  );
}
