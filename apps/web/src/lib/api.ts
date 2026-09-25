import { API_BASE as BASE } from "./base.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed error body. A refused build (409) lists every problem, which the UI shows per leg. */
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  readonly error?: string;
}

/**
 * `exactOptionalPropertyTypes` forbids handing `signal: undefined` to fetch,
 * so the key is spread in only when a signal was actually passed.
 */
function init(signal?: AbortSignal): RequestInit {
  return signal ? { signal } : {};
}

async function fail(response: Response): Promise<never> {
  // The server returns {error} for anything it refuses; surface that text
  // rather than a generic status, because the refusals are specific and
  // actionable ("insufficient USDC", "unknown index").
  const body = (await response.json().catch(() => null)) as (ErrorBody & Record<string, unknown>) | null;
  throw new ApiError(
    response.status,
    body?.error ?? `${response.status} ${response.statusText}`,
    body,
  );
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init(signal));
  if (!response.ok) await fail(response);
  return (await response.json()) as T;
}

async function post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    ...init(signal),
  });
  if (!response.ok) await fail(response);
  return (await response.json()) as T;
}

export interface IssuerControl {
  readonly permanentDelegate: string | null;
  readonly freezeAuthority: string | null;
  readonly transferHookProgramId: string | null;
}

export interface MarketToken {
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  readonly sectors: readonly string[];
  readonly marketUsd: number | null;
  readonly markUsd: number | null;
  readonly basis: number | null;
  readonly basisLabel: "deep-discount" | "discount" | "fair" | "premium" | "rich" | null;
  readonly liquidityUsd: number;
  readonly change24hPct: number | null;
  readonly supplyUi: number;
  readonly multiplier: number;
  readonly transferFeeBps: number;
  readonly paused: boolean;
  readonly issuerControl: IssuerControl;
  readonly iconUrl?: string | null;
  readonly holders?: number | null;
  readonly volume24hUsd?: number | null;
  readonly traders24h?: number | null;
  readonly verified?: boolean;
}

export interface PendingFeeChange {
  readonly fromBps: number;
  readonly toBps: number;
  /** The epoch it takes effect; Solana epochs last about two days. */
  readonly atEpoch: number;
}

export interface Market {
  readonly takenAt: string;
  readonly epoch: number;
  readonly tokens: readonly MarketToken[];
  readonly totalLiquidityUsd: number;
  readonly pendingFeeChange: PendingFeeChange | null;
  readonly degraded: readonly string[];
  readonly priceFeedError: string | null;
  readonly disclosures: readonly string[];
}

export interface Weight {
  readonly symbol: string;
  readonly weight: number;
}

export interface IndexSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scheme: string;
  readonly weights: readonly Weight[] | null;
  readonly level: number | null;
}

export interface IndexList {
  readonly takenAt: string;
  readonly indexes: readonly IndexSummary[];
}

export interface IndexDetail {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scheme: unknown;
  readonly weights: readonly Weight[] | null;
  readonly history: readonly { readonly at: string; readonly level: number }[];
}

export interface LeaderboardEntry {
  readonly owner: string;
  readonly trades: number;
  readonly volumeUsd: number;
  readonly peakInvestedUsd: number;
  readonly markValueUsd: number;
  readonly pnlUsd: number;
  readonly returnFraction: number;
  readonly positions: readonly { readonly symbol: string; readonly uiAmount: number }[];
  readonly held?: readonly string[] | null;
  readonly name?: string | null;
  readonly handle?: string | null;
  readonly avatar?: string | null;
}

export interface Leaderboard {
  readonly window: string;
  readonly sortBy?: "pnl" | "return" | "volume";
  readonly minVolumeUsd?: number;
  readonly sinceSlot?: number;
  readonly walletsConsidered?: number;
  readonly entries: readonly LeaderboardEntry[];
  readonly caveats?: readonly string[];
  readonly note?: string;
}

export interface PortfolioPosition {
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  readonly uiAmount: number;
  readonly priceUsd: number | null;
  readonly valueUsd: number | null;
  readonly weight: number | null;
  /** The issuer has immobilised this account; the balance cannot be sold. */
  readonly frozen: boolean;
  readonly paused: boolean;
}

export interface Portfolio {
  readonly owner: string;
  readonly asOf: string;
  readonly totalUsd: number;
  readonly cash: {
    readonly usdcUsd: number;
    readonly solLamports: number;
    /** False means the wallet cannot submit anything, however much it holds. */
    readonly canPayFees: boolean;
  };
  readonly positions: readonly PortfolioPosition[];
  readonly sectors: Readonly<Record<string, number>>;
  readonly unpriced: readonly string[];
  readonly frozen: readonly string[];
  /**
   * Tokens held outside the associated account. Not in totalUsd or
   * positions, because a swap cannot spend from those accounts.
   */
  readonly elsewhere?: readonly {
    readonly symbol: string;
    readonly uiAmount: number;
    readonly valueUsd: number | null;
    readonly accounts: number;
  }[];
  readonly comparison: unknown;
}

export interface Problem {
  readonly kind: string;
  readonly message: string;
  readonly detail?: string;
  readonly requiredUsd?: number;
  readonly availableUsd?: number;
  readonly lamports?: number;
  readonly requiredLamports?: number;
  readonly newAccounts?: number;
  readonly symbols?: readonly string[];
  readonly deferred?: readonly { readonly symbol: string; readonly usd: number; readonly reason: string }[];
}

export interface BuiltLeg {
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly usd: number;
  readonly slippageBps?: number;
  /** The part of slippageBps that is the transfer fee, not price movement. */
  readonly feeAllowanceBps?: number;
  /** Buy legs: the shares the quote promised, less the transfer fee. */
  readonly expectedShares?: number;
  /** Sell legs: the USDC the quote promised, less the transfer fee. */
  readonly expectedUsd?: number;
}

export interface BuildResponse {
  readonly target?: string;
  readonly targetSource?: string;
  readonly mode?: "add" | "rebalance";
  readonly leader?: string;
  readonly follower?: string;
  readonly scope?: string;
  readonly transactions: readonly string[];
  readonly legsByTransaction: readonly (readonly string[])[];
  readonly blockhash: string;
  /** Past this height the blockhash is dead and an unlanded leg never lands. */
  readonly lastValidBlockHeight: number;
  readonly failed: readonly { readonly symbol: string; readonly reason: string }[];
  readonly byteLengths: readonly number[];
  readonly legs: readonly BuiltLeg[];
  readonly deferred?: readonly { readonly symbol: string; readonly reason: string }[];
  readonly totalUsd: number;
  readonly totalCostUsd?: number;
  readonly costFraction: number;
  readonly atomic: false;
  readonly note: string;
}

export interface SimulationResult {
  readonly index: number;
  readonly ok: boolean;
  readonly err?: unknown;
  readonly logs?: readonly string[];
  readonly unitsConsumed?: number | null;
  readonly error?: string;
}

export interface SimulationResponse {
  readonly results: readonly SimulationResult[];
  readonly wouldLand: boolean;
  readonly ok: number;
  readonly failed: number;
  readonly note: string;
}

export interface SubmitResult {
  readonly index: number;
  readonly signature: string;
  readonly submitted: boolean;
  readonly error?: string;
  readonly err?: unknown;
  readonly logs?: readonly string[];
}

export interface SubmitResponse {
  readonly results: readonly SubmitResult[];
  readonly submitted: number;
  readonly failed: number;
}

export type ConfirmState = "processed" | "confirmed" | "finalized" | "failed" | "unknown";

export interface ConfirmStatus {
  readonly signature: string;
  readonly status: ConfirmState;
  readonly slot: number | null;
  readonly err: unknown;
}

export interface ConfirmResponse {
  readonly blockHeight: number;
  readonly statuses: readonly ConfirmStatus[];
}

export interface StrategyDto {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly description: string | null;
  readonly creator: string;
  readonly rebalance: string;
  readonly published: boolean;
  readonly weights: readonly Weight[];
  readonly sectors: Readonly<Record<string, number>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Cash {
  readonly owner: string;
  readonly usdcUsd: number;
  readonly solLamports: number;
}

export interface TraderProfile {
  readonly owner: string;
  readonly window: string;
  readonly trades: number;
  readonly volumeUsd: number;
  readonly peakInvestedUsd: number;
  readonly markValueUsd: number;
  readonly pnlUsd: number;
  readonly returnFraction: number;
  readonly coverageComplete: boolean;
  readonly positions: readonly { readonly symbol: string; readonly uiAmount: number }[];
  readonly weights: readonly Weight[];
  readonly closedTrades: number;
  readonly winRate: number | null;
  readonly caveats: readonly string[];
  readonly books?: readonly SymbolBook[];
}

export interface SymbolBook {
  readonly symbol: string;
  readonly uiAmount: number;
  readonly boughtUsd: number;
  readonly soldUsd: number;
  readonly netInvestedUsd: number;
  /** False when a trade had no believable cost, or shares were sold never seen bought. */
  readonly complete: boolean;
  readonly closed: boolean;
  readonly trades: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
}

export interface HistoryTrade {
  readonly signature: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly uiAmount: number;
  readonly valueUsd: number | null;
  readonly slot: number;
  readonly at: string | null;
}

export interface Profile {
  readonly wallet: string;
  readonly name: string;
  readonly handle: string | null;
  readonly bio: string;
  readonly avatar: string | null;
  /** When the wallet first saved a profile; null if it never has. */
  readonly joinedAt: string | null;
  readonly followers: number;
  readonly following: number;
  /** Relative to the viewer passed in; false without one. */
  readonly viewerFollows: boolean;
  readonly followsViewer: boolean;
  readonly mutuals: number;
  readonly activity: {
    readonly trades: number;
    readonly firstTradeAt: string | null;
    readonly lastTradeAt: string | null;
    readonly avgHoldSeconds: number | null;
  };
}

export interface FeedTrade extends RecentTrade {
  readonly name: string | null;
  readonly handle: string | null;
  readonly avatar?: string | null;
}

export interface FollowEntry {
  readonly wallet: string;
  readonly name: string;
  readonly handle: string | null;
  readonly avatar?: string | null;
  readonly since: string;
}

export interface Intraday {
  readonly asOf: string;
  readonly complete: boolean;
  readonly times: readonly number[];
  readonly prices: Readonly<Record<string, readonly (number | null)[]>>;
}

export interface History {
  readonly asOf: string;
  readonly complete: boolean;
  readonly refreshing: boolean;
  readonly days: readonly string[];
  readonly prices: Readonly<Record<string, readonly (number | null)[]>>;
}

export interface RecentTrade {
  readonly signature: string;
  readonly owner: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly uiAmount: number;
  readonly valueUsd: number;
  readonly blockTime: number | null;
}

export interface PositionResponse {
  readonly owner: string;
  readonly symbol: string;
  readonly position: PortfolioPosition;
}

export interface AuthMessage {
  readonly message: string;
  readonly issuedAt: number;
  readonly required: boolean;
}

export const api = {
  market: (signal?: AbortSignal) => get<Market>("/api/market", signal),
  indexes: (signal?: AbortSignal) => get<IndexList>("/api/indexes", signal),
  index: (id: string, signal?: AbortSignal) => get<IndexDetail>(`/api/indexes/${encodeURIComponent(id)}`, signal),
  universe: (signal?: AbortSignal) => get<unknown>("/api/universe", signal),
  priceTruth: (signal?: AbortSignal) => get<unknown>("/api/price-truth", signal),

  leaderboard: (
    options: { hours?: number; limit?: number; sortBy?: "pnl" | "return" | "volume"; minVolumeUsd?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (options.hours != null) query.set("hours", String(options.hours));
    if (options.limit != null) query.set("limit", String(options.limit));
    if (options.sortBy) query.set("sortBy", options.sortBy);
    if (options.minVolumeUsd != null) query.set("minVolumeUsd", String(options.minVolumeUsd));
    const suffix = query.toString();
    return get<Leaderboard>(`/api/leaderboard${suffix ? `?${suffix}` : ""}`, signal);
  },

  portfolio: (wallet: string, signal?: AbortSignal) =>
    get<Portfolio>(`/api/portfolio/${encodeURIComponent(wallet)}`, signal),

  position: (wallet: string, symbol: string, signal?: AbortSignal) =>
    get<PositionResponse>(`/api/portfolio/${encodeURIComponent(wallet)}/${encodeURIComponent(symbol)}`, signal),

  history: (days = 365, signal?: AbortSignal) => get<History>(`/api/history?days=${days}`, signal),
  intraday: (hours = 168, signal?: AbortSignal) => get<Intraday>(`/api/history/intraday?hours=${hours}`, signal),

  recentTrades: (limit = 12, minUsd = 0, signal?: AbortSignal) =>
    get<{ trades: readonly RecentTrade[] }>(`/api/trades/recent?limit=${limit}&minUsd=${minUsd}`, signal),

  cash: (wallet: string, signal?: AbortSignal) => get<Cash>(`/api/cash/${encodeURIComponent(wallet)}`, signal),

  trader: (wallet: string, hours?: number, signal?: AbortSignal) =>
    get<TraderProfile>(
      `/api/traders/${encodeURIComponent(wallet)}${hours ? `?hours=${hours}` : ""}`,
      signal,
    ),

  traderTrades: (wallet: string, limit = 100, signal?: AbortSignal) =>
    get<{ owner: string; trades: readonly HistoryTrade[] }>(
      `/api/traders/${encodeURIComponent(wallet)}/trades?limit=${limit}`,
      signal,
    ),

  feed: (wallet: string, limit = 30, signal?: AbortSignal) =>
    get<{ trades: readonly FeedTrade[] }>(`/api/feed/${encodeURIComponent(wallet)}?limit=${limit}`, signal),

  profile: (wallet: string, viewer?: string | null, signal?: AbortSignal) =>
    get<Profile>(
      `/api/profiles/${encodeURIComponent(wallet)}${viewer ? `?viewer=${encodeURIComponent(viewer)}` : ""}`,
      signal,
    ),

  /** Names and handles for several wallets; ones without a profile are absent. */
  names: (wallets: readonly string[], signal?: AbortSignal) =>
    get<{ profiles: Readonly<Record<string, { name: string; handle: string | null; avatar: string | null }>> }>(
      `/api/profiles?wallets=${wallets.map(encodeURIComponent).join(",")}`,
      signal,
    ),

  handle: (handle: string, signal?: AbortSignal) =>
    get<{ wallet: string; handle: string; avatar?: string | null }>(`/api/handles/${encodeURIComponent(handle)}`, signal),

  followers: (wallet: string, signal?: AbortSignal) =>
    get<{ followers: readonly FollowEntry[] }>(`/api/profiles/${encodeURIComponent(wallet)}/followers`, signal),

  following: (wallet: string, signal?: AbortSignal) =>
    get<{ following: readonly FollowEntry[] }>(`/api/profiles/${encodeURIComponent(wallet)}/following`, signal),

  signIn: (body: Record<string, unknown>, signal?: AbortSignal) =>
    post<{ token: string; wallet: string; expiresAt: string }>("/api/session", body, signal),

  signOut: (token: string, signal?: AbortSignal) => post<{ ok: true }>("/api/session/end", { token }, signal),

  saveProfile: (body: { token: string; name: string; handle: string; bio: string }, signal?: AbortSignal) =>
    post<Pick<Profile, "wallet" | "name" | "handle" | "bio" | "joinedAt">>("/api/profile", body, signal),

  follow: (body: { token: string; followee: string; follow: boolean }, signal?: AbortSignal) =>
    post<{ following: boolean; followers: number }>("/api/follows", body, signal),

  setAvatar: (
    body: { token: string; preset: number } | { token: string; image: string } | { token: string; clear: true },
    signal?: AbortSignal,
  ) => post<{ wallet: string; avatar: string | null }>("/api/profile/avatar", body, signal),

  mirrorPlan: (
    body: { indexId?: string; strategyId?: string; deployUsd: number; holdings?: unknown },
    signal?: AbortSignal,
  ) => post<unknown>("/api/mirror/plan", body, signal),

  /**
   * Build the unsigned transactions for a purchase.
   *
   * No mode is sent, so the server's default applies: spend the new money on
   * the target and sell nothing. Every buy button in this app means that.
   * Holdings are never sent either; a rebalance reads them from chain.
   */
  mirrorBuild: (
    body: {
      owner: string;
      indexId?: string;
      strategyId?: string;
      weights?: readonly { symbol: string; weight: number }[];
      deployUsd: number;
      slippageBps?: number;
    },
    signal?: AbortSignal,
  ) => post<BuildResponse>("/api/mirror/build", body, signal),

  copyPreview: (body: { leader: string; capitalUsd: number }, signal?: AbortSignal) =>
    post<unknown>("/api/copy/preview", body, signal),

  /** What selling would return, priced, without building anything. */
  exitPlan: (
    body: { owner: string; symbols?: readonly string[]; fraction?: number },
    signal?: AbortSignal,
  ) => post<{ sells: readonly { symbol: string; usd: number }[]; proceedsUsd: number }>("/api/exit/plan", body, signal),

  exitBuild: (
    body: { owner: string; symbols?: readonly string[]; fraction?: number; slippageBps?: number },
    signal?: AbortSignal,
  ) => post<BuildResponse>("/api/exit/build", body, signal),

  copyBuild: (
    body: { leader: string; follower: string; capitalUsd: number; slippageBps?: number },
    signal?: AbortSignal,
  ) => post<BuildResponse>("/api/copy/build", body, signal),

  /**
   * Rehearse a bundle against live mainnet without signing or submitting.
   *
   * There is no testnet for this product: the PreStocks mints exist only on
   * mainnet and Jupiter has no devnet router. This is the substitute.
   */
  simulate: (body: { transactions: readonly string[] }, signal?: AbortSignal) =>
    post<SimulationResponse>("/api/simulate", body, signal),

  /** Relay signed transactions. Never throws on a partial failure. */
  submit: (body: { transactions: readonly string[]; skipPreflight?: boolean }, signal?: AbortSignal) =>
    post<SubmitResponse>("/api/submit", body, signal),

  confirm: (body: { signatures: readonly string[] }, signal?: AbortSignal) =>
    post<ConfirmResponse>("/api/confirm", body, signal),

  recordTrades: (body: { signatures: readonly string[] }, signal?: AbortSignal) =>
    post<{ recorded: number; trades: number; notFound: number }>("/api/trades/record", body, signal),

  /** The exact bytes a wallet must sign to authorise a write. */
  authMessage: (
    body: { action: string; resource: string; wallet: string; body?: unknown },
    signal?: AbortSignal,
  ) => post<AuthMessage>("/api/auth/message", body, signal),

  strategy: (id: string, signal?: AbortSignal) =>
    get<StrategyDto>(`/api/strategies/${encodeURIComponent(id)}`, signal),

  strategies: (signal?: AbortSignal) =>
    get<{ strategies: readonly StrategyDto[]; scope: string }>("/api/strategies", signal),

  createStrategy: (body: Record<string, unknown>, signal?: AbortSignal) =>
    post<{ id: string; published: boolean }>("/api/strategies", body, signal),
};
