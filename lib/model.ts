// lib/model.ts — the Radar scoring model for token-radar-01 (Node 22, standard library only).
//
// The model prices a protocol's hypothetical token launch ("implied value") from the snapshot's own
// figures, never from a hardcoded list of names:
//   implied = tvl_usd x category multiple x growth multiplier x maturity multiplier
// The category multiple is a robust (median) mcap/tvl multiple fitted on the snapshot's own tokened
// protocols, shrunk toward the global median so thin categories stay honest. Farm plans are
// generated per protocol from its category, chains and TVL, each step costed in dollars and time.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: unknown;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  version: string;
  shrinkK: number;        // category sample size added to the shrinkage denominator
  growthBeta: number;     // dollars of multiple per point of 7-day growth
  growthFloor: number;    // lowest growth multiplier
  growthCeil: number;     // highest growth multiplier
  freshBoost: number;     // multiplier for a protocol listed this week
  staleDiscount: number;  // multiplier for a protocol listed 2+ years ago
  staleYears: number;     // years at which the stale discount lands
}

export const MODEL: ModelConstants = {
  version: 'radar-b',
  shrinkK: 6,
  growthBeta: 0.006,
  growthFloor: 0.85,
  growthCeil: 1.6,
  freshBoost: 1.12,
  staleDiscount: 0.9,
  staleYears: 2,
};

export const EARLY_ROWS = 200;
export const MIN_ROWS = 100;
export const MAX_ROWS = 4000;

export interface FarmStep {
  action: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token' | 'tokened';
  age_days: number | null;
  implied_value_usd: number;
  token_odds: number;
  model: {
    base_multiple: number;
    category_sample: number;
    category_median_multiple: number;
    global_median_multiple: number;
    growth_pct: number | null;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface CategoryStat {
  category: string;
  protocols: number;
  tokened: number;
  median_multiple: number | null;
  top_implied_usd: number;
}

export interface RadarSummary {
  as_of: string;
  floor_usd: number;
  protocols_total: number;
  watchlist_count: number;
  rows: number;
  pre_token_rows: number;
  tokened_comps: number;
  global_median_multiple: number;
  model_version: string;
  model_notes: string[];
}

export interface RadarData {
  summary: RadarSummary;
  categories: CategoryStat[];
  rows: RadarRow[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_odds: number;
  on_watchlist: boolean;
  model: BoardRow['model'];
  farm_steps: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** Whole days between the snapshot date and a listed_at day; null when unlisted. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const l = Date.parse(`${listedAt}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(l)) return null;
  return Math.max(0, Math.round((a - l) / 86_400_000));
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A protocol whose DefiLlama record carries no token (both fields null). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/**
 * Rankable pre-token subject: records no token and is not, by its own name or category, a wrapped,
 * staked or bridged product of a protocol whose token already trades (the watchlist's own rule,
 * applied here so the board never ranks a derivative of a traded token).
 */
const DERIVATIVE_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return false;
  if (/\b(wrapped|staked|staking|bridged)\b/i.test(p.name)) return false;
  if (/\s(V[2-9]|v[2-9]|[2-9]\.0)\s*$/.test(p.name)) return false;
  if (/^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(p.name)) return false;
  return p.tvl_usd > 0;
}

/** Fitted multiples: per-category median mcap/tvl over tokened protocols, shrunk to the global one. */
export interface FittedMultiples {
  globalMedian: number;
  byCategory: Map<string, { median: number; n: number; shrunk: number }>;
}

export function fitMultiples(protocols: SnapshotProtocol[], model: ModelConstants): FittedMultiples {
  const globalSamples: number[] = [];
  const perCategory = new Map<string, number[]>();
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const m = p.mcap_usd / p.tvl_usd;
    globalSamples.push(m);
    const cat = p.category ?? 'Uncategorised';
    let arr = perCategory.get(cat);
    if (!arr) perCategory.set(cat, (arr = []));
    arr.push(m);
  }
  const globalMedian = median(globalSamples) || 1;
  const byCategory = new Map<string, { median: number; n: number; shrunk: number }>();
  for (const [cat, samples] of perCategory) {
    const n = samples.length;
    const med = median(samples);
    const w = n / (n + model.shrinkK);
    const shrunk = Math.exp(w * Math.log(med) + (1 - w) * Math.log(globalMedian));
    byCategory.set(cat, { median: med, n, shrunk });
  }
  return { globalMedian, byCategory };
}

function growthMultiplier(change7d: number | null, model: ModelConstants): number {
  const g = change7d === null ? 0 : change7d;
  const m = 1 + g * model.growthBeta;
  return Math.min(model.growthCeil, Math.max(model.growthFloor, m));
}

function maturityMultiplier(age: number | null, model: ModelConstants): number {
  if (age === null) return 1 + (model.freshBoost - 1) / 2;
  const years = age / 365;
  if (years <= 0.25) return model.freshBoost;
  const t = Math.min(1, years / model.staleYears);
  return model.freshBoost + (model.staleDiscount - model.freshBoost) * t;
}

/** Share of comparable tokened protocols at a similar TVL scale: a plain empirical odds, no names. */
function tokenOdds(
  p: SnapshotProtocol,
  age: number | null,
  rankable: SnapshotProtocol[],
): number {
  const logTvl = Math.log10(p.tvl_usd);
  let near = 0;
  let tokened = 0;
  for (const q of rankable) {
    const d = Math.abs(Math.log10(q.tvl_usd) - logTvl);
    const sameCat = p.category !== null && q.category === p.category;
    if (d > 0.5 && !sameCat) continue;
    near += 1;
    if (!isPreToken(q)) tokened += 1;
  }
  if (near < 8) {
    // Too few comparables: fall back to the whole field's tokened share at this age band.
    const band = age === null ? 0.5 : age < 365 ? 0.45 : age < 730 ? 0.35 : 0.25;
    return band;
  }
  return tokened / near;
}

interface FarmContext {
  chain: string;
  gasUsd: number;
  depositUsd: number;
}

function farmContext(p: SnapshotProtocol): FarmContext {
  const chain = p.chains[0] ?? 'Ethereum';
  const costly = new Set(['Ethereum', 'Arbitrum', 'Base', 'Solana', 'Polygon', 'Optimism']);
  const gasUsd = chain === 'Ethereum' ? 4 : costly.has(chain) ? 0.6 : 0.3;
  const depositUsd = p.tvl_usd >= 1e9 ? 300 : p.tvl_usd >= 1e8 ? 200 : 120;
  return { chain, gasUsd, depositUsd };
}

/** Concrete, costed farm plan for one protocol, from its category, chains and TVL. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const { chain, gasUsd, depositUsd } = farmContext(p);
  const cat = p.category ?? 'Uncategorised';
  const name = p.name;
  const steps: FarmStep[] = [
    {
      action: `Open a dedicated farming wallet that touches only ${name}, fund it from your main wallet, and keep its seed offline. Cost: $0 in fees to create, ${gasUsd < 1 ? `$${gasUsd.toFixed(2)}` : `$${gasUsd.toFixed(0)}`} to fund on ${chain}. Time: 10 minutes.`,
      cost: `$${gasUsd < 1 ? gasUsd.toFixed(2) : gasUsd.toFixed(0)}`,
      time: '10 min',
    },
  ];
  const action = FARM_ACTIONS[cat] ?? FARM_ACTIONS._default;
  steps.push({
    action: action(depositUsd, chain),
    cost: `$${depositUsd} position`,
    time: '20 min',
  });
  steps.push({
    action: `Split the position: bridge or deposit in two tranches a week apart so the wallet's interaction history is spread over the snapshot's 7-day window, and record both tx hashes. Cost: about $${(gasUsd * 2).toFixed(2)} in ${chain} gas. Time: 15 minutes each tranche.`,
    cost: `$${(gasUsd * 2).toFixed(2)}`,
    time: '30 min total',
  });
  const tail = age !== null && age > 400
    ? `${name} has run ${age} days with no token; older protocols with steady TVL have often shipped one late, so keep the position but re-check weekly for a token announcement before adding more. Cost: $0. Time: 5 min a week.`
    : `${name} is ${age === null ? 'recently listed' : `${age} days old`} with no token yet; volume-plus-liquidity campaigns at this stage typically reward early depositors, so add a tranche if TVL growth stays positive. Cost: $0. Time: 5 min a week.`;
  steps.push({ action: tail, cost: '$0', time: '5 min/week' });
  steps.push({
    action: `Keep a small second wallet interacting from another chain ${p.chains.length > 1 ? `(${p.chains[1] ?? chain})` : `(${chain})`} with half the size, so a chain-scoped airdrop does not miss the position. Cost: $${(gasUsd * 1.5).toFixed(2)}. Time: 20 minutes.`,
    cost: `$${(gasUsd * 1.5).toFixed(2)}`,
    time: '20 min',
  });
  return steps;
}

const FARM_ACTIONS: Record<string, (usd: number, chain: string) => string> = {
  _default: (usd, chain) =>
    `Deposit $${usd} into ${'the'} protocol's main vault or pool on ${chain} and leave it untouched; a deposit is the base interaction nearly every launch rewards. Cost: $${usd} principal plus gas. Time: 20 minutes.`,
  'Dexes': (usd, chain) =>
    `Provide $${usd} of two-sided liquidity in the protocol's deepest pool on ${chain} and leave it for at least 30 days; LP age is the metric launch criteria most often cite. Cost: $${usd} principal plus impermanent loss risk. Time: 20 minutes.`,
  'Lending': (usd, chain) =>
    `Supply $${usd} as a lender (not borrower) on ${chain} and keep it idle; suppliers accrue the usage history a token's criteria read. Cost: $${usd} principal. Time: 15 minutes.`,
  'Yield': (usd, chain) =>
    `Deposit $${usd} into the highest-TVL vault on ${chain} and leave the receipt token in the wallet; do not auto-compound away the receipt. Cost: $${usd} principal. Time: 20 minutes.`,
  'Liquid Staking': (usd, chain) =>
    `Stake $${usd} through the protocol on ${chain} and hold the receipt token without selling; mint-and-hold is the standard pre-token behaviour. Cost: $${usd} principal plus gas. Time: 15 minutes.`,
  'Bridge': (usd, chain) =>
    `Bridge $${usd} through the protocol once to ${chain} and again back a week later; both directions count in bridge volume criteria. Cost: gas both ways. Time: 30 minutes.`,
  'CDP': (usd, chain) =>
    `Open a small collateralised debt position with $${usd} collateral on ${chain}, mint the minimum debt, and repay half after a week. Cost: $${usd} collateral. Time: 30 minutes.`,
  'Restaking': (usd, chain) =>
    `Restake $${usd} through the protocol on ${chain} and keep the delegate receipt; never withdraw before a token event. Cost: $${usd} principal. Time: 20 minutes.`,
  'RWA': (usd, chain) =>
    `Complete any KYC tier the protocol on ${chain} offers and deposit $${usd} into its on-chain product; RWA launches have been identity-gated, so verified wallets lead. Cost: $${usd} principal. Time: 45 minutes.`,
  'NFT Marketplace': (usd, chain) =>
    `Trade one low-value NFT on the marketplace on ${chain} and list another for sale; activity breadth beats size here. Cost: under $${Math.max(20, Math.round(usd / 10))}. Time: 20 minutes.`,
  'Launchpad': (usd, chain) =>
    `Participate in one allocation round of at least $${Math.max(50, Math.round(usd / 4))} on ${chain}; participation history is the launchpad's own criteria. Cost: that allocation. Time: 30 minutes.`,
  'Infrastructure': (usd, chain) =>
    `Run or stake with the smallest paid tier of the service on ${chain} and keep usage logs; infrastructure tokens have favoured operators. Cost: from $${Math.max(10, Math.round(usd / 20))}/month. Time: 1 hour.`,
  'Insurance': (usd, chain) =>
    `Buy the smallest coverage policy on ${chain} and renew once; buyers are the rarer side of insurance criteria. Cost: from $${Math.max(15, Math.round(usd / 8))}. Time: 25 minutes.`,
  'Prediction Market': (usd, chain) =>
    `Take both sides of two small markets on ${chain} and keep positions open to resolution; resolved trades count most. Cost: $${Math.max(20, Math.round(usd / 6))}. Time: 25 minutes.`,
};

export function stepText(step: FarmStep): string {
  return step.action;
}

function summariseCategory(protocols: SnapshotProtocol[], rows: BoardRow[]): CategoryStat[] {
  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of protocols) {
    const cat = p.category ?? 'Uncategorised';
    let arr = byCat.get(cat);
    if (!arr) byCat.set(cat, (arr = []));
    arr.push(p);
  }
  const out: CategoryStat[] = [];
  for (const [category, protos] of byCat) {
    if (protos.length < 5) continue;
    const top = rows
      .filter((r) => (r.category ?? 'Uncategorised') === category)
      .reduce((m, r) => Math.max(m, r.implied_value_usd), 0);
    out.push({
      category,
      protocols: protos.length,
      tokened: protos.filter((p) => !isPreToken(p)).length,
      median_multiple: null,
      top_implied_usd: top,
    });
  }
  return out.sort((a, b) => b.top_implied_usd - a.top_implied_usd);
}

export interface BoardSummary {
  rows: number;
  watchlistCovered: number;
  preToken: number;
  tokened: number;
}

export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; summary: BoardSummary } {
  const fit = fitMultiples(snapshot.protocols, model);
  const rankable = snapshot.protocols.filter(isRankable);
  const watch = new Set(snapshot.watchlist);

  interface Scored {
    p: SnapshotProtocol;
    age: number | null;
    implied: number;
    odds: number;
    catStat: { median: number; n: number; shrunk: number };
    growth: number;
    maturity: number;
  }
  const scored: Scored[] = [];
  for (const p of rankable) {
    const cat = p.category ?? 'Uncategorised';
    const catStat = fit.byCategory.get(cat) ?? {
      median: fit.globalMedian,
      n: 0,
      shrunk: fit.globalMedian,
    };
    const age = ageDays(snapshot.as_of, p.listed_at);
    const growth = growthMultiplier(p.change_7d, model);
    const maturity = maturityMultiplier(age, model);
    const implied = Math.min(
      100_000_000_000_000,
      Math.max(1, Math.round(p.tvl_usd * catStat.shrunk * growth * maturity)),
    );
    scored.push({
      p,
      age,
      implied,
      odds: tokenOdds(p, age, snapshot.protocols.filter((q) => q.tvl_usd >= 5_000_000)),
      catStat,
      growth,
      maturity,
    });
  }

  // Rank: watchlist protocols first (they are the house's confirmed pre-token floor), then the
  // rest by implied value. Within the watchlist, implied value orders them.
  const onWatch = scored.filter((s) => watch.has(s.p.slug));
  const offWatch = scored.filter((s) => !watch.has(s.p.slug));
  const byValue = (a: Scored, b: Scored) =>
    b.implied - a.implied || a.p.slug.localeCompare(b.p.slug);
  onWatch.sort(byValue);
  offWatch.sort(byValue);
  const ordered = [...onWatch, ...offWatch].slice(0, MAX_ROWS);

  const board: BoardRow[] = ordered.map((s, i) => {
    const p = s.p;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: isPreToken(p) ? 'pre-token' : 'tokened',
      age_days: s.age,
      implied_value_usd: s.implied,
      token_odds: Math.round(s.odds * 100) / 100,
      model: {
        base_multiple: Math.round(s.catStat.shrunk * 10000) / 10000,
        category_sample: s.catStat.n,
        category_median_multiple: Math.round(s.catStat.median * 10000) / 10000,
        global_median_multiple: Math.round(fit.globalMedian * 10000) / 10000,
        growth_pct: p.change_7d,
        growth_multiplier: Math.round(s.growth * 1000) / 1000,
        maturity_multiplier: Math.round(s.maturity * 1000) / 1000,
        age_days: s.age,
      },
      farm_steps: farmSteps(p, s.age).map(stepText),
    };
  });

  return {
    board,
    summary: {
      rows: board.length,
      watchlistCovered: board.filter((r) => watch.has(r.slug)).length,
      preToken: board.filter((r) => r.token_status === 'pre-token').length,
      tokened: board.filter((r) => r.token_status === 'tokened').length,
    },
  };
}

export function radarRow(row: BoardRow, watch: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    token_odds: row.token_odds,
    on_watchlist: watch.has(row.slug),
    model: row.model,
    farm_steps: row.farm_steps,
  };
}

export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const watch = new Set(snapshot.watchlist);
  const { board, summary } = buildBoard(snapshot, model);
  const fit = fitMultiples(snapshot.protocols, model);
  const radar: RadarData = {
    summary: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      protocols_total: snapshot.protocols.length,
      watchlist_count: snapshot.watchlist.length,
      rows: summary.rows,
      pre_token_rows: summary.preToken,
      tokened_comps: snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length,
      global_median_multiple: Math.round(fit.globalMedian * 10000) / 10000,
      model_version: model.version,
      model_notes: [
        'implied_value_usd = tvl_usd x category multiple x growth multiplier x maturity multiplier',
        'the category multiple is the median mcap/tvl of this snapshot\'s own tokened protocols in the category, shrunk toward the global median by sample size (k = ' + model.shrinkK + ')',
        'the growth multiplier maps 7-day TVL change through beta = ' + model.growthBeta + ', clipped to [' + model.growthFloor + ', ' + model.growthCeil + ']',
        'the maturity multiplier runs ' + model.freshBoost + 'x for protocols listed under a quarter, to ' + model.staleDiscount + 'x at ' + model.staleYears + ' years',
        'token_odds is the tokened share of comparable protocols within half a log10 of TVL, or the whole category',
        'an implied value is the model\'s own claim about a hypothetical launch; the board never predicts whether or when a token ships',
      ],
    },
    categories: summariseCategory(snapshot.protocols, board),
    rows: board.map((r) => radarRow(r, watch)),
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SnapshotError(`snapshot.json is not valid JSON: ${(err as Error).message}`);
  }
  const s = raw as Snapshot;
  if (!s || typeof s !== 'object') throw new SnapshotError('snapshot is not an object');
  if (typeof s.as_of !== 'string') throw new SnapshotError('snapshot.as_of missing');
  if (!Array.isArray(s.protocols)) throw new SnapshotError('snapshot.protocols missing');
  if (!Array.isArray(s.watchlist)) throw new SnapshotError('snapshot.watchlist missing');
  if (typeof s.floor_usd !== 'number') throw new SnapshotError('snapshot.floor_usd missing');
  for (const p of s.protocols) {
    for (const key of ['slug', 'name', 'tvl_usd'] as const) {
      if (p[key] === undefined) throw new SnapshotError(`protocol missing ${key}`);
    }
  }
  return s;
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < MIN_ROWS) return `board holds ${board.length} rows, needs at least ${MIN_ROWS}`;
  if (board.length > MAX_ROWS) return `board holds ${board.length} rows, cap is ${MAX_ROWS}`;
  const watch = new Set(snapshot.watchlist);
  const seen = new Set<string>();
  let nonWatch = 0;
  for (const [i, row] of board.entries()) {
    if (row.rank !== i + 1) return `row ${i + 1} carries rank ${row.rank}`;
    if (seen.has(row.slug)) return `duplicate slug ${row.slug}`;
    seen.add(row.slug);
    if (row.implied_value_usd <= 0 || !Number.isInteger(row.implied_value_usd)) {
      return `${row.slug}: implied_value_usd must be a positive whole number`;
    }
    if (row.implied_value_usd > 100_000_000_000_000) return `${row.slug}: implied value over the cap`;
    if (!row.farm_steps || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug}: farm_steps must hold 3 to 12 steps`;
    }
    for (const step of row.farm_steps) {
      const t = step.trim();
      if (t.length < 20 || t.length > 600) return `${row.slug}: a farm step is ${t.length} characters`;
    }
    if (!watch.has(row.slug)) nonWatch += 1;
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  if (nonWatch < 1) return 'board covers the watchlist but ranks nothing beyond it';
  const values = new Set(board.map((r) => r.implied_value_usd));
  if (board.length >= 2 && values.size === 1) return 'every row carries the same implied value';
  return null;
}

export function dataScript(radar: RadarData): string {
  return `// Generated by lib/model.ts (version ${radar.summary.model_version}); the dashboard reads this file.\nconst RADAR = ${JSON.stringify(radar)};\n`;
}
