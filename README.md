# deepwater-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aethersixxx/deepwater-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aethersixxx/deepwater-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Deepwater** is a token launch radar for make.fun's "Build the best token launch radar" bounty ($1,325 in USDC): it reads a sealed DefiLlama snapshot, ranks protocols that record no token by an implied launch value, and hands in a static dashboard — a sortable, filterable board, a detail view for every protocol with the value model's own arithmetic, and a costed farm plan for each one.

## The value model

```
implied_value_usd = tvl_usd × category multiple × growth multiplier × maturity multiplier
```

- The **category multiple** is the median mcap/tvl of the snapshot's own tokened protocols in that category, shrunk toward the global median by sample size, so thin categories stay honest.
- The **growth multiplier** maps 7-day TVL change through a fixed beta, clipped to sane bounds.
- The **maturity multiplier** rewards freshness: protocols listed under a quarter score higher than those running for years with no token.
- **token_odds** is the tokened share of comparable protocols within half a log₁₀ of the same TVL, or the whole category when there are too few.

An implied value is the model's claim about a hypothetical launch — never a prediction that a token ships, and never a figure make.fun endorses. The board always covers the whole watchlist (TVL ≥ $50M, no token recorded, not a wrapped or staked product of a traded token) and reaches past it: protocols below the floor are the early finds the radar exists to surface.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node.js 22.18 or later, standard library only, no network. `main.ts` writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to `/output` (or `$MAKEFUN_OUTPUT_DIR`).

## Repository layout

- `main.ts` — the entrypoint: parse the snapshot, score, validate, write `/output`
- `lib/model.ts` — the valuation model, farm-plan generator and board validation
- `dashboard/` — the static page (vanilla HTML/CSS/JS, renders with no network)
- `screenshots/` — the board, a protocol's detail view and a filtered view
- `vendor/makefun-board.ts` — make.fun's dossier library

---

<sub>Entered on [make.fun](https://make.fun/?ref=hw3excn8&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
