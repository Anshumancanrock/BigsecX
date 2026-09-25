import { useState } from "react";
import { reducedMotion } from "../lib/motion.ts";

export function SuccessMark({ title, detail }: { title: string; detail?: string }) {
  const [calm] = useState(reducedMotion);
  return (
    <div className="success">
      <div className="success-mark">
        {!calm ? (
          <span className="burst" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} style={{ "--a": `${i * 30}deg`, "--d": `${(i % 3) * 40}ms` } as React.CSSProperties} />
            ))}
          </span>
        ) : null}
        <svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true">
          <circle className="success-ring" cx="26" cy="26" r="23" pathLength={1} />
          <path className="success-tick" d="M15.5 27.5l7 7 14.5-15.5" pathLength={1} />
        </svg>
      </div>
      <b>{title}</b>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}
