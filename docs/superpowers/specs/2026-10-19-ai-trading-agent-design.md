# AI Trading Agent — Design (Delivery/CNC, LLM-decided)

Date: 2026-10-19
Status: draft, awaiting approval

## Intent

The user trades delivery (CNC) only, on Zerodha, with a small daily budget
(configurable; ₹1000 was their example) and a realistic goal of small daily
profit with **as close to zero loss as possible**. They want an LLM to make
the buy/sell decisions based on what the market looks like *that particular
day*, and the existing framework (5 rule-based strategies, paper broker, risk
manager, order manager, position monitor, sqlite trade log, placeholder
`kiteBroker.js`) to do the plumbing. The account also holds manual positions
that must never be touched.

In one sentence: one LLM decision at market open each day, hard risk limits in
code, orders through Kite, everything runs paper-first.

## Goals

1. Live Kite connectivity: auto login, quotes, CNC order placement, positions.
2. A daily AI decision step: build a market brief, ask the LLM for a trade
   plan (strict JSON), validate it in code, execute it.
3. Hard safety rails that the LLM cannot override: daily spend cap (config),
   max 2 trades/day, broker-side stop-loss on every position, no shorting, no
   selling anything the agent didn't buy, kill switch on daily loss.
4. Full loop runs against PaperBroker first; live is a config flag.
5. Every LLM decision, rationale, and outcome logged to sqlite + a readable
   daily journal (markdown) so the user can audit why each trade happened.

## Non-goals / Anti-goals

- **No IPO application via API.** Kite Connect has no IPO-order endpoint; IPO
  bids go through UPI on the Kite web/app. If wanted later, v2 can *recommend*
  IPOs (GMP + subscription data) but cannot apply. Out of scope here.
- Intraday MIS **is** allowed (leverage ≈ 5x on a ₹1000 margin, which is why
  the budget stretches further), CNC for higher-conviction picks. No shorting,
  options, or F&O. MIS positions are always squared off same-day (broker
  auto-square-off ~15:20 as backstop; our 15:15 run fires first).
- No backtesting the LLM (unrepeatable and expensive). The 5 existing rule
  strategies stay untouched and usable as comparison, but the AI agent does
  not call them.
- No streaming/tick-level AI decisions. One decision per day at open. (This
  is the cost/complexity line.)
- No portfolio diversification logic — ₹1000 buys 1–2 names, that's it.

## Constraints (real-world, must not be papered over)

- **₹1000 budget** = CNC = maybe 1–2 shares of a ₹300–600 stock or ~10 shares
  of a ₹90 stock. Quantities round down; leftover cash sits idle. Fine.
- **Kite Connect has a free Personal tier** (orders, GTT, portfolio, margin —
  confirmed on kite.trade, 2026). The ₹500/month tier only adds websocket
  streaming + historical candles, neither needed here. Quotes (LTP) coverage
  on the free tier is unconfirmed, so: try Kite `getQuote`, fall back to
  yfinance (free, no key). Cost objection gone.
- **Access token expires daily.** Auto-login via TOTP (kiteconnect supports
  it) using KITE_TOTP_SECRET; falls back to a manual login URL if TOTP isn't set.
- **LLM: Gemini free tier** (Google AI Studio), called via plain `fetch` —
  no SDK dependency needed. If limits ever bite, provider stays swappable
  behind one function; an API key in env is the only requirement.
- **Budget is a config value**, not a hardcoded ₹1000 (that was an example).
  All math derives from `ai.dailyBudget`.
- **The LLM is never trusted with math.** It returns intent (symbol, side,
  qty is *proposed*, entry, SL, target, confidence, rationale); code recomputes
  quantity from price + budget and rejects anything violating risk rules.

## How it works

### Daily flow

```
09:15  market open → fetch quotes/gaps for watchlist + Nifty sector snapshot
09:20  build MARKET_BRIEF (yesterday's closes, gaps, top movers, user's
       recent trade P&L, open AI positions)
       → LLM call: "you have ₹{budget} margin (MIS ≈5x leverage, CNC 1x),
         long-only, goal: small profit, avoid loss. Return JSON:
         {decisions:[{action, symbol, product: MIS|CNC, entry, stop_loss,
         target, confidence, rationale}]} or {decisions:[]}
         (empty is a valid, respectable answer)"
       → validate: budget incl. leverage, count, SL present, symbol in NSE
         universe, qty math, MIS auto-flagged for same-day exit
       → validate: budget, count, SL present, symbol in NSE universe, qty math
09:25  place CNC LIMIT orders via Kite (or PaperBroker); on fill, place
       broker-side SL-M immediately
15:15  EOD exit: square off open AI positions at market (default ON;
       config can switch to "hold overnight with SL")
       → log outcome, update journal, feed P&L into tomorrow's brief
```

### New code (small)

| File | What |
|------|------|
| `src/ai/marketBrief.js` | Assembles the brief from Kite quotes + tradeRepository history |
| `src/ai/llmAdvisor.js` | One function: brief in → validated trade plan out (JSON schema enforced, one retry on bad JSON, then `decisions: []`) |
| `src/ai/aiGate.js` | Pure validation: budget incl. MIS leverage, trade count, SL mandatory, qty math, symbol whitelist |
| `src/ai/journal.js` | Daily markdown journal of decisions + rationale |
| `src/app.js` | `--mode ai` (paper) / `--mode ai --live` wired in |

### Changed code

| File | Change |
|------|--------|
| `src/brokers/kiteBroker.js` | Fill in the placeholder: TOTP auto-login, getQuote, placeOrder(CNC), positions, holdings |
| `src/core/config.js` | `ai.*` block: dailyBudget, maxTrades 2, dailyLossLimitPct, llm provider+model, EOD exit time, live flag |
| `package.json` | dep: `kiteconnect` only (Gemini via native fetch, yfinance via fetch) |

### Decisions made after builder check

- **Stop-loss mechanism: broker-side SL-M order** placed immediately after each
  fill (tagged). Survives the process crashing / laptop sleeping. In paper mode
  it's simulated against real quotes. No in-process tick loop is built.
- **Process model: cron/launchd one-shots, not a daemon.** Two commands:
  `ai:decide` (09:20) and `ai:eod` (15:15), each idempotent. The 15:15 run
  never depends on the 09:20 process still being alive.
- **AI positions are tagged** with Kite order tag `ai-agent`, and every buy the
  agent makes is also recorded in its own sqlite ledger. The agent may only
  ever SELL quantities from that ledger (symbol + qty it bought itself).
  Manual holdings, manual positions, and IPO allotments are untouchable —
  double protection: tag match AND ledger match required before any sell.
- **Budget semantics:** ₹1000 is gross spend per day, resets at 09:15. Proceeds
  from a sale do NOT refill the same day's budget (conservative). `aiGate`
  replaces the percent-based `riskManager.checkSignal` checks for AI mode;
  riskManager still owns the kill switch with an absolute ₹100 daily-loss
  override.
- **Overnight-hold config switch semantics:** agent may only buy new positions;
  exits are SL or EOD only. It never issues a "sell" decision for an existing
  holding. (Default remains EOD exit ON.)
- **Paper mode uses real Kite quotes + PaperBroker fills** so the brief
  describes a real market. No free-data pipeline is built.

### Safety design (loss-as-low-as-possible)

Priority order: never lose much > never miss profit. Concretely:

- **Broker-side SL-M on every buy**, placed right after fill. A gap-down can
  still slip past the stop — code cannot promise literally ₹0 loss, and the
  doc won't pretend otherwise. Everything below narrows the gap.
- **Daily loss kill switch** = configurable fraction of budget, default 5%
  (₹50 on a ₹1000 day ≈ two stop-outs), after which no new orders until
  tomorrow. riskManager owns it via an absolute-value override.
- **"No trade" is a first-class decision.** The prompt tells the LLM that
  skipping a bad day beats forcing a trade; gate allows empty decisions.
- Risk manager gets a `budget` override = `ai.dailyBudget`. `aiGate` replaces
  the percent-based `riskManager.checkSignal` checks for AI mode.
- `aiGate.js` runs *after* the LLM and *before* any broker call. No gate pass,
  no order. The LLM cannot bypass it by prompt injection (its output is data,
  never code).
- Kill switch: `trading halted` file or config blocks all new orders.
- Live mode requires an explicit `--live` flag AND `KITE_LIVE=1` env; a
  missing TOTP or token never silently falls back to live.

## Phases

0. **Kite plumbing** — install deps, TOTP login, quotes, positions, CNC orders.
   Verified against a live account in read-only fashion first.
1. **Paper AI loop** — brief + LLM + gate + PaperBroker. Runs `--mode ai`.
   Verify: 3–5 paper days, journal reads sensibly, gate blocks bad output.
2. **Live, tiny** — `--live` with ₹1000. One week. Audit journal daily.
3. (optional, later) IPO *recommendations* — separate command, no API.

## What's left to the builder (my calls, marked)

- LLM: Gemini free tier via native fetch — decided. Env `GEMINI_API_KEY`.
- Watchlist source: config `market.symbols` (already exists) — my call.
- Default EOD exit ON — my call, config-switchable.
- Entry order type: LIMIT near open price, cancel-if-unfilled in 5 min — my call.
