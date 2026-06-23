export type Category = 'mlb' | 'soccer' | 'politics';

export type Venue = 'polymarket' | 'kalshi';

export type BinarySide = 'yes' | 'no';

export interface UnifiedMarket {
  id: string;
  venue: Venue;
  question: string;
  symbol?: string;
  yesPriceCents: number;
  noPriceCents: number;
  resolutionTime?: string;
  url: string;
  rulesDescription?: string;
  category?: Category;
}

export interface MatchedPair {
  polymarket: UnifiedMarket;
  kalshi: UnifiedMarket;
}

export interface ArbitrageOpportunity {
  pair: MatchedPair;
  legA: { venue: Venue; side: BinarySide; priceCents: number; feeCents: number };
  legB: { venue: Venue; side: BinarySide; priceCents: number; feeCents: number };
  totalCostCents: number;
  maxPayoutCents: number;
  edgePercent: number;
}
