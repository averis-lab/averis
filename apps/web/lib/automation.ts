/** Shapes returned by /v1/automations. Kept here so pages and components agree. */

export interface TradePolicyView {
  minConfidence: number;
  minConsensus: number;
  minAgents: number;
  maxUnsupportedClaims: number;
  maxDisagreements: number;
  sizeUsd: number;
  maxConcurrentPositions: number;
  maxDeployedUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingActivationPct: number;
  trailingStopPct: number;
  maxHoldMinutes: number;
  maxConsecutiveLosses: number;
  maxDailyDrawdownUsd: number;
  cooldownAfterLossMinutes: number;
  tokenCooldownMinutes: number;
  blockedTokens: string[];
}

export interface BreakerView {
  paused: boolean;
  reason: string | null;
  consecutiveLosses: number;
  dailyPnlUsd: number;
}

export interface AutomationStats {
  openPositions: number;
  deployedUsd: number;
  closedTrades: number;
  wins: number;
  realizedPnlUsd: number;
  breaker: BreakerView;
}

export interface AutomationView {
  id: string;
  name: string;
  mode: "PAPER" | "LIVE";
  active: boolean;
  capabilities: string[];
  policy: TradePolicyView;
  createdAt: string;
  stats: AutomationStats;
}

export interface PositionView {
  id: string;
  jobId: string;
  token: string;
  symbol: string;
  status: "OPEN" | "CLOSED";
  sizeUsd: number;
  entryPrice: number;
  peakPrice: number;
  exitPrice: number | null;
  pnlUsd: number | null;
  exitReason: string | null;
  confidence: number;
  consensus: number;
  agentsReporting: number;
  openedAt: string;
  closedAt: string | null;
}

export interface AutomationEventView {
  id: string;
  kind: string;
  reason: string | null;
  message: string;
  jobId: string | null;
  createdAt: string;
}

export interface DriverView {
  name: string;
  spendsRealMoney: boolean;
}

export interface ViewerView {
  /** The wallet the gateway verified for this request, if any. */
  walletAddress: string | null;
  /** True when the gateway has wallet login configured and expects one. */
  walletRequired: boolean;
}

export const usd = (value: number): string =>
  `${value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}`;

export const EVENT_TONE: Record<string, string> = {
  OPENED: "text-emerald-500",
  CLOSED: "text-foreground",
  REFUSED: "text-muted",
  BREAKER: "text-amber-500",
  MODE: "text-accent",
  TOGGLED: "text-accent",
};
