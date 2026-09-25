/**
 * Display formatting. Every formatter accepts the nullable values the API
 * returns and renders a missing value as a dash, never as "NaN" or "$0.00".
 */

const DASH = "—";

export function usdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function usd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * A price, with precision that follows magnitude.
 *
 * This universe spans $117 (SpaceX) to $1,125 (OpenAI) today, but a share
 * split moves a multiplier and a price can land anywhere. Fixing two decimals
 * would show a $0.004 token as "$0.00".
 */
export function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function pct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function pctOfFraction(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return pct(value * 100, digits);
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `${Math.abs(value * 100).toFixed(digits)}%`;
}

export function weight(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

/** Share counts. Never rounded to zero when a dust balance is genuinely held. */
export function shares(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  if (value !== 0 && Math.abs(value) < 0.0001) return "<0.0001";
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function bps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `${Math.round(value)} bps`;
}

export const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function shortAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** "4m ago". Relative because absolute times invite "is this stale?". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return DASH;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Treats anything that is not an array as empty, so a response of the wrong
 * shape degrades to an empty list instead of throwing during render and
 * unmounting the page. Not a substitute for correct types.
 */
export function list<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/*
 * A company's two-letter mark for its logo circle. Taken so that companies
 * sharing a first syllable (Anthropic, Anduril) still differ.
 */
const MARKS: Readonly<Record<string, string>> = {
  OPENAI: "OA",
  ANTHROPIC: "AN",
  SPACEX: "SX",
  ANDURIL: "AD",
  NEURALINK: "NL",
  FIGUREAI: "FA",
  KALSHI: "KA",
  POLYMARKET: "PM",
};

export function markOf(symbol: string): string {
  return MARKS[symbol] ?? symbol.slice(0, 2);
}

export function displayName(wallet: string, name?: string | null, handle?: string | null): string {
  if (name) return name;
  if (handle) return `@${handle}`;
  return shortAddress(wallet, 4, 4);
}

export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${trimmed(value / 1_000_000)}M`;
  if (value >= 10_000) return `${trimmed(value / 1_000)}K`;
  if (value >= 1_000) return `${trimmed(value / 1_000)}K`;
  return String(value);
}

function trimmed(value: number): string {
  return Number(value.toFixed(1)).toString();
}

export function holdWords(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  if (hours >= 1) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  if (minutes >= 1) return `${minutes}m`;
  return "under a minute";
}

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });

export function monthYear(iso: string): string {
  return MONTH.format(new Date(iso));
}

export function signedMoney(value: number): string {
  if (Math.abs(value) < 0.005) return "$0.00";
  return `${value > 0 ? "+" : "−"}${usdCompact(Math.abs(value))}`;
}

export function signedReturn(fraction: number, digits = 1): string {
  const pct = fraction * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.05) return "0.0%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(digits)}%`;
}
