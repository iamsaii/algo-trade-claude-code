# AI Trading Agent — Operations Runbook

One LLM decision per trading morning (Gemini), executed through Zerodha Kite
Connect. Paper-first, then live behind two explicit flags. The agent is
long-only (CNC delivery + MIS intraday), never shorts, never touches F&O, and
can never sell your manual holdings or IPO allotments — it only sells lots it
bought itself (Kite order tag `ai-agent` **and** a matching row in its own
`ai_ledger`).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Yes (decide) | Gemini API key (free tier OK). Without it `ai:decide` skips and journals a NOTE — never trades. |
| `KITE_API_KEY` | Yes (live) | From apps.kite.trade → your Kite Connect app. |
| `KITE_API_SECRET` | Yes (live, TOTP login) | Same app. Used for the session checksum. |
| `KITE_USER_ID` | Yes (live, TOTP login) | Your Zerodha client ID (user ID). |
| `KITE_PASSWORD` | Yes (live, TOTP login) | Zerodha account password (only used for the automated login exchange). |
| `KITE_TOTP_SECRET` | Yes (live, TOTP login) | Base32 TOTP secret from your authenticator app setup — the agent generates the 6-digit codes itself. |
| `KITE_ACCESS_TOKEN` | No | Pre-generated access token; skips the TOTP login if set. Otherwise the token is persisted in `data/.kite_token.json` (gitignored) and reused. |
| `KITE_LIVE` | Yes (live) | Must be exactly `1`. Without it `--live` is refused — the double guard against accidental real-money runs. |

Keep all of these out of git (they belong in your shell profile, `.env`, or the
cron environment). `data/.kite_token.json` is a secret — never commit it.

## Kite developer-app setup (free Personal tier)

1. Go to <https://apps.kite.trade>, create a **Kite Connect** app (Personal
   tier is free).
2. Note the **API key** and **API secret**.
3. Set the app's **redirect URL** to any URL you control (e.g.
   `https://example.com/callback`). The agent never visits it — it only reads
   the one-time `request_token` out of the redirect.
4. TOTP login flow (what `connect()` does when no token exists):
   login page → POST credentials → POST the 6-digit TOTP → follow the
   redirect → exchange `request_token` + checksum
   (`sha256(api_key + request_token + api_secret)`) for an access token.
5. Free-tier caveat: historical/backtest endpoints need paid market data;
   live quotes (`getQuote`) may or may not be allowed — the agent falls back
   to Yahoo Finance automatically when Kite denies quotes. The `ai:check` /
   `ai:eod` stop logic works either way.

## Gemini setup

Create an API key in Google AI Studio (free tier is enough — one small call
per morning). The model defaults to `gemini-2.0-flash` (`ai.llm.model` in
`src/core/config.js`).

## Config knobs (`src/core/config.js`, `ai` block)

| Key | Default | Meaning |
|---|---|---|
| `ai.dailyBudget` | `1000` | Margin rupees the agent may commit per day (resets daily; sale proceeds never refill it). |
| `ai.maxTrades` | `2` | Max new AI trades per day. |
| `ai.dailyLossLimitPct` | `0.05` | Auto halt for the day once today's realized loss ≥ 5% of budget. |
| `ai.misLeverage` | `5` | Intraday margin multiplier used for quantity math. |
| `ai.eodExitEnabled` | `true` | Square off all AI lots at EOD. Set `false` to hold CNC overnight (MIS still always closes). |
| `ai.llm.model` | `gemini-2.0-flash` | Gemini model. |
| `ai.tag` | `ai-agent` | Kite order tag — the ownership marker. Don't change it once live. |
| `market.symbols` | 5 large caps | The watchlist the gate enforces — the agent can only buy listed symbols. |

## Commands

```bash
npm run ai:decide   # morning decision run (paper broker by default)
npm run ai:live     # currently REFUSED — see "Live status" below
npm run ai:eod      # end-of-day square-off (MIS always; CNC if enabled)
npm run ai:check    # stop-loss check (paper mode; every 15 min)
```

## Live status: disabled

`ai:live` refuses to run (exit 1) and always will until broker-side fills
are reconciled into the `ai_ledger`. Why: in live mode Kite reports an
accepted order, not a fill — and broker-side SL-M exits between runs are
invisible to the ledger. Unreconciled, that means phantom lots, duplicate
sells, and a daily-loss kill switch blind to the main live loss path. Paper
mode fills synchronously and is unaffected, so every safety rail (gate,
budget, stops, EOD, kill switches) is fully exercised in paper. Re-enabling
live is a code change (order-status read-back + position reconciliation),
not a configuration flip.

## First run (paper-first protocol)

1. `npm install`
2. Export `GEMINI_API_KEY` (paper needs nothing else).
3. (Was: a real-credential live smoke — now moot, `ai:live` is refused.
   The TOTP login path is exercised by unit tests; a real-login smoke
   returns with the live-reconciliation work.)
4. Run **3–5 full paper days** with the cron below *without* `--live`.
   Audit each day against `logs/journal/YYYY-MM-DD.md` and `data/trading.db`:
   - every `[DECISION]` has a rationale and stays inside the budget;
   - every `[REJECTED]` reason looks right (gate working);
   - stops were attached (or `[NOTE no-broker-stop]` only in paper mode);
   - `[EXIT]` rows show the square-off and P&L;
   - nothing was traded outside `market.symbols`.
5. Going live requires the reconciliation work above first — until then
   the cron stays on `ai:decide` (paper).

## Cron (weekdays only, machine timezone should be Asia/Kolkata)

```cron
20 9 * 1-5  /usr/bin/env npm --prefix /path/to/repo run ai:decide
*/15 9-15 * 1-5  /usr/bin/env npm --prefix /path/to/repo run ai:check
15 15 * 1-5  /usr/bin/env npm --prefix /path/to/repo run ai:eod
```

- `ai:decide` at 09:20 (pre-open) makes the day's decisions.
- `ai:check` every 15 min enforces stops in paper mode (live has
  broker-side SL-M orders as well).
- `ai:eod` at 15:15 squares off; after it, later `ai:check` runs are no-ops.
- After EOD the paper ledger is flat — every command is idempotent, so a
  re-run or a machine reboot mid-day never double-spends the budget or
  double-sells (paper fills are synchronous; live is disabled for the
  reconciliation reasons above).

## Kill switch

- **Instant halt:** `touch data/TRADING_HALTED` — every AI command refuses to
  act until you `rm data/TRADING_HALTED`.
- **Automatic daily halt:** realized losses ≥ `dailyBudget ×
  dailyLossLimitPct` stop trading for that day (journaled as
  `[NOTE daily-loss-limit]`).
- **Paper stops:** paper has no broker-side SL-M; the `ai:check` cron
  enforces stops every 15 minutes and `ai:eod` is the end-of-day backstop.
  (Broker-side SL-M returns with the live-reconciliation work.)

## Honest caveats

- **Gap-through stops:** an overnight gap or a fast crash fills the SL-M at
  the *next* available price, not the stop price. Losses can exceed the
  planned stop. This is unfixable at retail broker level.
- **Free-tier quotes:** if both Kite quotes and the Yahoo fallback fail, the
  decide run skips (no data → no trade) and stop checks defer to the broker
  SL-M / EOD runner.
- **The LLM can be wrong.** It proposes; the deterministic gate (watchlist,
  budget, max trades, loss limit, duplicate/ownership rules) disposes. The
  rails — not the model — are what protect your capital. "No trade" is a
  valid, common outcome.
- **Manual holdings are untouchable:** the agent sells only lots recorded in
  its own `ai_ledger` with tag `ai-agent`. Anything you bought manually or
  received via IPO is invisible to it.
