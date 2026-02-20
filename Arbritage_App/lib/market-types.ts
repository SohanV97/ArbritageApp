export type Venue = 'polymarket' | 'kalshi';

export type BinarySide = 'yes' | 'no';

export interface UnifiedMarket {
  id: string;
  venue: Venue;
  /** Human-readable question/title */
  question: string;
  /** Optional short ticker or symbol if available */
  symbol?: string;
  /** Price in cents (0–100) for each side */
  yesPriceCents: number;
  noPriceCents: number;
  /** ISO date string for resolution/expiry if known */
  resolutionTime?: string;
  /** Deep link / URL to open the market in a browser */
  url: string;
  /** Optional descriptive rules or a short summary */
  rulesDescription?: string;
}

export interface MatchedPair {
  polymarket: UnifiedMarket;
  kalshi: UnifiedMarket;
}

export interface ArbitrageOpportunity {
  pair: MatchedPair;
  /** Direction of the arb: which side on which venue */
  legA: { venue: Venue; side: BinarySide; priceCents: number; feeCents: number };
  legB: { venue: Venue; side: BinarySide; priceCents: number; feeCents: number };
  /** Total cost (including fees) for 1 contract on each leg */
  totalCostCents: number;
  /** Profit at resolution for 1×1 sizing, assuming one side wins */
  maxPayoutCents: number;
  edgePercent: number;
}

