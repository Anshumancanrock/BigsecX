import { hues } from "../../lib/avatars.ts";

/** A profile's cover: soft light in the wallet's own colours. */
export function Cover({ wallet, children }: { wallet: string; children?: React.ReactNode }) {
  const [a, b, c] = hues(wallet);
  return (
    <div
      className="cover"
      style={{
        background: [
          `radial-gradient(70% 120% at 12% 0%, hsl(${a} 80% 70% / 0.95), transparent 70%)`,
          `radial-gradient(60% 110% at 88% 20%, hsl(${b} 75% 60% / 0.9), transparent 70%)`,
          `radial-gradient(80% 90% at 50% 120%, hsl(${c} 70% 55% / 0.85), transparent 70%)`,
          `linear-gradient(135deg, hsl(${a} 40% 20%), hsl(${b} 40% 14%))`,
        ].join(", "),
      }}
    >
      {children}
    </div>
  );
}
