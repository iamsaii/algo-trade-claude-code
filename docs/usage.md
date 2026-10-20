# Usage Guide

This repo is two things sharing one framework:

1. **The strategy framework** — backtest, paper-trade, and (with broker
   wiring) live-trade classic strategies: moving-average crossover, RSI
   mean reversion, breakout, MACD trend, VWAP mean reversion.
2. **The AI trading agent** — one Gemini decision per trading morning,
   validated by a deterministic gate, executed on a paper broker (live is
   currently fenced — see below). Documented separately in
   [ai-agent-ops.md](ai-agent-ops.md).

Everything runs as one-shot commands through `src/app.js`. Paper is the
default; nothing touches real money without explicit, separate opt-ins.

## Install & verify

```bash
npm install
npm test          # ~49 tests, no network, no credentials needed
```

## Quick start

```bash
# Replay 2024 historical data for RELIANCE through every strategy
npm run start:backtest

# Run the paper-trading simulator (starts immediately, runs until stopped)
npm run start:paper
```

Paper mode simulates a live market: 1-second random-walk ticks, 5-minute
candles, five watchlist symbols (RELIANCE, INFY, HDFCBANK, TCS, ICICIBANK)
starting from built-in prices. It is a **simulator, not real quotes** — it
exists to exercise strategy logic, order flow, and risk management end to
end.

## Command reference

```bash
node src/app.js --mode <mode> [--symbol <SYM>] [--strategy <name>] \
                [--capital <INR>] [--dry-run] [--live]
```

| Flag | Default | Meaning |
|---|---|---|
| `--mode` | `paper` | `paper`, `backtest`, `live`, `ai`, `check`, `eod` |
| `--symbol` | `RELIANCE` | Symbol for backtest (matches `data/historical/symbols/<SYM>.json`) |
| `--strategy` | `all` | Fuzzy name filter: `ma`, `rsi`, `breakout`, `macd`, `vwap`, or `all` |
| `--capital` | `100000` | Starting capital in ₹ (paper + backtest) |
| `--dry-run` | off | Forces the paper broker regardless of mode — never real money |
| `--live` | off | AI modes only: real Kite broker (currently refused, see below) |

Modes:

| Mode | What it does | Money at risk |
|---|---|---|
| `paper` | Continuous simulated trading, all enabled strategies | None — simulated fills |
| `backtest` | Replays historical JSON, reports performance metrics | None |
| `live` | Framework live trading | Real — but requires `KITE_API_KEY` + `KITE_ACCESS_TOKEN` **and** a configured market-data feed (`market.liveFeed.enabled`); refuses to start otherwise rather than price real orders off the simulator |
| `ai` | AI agent morning decisions (paper broker) | None in current configuration |
| `check` | AI agent stop-loss check (15-min cron) | None |
| `eod` | AI agent end-of-day square-off (15:15 cron) | None |

npm shortcuts: `start`, `start:paper`, `start:backtest`, `ai:decide`,
`ai:check`, `ai:eod`, `ai:live`, `test`, `generate-data`.

## Strategies

Five strategies run enabled by default; each has its own config block in
`src/core/config.js` (thresholds, periods, `enabled: true|false`):

| `--strategy` value | Strategy | Idea |
|---|---|---|
| `ma` | MovingAverageCrossover | Short/long SMA cross |
| `rsi` | RSIMeanReversion | Buy oversold, exit overbought |
| `breakout` | Breakout | Enter on N-period high breakout |
| `macd` | MACDTrend | MACD trend + optional ADX filter |
| `vwap` | VWAPMeanReversion | Volume-weighted mean reversion |

In backtest, `--strategy ma` runs only strategies whose name contains
"ma"; `all` runs everything enabled.

## Configuration (`src/core/config.js`)

| Block | Key knobs (defaults) |
|---|---|
| `market` | watchlist symbols, 1000 ms ticks, 5-min candles, live feed (off) |
| `trading` | `initialCapital` 100000, `maxRiskPerTrade` 1%, `maxDailyLoss` 5%, `maxOpenTrades` 5, `defaultStopLoss` 2%, `defaultTarget` 4% |
| `strategies.*` | per-strategy periods/thresholds + `enabled` |
| `backtest` | date range (2024), initial capital |
| `ai` | `dailyBudget` 1000 (margin ₹), `maxTrades` 2, `dailyLossLimitPct` 5%, `misLeverage` 5, `eodExitEnabled` true, `llm.model` gemini-2.0-flash, `tag` `ai-agent` |

The AI agent reads only the `ai` + `market.symbols` blocks; the framework
strategies ignore the `ai` block. The two paths never share orders.

## Data

- **Historical (backtest):** JSON candles per symbol under
  `data/historical/symbols/<SYMBOL>.json` — ten NSE symbols are committed
  as fixtures. Add your own in the same shape, or regenerate fixtures with
  `npm run generate-data`.
- **Paper feed:** simulated (see above) — no data files needed.
- **AI agent:** live quotes come from Kite, falling back to Yahoo Finance
  (`.NS` symbols) — details and caveats in ai-agent-ops.md.

## Where state lives

| Path | Contents |
|---|---|
| `logs/algo-trading-YYYY-MM-DD.log` | Rotating runtime log |
| `logs/journal/YYYY-MM-DD.md` | AI decision journal (decisions, rejections, exits, notes) — the audit trail |
| `data/trading.db` | SQLite: framework trades + AI ledger (`ai_ledger`) — budget, open lots, realized P&L |
| `data/TRADING_HALTED` | Kill switch: `touch` it to stop every AI action; `rm` to re-enable. Halts new entries only — stops and EOD exits keep firing |
| `data/.kite_token.json` | Persisted Kite session token (secret, gitignored) |

All of these are gitignored runtime state.

## The AI agent in one paragraph

Cron-driven one-shots: `ai:decide` at 09:20 makes the day's decisions (one
Gemini call, then a deterministic gate — watchlist, budget, max trades,
daily-loss halt, stop sanity — computes every quantity; the LLM never does
math and can never sell anything it didn't buy), `ai:check` enforces stops
every 15 minutes, `ai:eod` squares off at 15:15. Paper-first by design;
`ai:live` currently refuses to run until broker-fill reconciliation ships.
Full runbook — env vars, cron lines, paper protocol, caveats:
**[ai-agent-ops.md](ai-agent-ops.md)**.

## Tests

`npm test` runs the whole suite (strategies, backtest, execution, broker
plumbing, AI gate/ledger/runners) — no network, no credentials, in-memory
databases. Run it after any config or code change.
