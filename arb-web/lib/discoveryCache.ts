// Persist the result of discovery across process restarts.
//
// Discovery is the slow part of a cold start: it pages ~9,400 Polymarket events plus every
// Kalshi series, which measures ~15s and cannot be trimmed much — the tag ids that make it
// expensive are also the only source of most markets (series ids alone yield 0 soccer and
// 0 NFL moneylines), and ordering newest-first with early termination saves only ~3
// requests while preserving every moneyline.
//
// What CAN be avoided is doing it again on every `npm run dev`. Discovery output is just
// fixture metadata — which markets exist and which pair with which. Prices are re-fetched
// from both venues within 250ms of startup regardless, so reusing yesterday's pairing and
// immediately repricing is accurate, while a fresh rediscovery runs in the background to
// pick up new fixtures.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UnifiedMarket, MatchedPair, Category } from './market-types';

const CACHE_PATH = join(process.cwd(), '.next', 'cache', 'arb-discovery.json');

// Beyond this the fixture list is too likely to have moved on (games finished, new ones
// listed) to be worth serving even for the few seconds before rediscovery replaces it.
export const DISCOVERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface PersistedDiscovery {
  savedAt: number;
  counts: Partial<Record<Category, { pm: number; kalshi: number }>>;
  totalPm: number;
  totalKalshi: number;
  matchedPm: unknown[];
  matchedKalshi: UnifiedMarket[];
  /** Pairs stored as ID references; the objects are rehydrated on load so that repricing,
   *  which mutates the market objects in place, is seen by the pairs too. */
  pairs: { category: Category; pmId: string; kalId: string }[];
}

export function saveDiscovery(d: {
  pairsByCategory: Map<Category, MatchedPair[]>;
  counts: Partial<Record<Category, { pm: number; kalshi: number }>>;
  totalPm: number;
  totalKalshi: number;
  matchedPm: unknown[];
  matchedKalshi: UnifiedMarket[];
}): void {
  // Never overwrite a good cache with an empty scan. The point of this file is to let a
  // restart serve real pairs immediately instead of waiting ~15s; persisting a failed scan
  // turns it into the opposite, seeding the next start with nothing. Defense in depth — the
  // caller already refuses to publish an empty rediscovery.
  if (d.matchedPm.length === 0 && d.matchedKalshi.length === 0) {
    console.warn('[discovery-cache] refusing to persist an empty discovery — keeping the previous file');
    return;
  }
  try {
    const pairs: PersistedDiscovery['pairs'] = [];
    for (const [category, list] of d.pairsByCategory) {
      for (const p of list) {
        pairs.push({ category, pmId: p.polymarket.id, kalId: p.kalshi.id });
      }
    }
    const payload: PersistedDiscovery = {
      savedAt: Date.now(),
      counts: d.counts,
      totalPm: d.totalPm,
      totalKalshi: d.totalKalshi,
      matchedPm: d.matchedPm,
      matchedKalshi: d.matchedKalshi,
      pairs,
    };
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(payload));
  } catch {
    // A cache that cannot be written must never break discovery.
  }
}

export function loadDiscovery(): {
  pairsByCategory: Map<Category, MatchedPair[]>;
  counts: Partial<Record<Category, { pm: number; kalshi: number }>>;
  totalPm: number;
  totalKalshi: number;
  matchedPm: unknown[];
  matchedKalshi: UnifiedMarket[];
  savedAt: number;
} | null {
  try {
    const st = statSync(CACHE_PATH);
    if (Date.now() - st.mtimeMs > DISCOVERY_CACHE_TTL_MS) return null;
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as PersistedDiscovery;
    if (!raw || !Array.isArray(raw.matchedPm) || !Array.isArray(raw.matchedKalshi)) return null;
    if (Date.now() - raw.savedAt > DISCOVERY_CACHE_TTL_MS) return null;

    // Rehydrate pairs to point at the SAME objects held in matchedPm/matchedKalshi.
    // Repricing mutates those objects in place; if the pairs held separate copies the
    // refreshed prices would never reach the assembled response.
    const pmById = new Map<string, UnifiedMarket>();
    for (const m of raw.matchedPm as UnifiedMarket[]) pmById.set(m.id, m);
    const kalById = new Map<string, UnifiedMarket>();
    for (const m of raw.matchedKalshi) kalById.set(m.id, m);

    const pairsByCategory = new Map<Category, MatchedPair[]>();
    for (const ref of raw.pairs ?? []) {
      const pm = pmById.get(ref.pmId);
      const kal = kalById.get(ref.kalId);
      if (!pm || !kal) continue;              // dropped market — skip rather than serve a broken pair
      const list = pairsByCategory.get(ref.category) ?? [];
      list.push({ polymarket: pm, kalshi: kal } as MatchedPair);
      pairsByCategory.set(ref.category, list);
    }
    if (pairsByCategory.size === 0) return null;

    return {
      pairsByCategory,
      counts: raw.counts ?? {},
      totalPm: raw.totalPm ?? 0,
      totalKalshi: raw.totalKalshi ?? 0,
      matchedPm: raw.matchedPm,
      matchedKalshi: raw.matchedKalshi,
      savedAt: raw.savedAt,
    };
  } catch {
    return null;
  }
}
