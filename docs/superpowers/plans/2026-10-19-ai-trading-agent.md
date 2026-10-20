# AI Trading Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An LLM (Gemini free tier) makes one CNC/MIS trade decision per trading morning through Kite (free Personal tier), with hard-coded risk rails, broker-side stop-losses, and a same-day square-off — paper-traded first, live behind two flags.

**Architecture:** New `src/ai/` module (brief → LLM → gate → broker) layered on the existing framework. `aiGate` is a pure function that validates every LLM decision before any broker call; the LLM never does math and its output is data, never code. Two one-shot commands (`ai:decide` 09:20, `ai:eod` 15:15 via cron/launchd) share state through sqlite, never through process memory.

**Tech Stack:** Node 18+ ESM, `kiteconnect` npm (only new dep), Gemini REST via native `fetch`, better-sqlite3 (existing), custom test runner `tests/runTests.js`.

**Spec:** `docs/superpowers/specs/2026-10-19-ai-trading-agent-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- Existing test command: `npm test` (runs `tests/runTests.js`; no filter flag — run the whole suite, it must stay green).
- Test style: `test('name', fn)` + `assert(cond, msg)` appended to `tests/runTests.js`, per existing pattern.
- Existing broker contract (`src/brokers/baseBroker.js`): `getPositions()` returns `NormalizedPosition[]` — `{symbol, side:'BUY'|'SELL', quantity, avgPrice, currentPrice, unrealizedPnL}`, flat rows (quantity ≤ 0) omitted.
- Existing order shape (PaperBroker/OrderManager): `{id, symbol, side:'BUY'|'SELL', quantity, entryPrice, stopLoss?, target?, strategy}`; `placeOrder` result `{success, fillPrice, quantity, orderId, action, realizedPnL, closedQuantity}`.
- AI tag constant: `'ai-agent'` — used as Kite order tag AND `strategy` value everywhere the agent trades.
- Env vars: `GEMINI_API_KEY` (required for decide), `KITE_API_KEY`, `KITE_API_SECRET`, `KITE_TOTP_SECRET`, `KITE_LIVE=1`. Live requires `--live` flag AND `KITE_LIVE=1`; missing creds must never fall back to live.
- MIS leverage multiplier: `5`; CNC multiplier: `1` (config `ai.misLeverage`).
- The agent only ever SELLs quantities recorded in its own ledger (`ai_ledger` table). Any LLM `SELL` decision is rejected by the gate — sells happen only via stop-loss/square-off paths.
- Gemini REST: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`, `generationConfig.responseMimeType: 'application/json'`.
- No new dependencies besides `kiteconnect`. No websocket, no daemon.

## Review Focus

The five inputs most likely to bite a real user, each pinned to the task that owns the code:

1. **Kite free-tier quotes may 403/limit** → quote provider must fall back to yfinance (`query1.finance.yahoo.com` NSE `.NS` symbols) and only fail loudly if both fail. Tested in Task 5.
2. **Gemini free-tier quota / 503 / malformed JSON** → decide run must end with zero orders and a journal note, exit code 0, never a crash or a half-placed order. Tested in Task 6.
3. **LLM output abuse** (missing SL, SL ≥ entry, unknown symbol, qty blowout, cumulative spend over budget, SELL attempt) → gate rejects each individually with a reason; nothing reaches the broker. Tested in Task 2.
4. **Sell guard against manual holdings** → a SELL for a symbol/qty not fully backed by today-or-prior `ai_ledger` buys is rejected. Tested in Task 2.
5. **Process-restart state** — decide and eod run in separate processes; budget-spend and open AI lots must be recomputed from sqlite, not memory (idempotent decide: second run same day places nothing new beyond remaining budget; eod squares off whatever the ledger says is open). Tested in Tasks 4 and 9.

---

### Task 1: `ai.*` config block

**Files:**
- Modify: `src/core/config.js` (defaultConfig, ~line 107)
- Test: `tests/runTests.js` (append)

**Interfaces:**
- Consumes: `config.get(path)`, `config.set(path, value)` (existing singleton).
- Produces: `ai.dailyBudget` (default `1000`), `ai.maxTrades` (2), `ai.dailyLossLimitPct` (0.05), `ai.misLeverage` (5), `ai.eodExitEnabled` (true), `ai.eodExitTime` ('15:15'), `ai.llm.provider` ('gemini'), `ai.llm.model` ('gemini-2.0-flash'), `ai.tag` ('ai-agent').

- [ ] **Step 1: Write the failing test**

```js
test('ai config block has defaults and is settable', () => {
  assert(config.get('ai.dailyBudget') === 1000, 'default budget');
  assert(config.get('ai.maxTrades') === 2, 'default maxTrades');
  assert(config.get('ai.llm.model') === 'gemini-2.0-flash', 'default model');
  config.set('ai.dailyBudget', 5000);
  assert(config.get('ai.dailyBudget') === 5000, 'settable');
  config.set('ai.dailyBudget', 1000); // restore for other tests
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`, expect `✗ ai config block...` (config undefined).
- [ ] **Step 3: Implement** — add the `ai` block to `defaultConfig` with the exact keys/values above, placed after `backtest`. No env overrides needed (all runtime-settable via `config.set`).
- [ ] **Step 4: Run to verify PASS** — `npm test`, suite green.
- [ ] **Step 5: Commit** — `git add src/core/config.js tests/runTests.js && git commit -m "feat: ai agent config block"`

### Task 2: `aiGate` — pure decision validation

**Files:**
- Create: `src/ai/aiGate.js`
- Test: `tests/runTests.js` (append)

**Interfaces:**
- Consumes: config values from Task 1.
- Produces: `validateDecisions({ decisions, quotes, spentToday, openLots })` → `{ accepted: Decision[], rejected: {decision, reason}[] }` where `Decision = { action:'BUY', symbol, product:'MIS'|'CNC', entry, stopLoss, target, confidence, rationale, quantity, spend }`. `quotes: { [symbol]: { ltp, prevClose } }`. `spentToday: number` (rupees already committed today). `openLots: {symbol, quantity}[]`.

Validation rules (each rejection reason a short string):
- not `BUY` → reject (`'SELL decisions are not allowed; exits are stop-loss/EOD only'`)
- symbol not in `quotes` → `'symbol not in watchlist'`
- `product` not MIS/CNC → `'invalid product'`
- `stopLoss` missing, non-numeric, or `>= entry` → `'stop-loss must be below entry'`
- `target <= entry` → `'target must be above entry'`
- `confidence` < 0..1 number → `'invalid confidence'`
- qty math: `leverage = product === 'MIS' ? misLeverage : 1`; `budgetLeft = dailyBudget - spentToday`; `quantity = Math.floor((budgetLeft * leverage) / ltp)`; `quantity < 1` → `'cannot afford even 1 share within remaining budget'`; `spend = quantity * ltp`; running `spentToday + Σspend > dailyBudget` → `'daily budget exceeded'`
- `maxTrades` counts accepted + already-open lots → over → `'max trades for today reached'`
- duplicate symbol already in `openLots` → `'already holding this symbol'`

- [ ] **Step 1: Write failing tests** (one test per rule group, exact assertions):

```js
test('aiGate rejects SELL and accepts a valid BUY with computed qty', () => {
  const { validateDecisions } = aiGate;
  const quotes = { TCS: { ltp: 400, prevClose: 395 } };
  const r = validateDecisions({
    decisions: [
      { action: 'SELL', symbol: 'TCS', product: 'MIS', entry: 400, stopLoss: 390, target: 420, confidence: 0.8, rationale: 'x' },
      { action: 'BUY', symbol: 'TCS', product: 'MIS', entry: 400, stopLoss: 390, target: 420, confidence: 0.8, rationale: 'y' },
    ],
    quotes, spentToday: 0, openLots: [],
  });
  assert(r.rejected.length === 1 && /SELL/.test(r.rejected[0].reason), 'SELL rejected');
  // budget 1000 * leverage 5 = 5000 -> floor(5000/400) = 12 shares
  assert(r.accepted[0].quantity === 12, `qty should be 12, got ${r.accepted[0].quantity}`);
  assert(Math.abs(r.accepted[0].spend - 4800) < 1e-9, 'spend = qty * ltp');
});

test('aiGate rejects bad SL, unknown symbol, budget blowout, and oversize qty', () => {
  const quotes = { A: { ltp: 100, prevClose: 99 }, B: { ltp: 100000, prevClose: 99000 } };
  const d = (over) => ({ action: 'BUY', symbol: 'A', product: 'CNC', entry: 100, stopLoss: 95, target: 110, confidence: 0.9, rationale: 'r', ...over });
  const r = aiGate.validateDecisions({
    decisions: [
      d({ stopLoss: 105 }),                       // SL >= entry
      d({ symbol: 'ZZZ' }),                       // unknown
      d({}), d({}), d({}), d({}),                 // 6 valid -> exceeds maxTrades 2
      d({ symbol: 'B', product: 'MIS' }),         // 1000*5/100000 = 0 shares
    ],
    quotes, spentToday: 950, openLots: [],
  });
  const reasons = r.rejected.map(x => x.reason).join('|');
  assert(/stop-loss/.test(reasons), 'SL rule');
  assert(/watchlist/.test(reasons), 'symbol rule');
  assert(/max trades/.test(reasons), 'trade count rule');
  assert(/afford/.test(reasons), 'min qty rule');
});

test('aiGate blocks duplicate symbols and stays within remaining budget', () => {
  const quotes = { X: { ltp: 300, prevClose: 290 } };
  const d = { action: 'BUY', symbol: 'X', product: 'CNC', entry: 300, stopLoss: 290, target: 320, confidence: 0.7, rationale: 'r' };
  const r = aiGate.validateDecisions({ decisions: [d], quotes, spentToday: 0, openLots: [{ symbol: 'X', quantity: 2 }] });
  assert(r.accepted.length === 0 && /already holding/.test(r.rejected[0].reason), 'duplicate rejected');
  const r2 = aiGate.validateDecisions({ decisions: [d], quotes, spentToday: 900, openLots: [] });
  assert(r2.accepted.length === 0 && /budget/.test(r2.rejected[0].reason), 'budget left 100 < 300');
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`, import error / undefined.
- [ ] **Step 3: Implement** `validateDecisions({decisions, quotes, spentToday, openLots})` in `src/ai/aiGate.js` per the rules above; export named `validateDecisions` plus default object. Pure — reads limits from `config.get('ai.*')` at call time (consistent with riskManager's lazy-read pattern).
- [ ] **Step 4: Run to verify PASS** — `npm test` green.
- [ ] **Step 5: Commit** — `git add src/ai/aiGate.js tests/runTests.js && git commit -m "feat: aiGate validates LLM decisions before any order"`

### Task 3: AI ledger (sell-guard source of truth)

**Files:**
- Modify: `src/storage/tradeRepository.js` (add table in `_createTables`, add methods)
- Test: `tests/runTests.js` (append)

**Interfaces:**
- Consumes: existing `tradeRepository` singleton (`connect()`, `this.db`).
- Produces: table `ai_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, side TEXT, quantity INTEGER, price REAL, product TEXT, kite_order_id TEXT, reason TEXT, day TEXT, created_at INTEGER)` with `day` = local date `YYYY-MM-DD`. Methods:
  - `recordAiFill({ symbol, side, quantity, price, product, kiteOrderId, reason })` → row id
  - `getOpenAiLots()` → `{symbol, quantity}[]` (buys minus sells, quantity > 0 only)
  - `getSpendToday()` → total `quantity * price` of BUYs dated today
  - `getOpenAiLot(symbol)` → `{symbol, quantity, avgPrice}` or `null`

- [ ] **Step 1: Write failing test** (use a temp db path via `new TradeRepository(tmpPath)` — constructor already accepts `dbPath`):

```js
test('ai ledger tracks spend, open lots, and sell-guard quantities', async () => {
  const repo = new TradeRepository(':memory:');
  repo.connect();
  repo.recordAiFill({ symbol: 'TCS', side: 'BUY', quantity: 12, price: 400, product: 'MIS', kiteOrderId: 'k1', reason: 'ai' });
  repo.recordAiFill({ symbol: 'TCS', side: 'SELL', quantity: 5, price: 410, product: 'MIS', kiteOrderId: 'k2', reason: 'stop' });
  assert(repo.getSpendToday() === 4800, `spend should be 4800, got ${repo.getSpendToday()}`);
  const lots = repo.getOpenAiLots();
  assert(lots.length === 1 && lots[0].quantity === 7, `open lot qty 7, got ${JSON.stringify(lots)}`);
  const one = repo.getOpenAiLot('TCS');
  assert(one && one.quantity === 7, 'per-symbol lot');
  assert(repo.getOpenAiLot('INFY') === null, 'unknown symbol -> null');
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`.
- [ ] **Step 3: Implement** the table + four methods. `day` computed as `new Date().toLocaleDateString('sv')` (local YYYY-MM-DD) — same helper exported as `todayStr()` so decide/eod use one definition. `better-sqlite3` `:memory:` works with the existing constructor; verify the `dbDir` mkdir doesn't choke on `:memory:` (guard: skip mkdir when path is `:memory:`).
- [ ] **Step 4: Run to verify PASS** — `npm test` green.
- [ ] **Step 5: Commit** — `git add src/storage/tradeRepository.js tests/runTests.js && git commit -m "feat: ai_ledger records agent fills, spend, and open lots"`

### Task 4: Daily markdown journal

**Files:**
- Create: `src/ai/journal.js`
- Test: `tests/runTests.js` (append)

**Interfaces:**
- Consumes: config `logging.directory`.
- Produces: `append(dateStr, entry)` where `entry = { type: 'DECISION'|'REJECTED'|'ORDER'|'EXIT'|'NOTE', data: object }` → appends a `- HH:MM [TYPE] {json}` line to `logs/journal/YYYY-MM-DD.md` (mkdir -p). `read(dateStr)` → file content or `''`.

- [ ] **Step 1: Write failing test**

```js
test('journal appends readable entries per day', () => {
  const date = '2026-10-19';
  const { append, read } = aiJournal;
  append(date, { type: 'DECISION', data: { symbol: 'TCS', confidence: 0.8 } });
  append(date, { type: 'REJECTED', data: { symbol: 'X', reason: 'max trades' } });
  const text = read(date);
  assert(text.includes('[DECISION]') && text.includes('TCS'), 'decision line present');
  assert(text.includes('[REJECTED]') && text.includes('max trades'), 'rejection line present');
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`.
- [ ] **Step 3: Implement** `src/ai/journal.js` — `logs/journal/` under `config.get('logging.directory')`, append-only, `JSON.stringify(entry.data)` on one line. Tests write to the real logs dir (gitignored — verify `logs/` in `.gitignore`; if not, add).
- [ ] **Step 4: Run to verify PASS** — `npm test` green.
- [ ] **Step 5: Commit** — `git add src/ai/journal.js tests/runTests.js && git commit -m "feat: daily markdown journal for ai decisions"`

### Task 5: Quote provider with yfinance fallback

**Files:**
- Create: `src/ai/quotes.js`
- Test: `tests/runTests.js` (append)

**Interfaces:**
- Consumes: injectable `fetchFn` (defaults to global `fetch`) so tests never hit the network.
- Produces: `getQuotes(symbols, { kiteBroker, fetchFn })` → `{ [symbol]: { ltp, prevClose, changePct } }`.
  1. If `kiteBroker?.isConnected()`: try `kiteBroker.getQuote(symbols)` (added in Task 7; may be absent/throw on free tier) → use if it returns all symbols.
  2. Fallback: one batched call to `https://query1.finance.yahoo.com/v7/finance/quote?symbols=TCS.NS,INFY.NS` with `fetchFn`; map `.NS` back to base symbol; `ltp = regularMarketPrice`, `prevClose = regularMarketPreviousClose`.
  3. If both fail for a symbol: omit it (gate then rejects decisions on it — safe default). Log a warning.
  `changePct = ((ltp - prevClose) / prevClose) * 100`.

- [ ] **Step 1: Write failing test**

```js
test('quotes falls back to yfinance when kite is unavailable', async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return { ok: true, json: async () => ({
    quoteResponse: { result: [
      { symbol: 'TCS.NS', regularMarketPrice: 405.5, regularMarketPreviousClose: 400 },
    ] } }); };
  const r = await quotes.getQuotes(['TCS'], { kiteBroker: null, fetchFn });
  assert(calls.some(u => u.includes('TCS.NS')), 'yahoo endpoint called with .NS suffix');
  assert(r.TCS.ltp === 405.5 && r.TCS.prevClose === 400, 'mapped to base symbol');
  assert(Math.abs(r.TCS.changePct - 1.375) < 1e-9, 'changePct computed');
});

test('quotes omits symbols that fail everywhere', async () => {
  const fetchFn = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r = await quotes.getQuotes(['TCS'], { kiteBroker: null, fetchFn });
  assert(!r.TCS, 'failed symbol omitted');
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`.
- [ ] **Step 3: Implement** per Interfaces. Yahoo needs a User-Agent header (set a browser-ish UA string); treat non-OK as failure → fallback chain → omission.
- [ ] **Step 4: Run to verify PASS** — `npm test` green.
- [ ] **Step 5: Commit** — `git add src/ai/quotes.js tests/runTests.js && git commit -m "feat: quote provider with kite-first yfinance fallback"`

### Task 6: Market brief + Gemini advisor

**Files:**
- Create: `src/ai/marketBrief.js`, `src/ai/llmAdvisor.js`
- Test: `tests/runTests.js` (append)

**Interfaces:**
- Consumes: `getQuotes` (Task 5), `tradeRepository` history, config `ai.*`.
- Produces:
  - `buildBrief({ quotes, symbols, budget, spentToday, openLots, recentTrades })` → plain object `{ date, budget, spentToday, openLots, market: [{symbol, ltp, prevClose, changePct}], recentTrades: [{symbol, pnl, exitReason}], instructions: <string> }` where `instructions` tells the LLM: long-only, MIS≈{misLeverage}x leverage / CNC 1x, stop-loss mandatory, empty decisions is a valid answer, goal small profit / avoid loss.
  - `askAdvisor(brief, { apiKey, model, fetchFn })` → `decisions[]` (already shape-normalized: `action, symbol, product, entry, stopLoss, target, confidence, rationale` — parse whatever casing Gemini returns into these exact keys; numbers coerced). Behavior: one REST call with `responseMimeType: 'application/json'`; parse `candidates[0].content.parts[0].text` as JSON (`{decisions:[...]}` or bare array accepted); on quota/503/bad JSON, ONE retry, then return `[]` and log. Never throws.

- [ ] **Step 1: Write failing tests**

```js
test('buildBrief assembles budget, market rows, and instructions', () => {
  const brief = marketBrief.buildBrief({
    quotes: { TCS: { ltp: 405, prevClose: 400, changePct: 1.25 } },
    symbols: ['TCS'], budget: 1000, spentToday: 0,
    openLots: [], recentTrades: [{ symbol: 'INFY', pnl: -40, exitReason: 'Stop Loss' }],
  });
  assert(brief.budget === 1000 && brief.market.length === 1, 'budget + market rows');
  assert(/empty/.test(brief.instructions) && /stop-loss/i.test(brief.instructions), 'instructions present');
  assert(/MIS/.test(brief.instructions), 'leverage explained');
});

test('askAdvisor parses decisions and normalizes keys', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    decisions: [{ action: 'BUY', symbol: 'TCS', product: 'MIS', entry: 400, stopLoss: 390, target: 420, confidence: 0.8, rationale: 'gap up' }],
  }) }] } }] }) });
  const d = await llmAdvisor.askAdvisor({ date: 'x' }, { apiKey: 'k', model: 'm', fetchFn });
  assert(d.length === 1 && d[0].symbol === 'TCS' && d[0].stopLoss === 390, 'parsed and normalized');
});

test('askAdvisor returns empty on repeated failure, never throws', async () => {
  const fetchFn = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const d = await llmAdvisor.askAdvisor({ date: 'x' }, { apiKey: 'k', model: 'm', fetchFn });
  assert(Array.isArray(d) && d.length === 0, 'quota failure -> no decisions');
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`.
- [ ] **Step 3: Implement** both files per Interfaces. Prompt (in `marketBrief.instructions` + message): system line "You are a cautious Indian equity delivery trader. Long only. Prefer no trade over a bad trade."
- [ ] **Step 4: Run to verify PASS** — `npm test` green.
- [ ] **Step 5: Commit** — `git add src/ai/marketBrief.js src/ai/llmAdvisor.js tests/runTests.js && git commit -m "feat: market brief builder and gemini advisor"`

### Task 7: KiteBroker completion (TOTP login, quotes, normalized positions, order params)

**Files:**
- Modify: `src/brokers/kiteBroker.js`
- Test: `tests/runTests.js` (append) — with a stubbed `this.kite` object; no real API calls in tests.

**Interfaces:**
- Consumes: `kiteconnect` npm package (install: `npm install kiteconnect`), env `KITE_API_KEY/SECRET/TOTP_SECRET`.
- Produces (all on `KiteBroker`):
  - `async loginWithTOTP()` → `{success, accessToken}`. Flow: `kite.getLoginURL()` → GET login URL (redirects to `request_token=...&checksum=...`) → compute `sha256(apiKey + requestToken + apiSecret)`, POST to `https://kite.zerodha.com/api/login` then `api/session/token` with `TOTP` from `KITE_TOTP_SECRET` (use npm-optional `otplib`? **No** — TOTP is 30 lines of stdlib `crypto` (HMAC-SHA1, 6 digits, 30s step); implement inline in `src/ai/totp.js` with a known-vector test) → persist token to `data/.kite_token.json` (chmod 600). `connect()` first tries persisted token, else TOTP login, else returns `{success:false, requiresAuth:true, loginUrl}` (existing behavior).
  - `async getQuote(symbols)` → `{ [symbol]: { ltp, prevClose } }` via `kite.getQuote(['NSE:SYMBOL', ...])` (fields `last_price`, `ohlc.close`); on error throw (quotes.js handles fallback).
  - `getPositions()` fixed to the NormalizedPosition contract: map `positions.net`, filter quantity ≠ 0, shape `{symbol: tradingsymbol, side, quantity: Math.abs(qty), avgPrice: avg_price, currentPrice: ltp ?? avg_price, unrealizedPnL}`.
  - `placeOrder(order)` gains: `order.product` ('MIS'|'CNC', default MIS as today), `order.orderType` ('MARKET'|'LIMIT', default MARKET), `order.triggerPrice` for SL-M, `tag: 'ai-agent'` when `order.strategy === 'ai-agent'`.
  - `async placeStopLoss(symbol, {quantity, triggerPrice, product, side='SELL'})` → SL-M order via `placeOrder` variety regular.

- [ ] **Step 1: Write failing test** for TOTP (known vector: secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`, time `1111111109` → code `14050471` is RFC 6238 base32 of `12345678901234567890`... use the RFC test vector with base32-encoded ASCII secret) and for normalized positions:

```js
test('totp generates RFC 6238 test vector codes', () => {
  const code = totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111109);
  assert(code === '14050471', `RFC vector 8-digit, got ${code}`);
});

test('KiteBroker normalizes kite net positions', async () => {
  const kb = new KiteBroker({});
  kb.connected = true;
  kb.kite = { async getPositions() { return { net: [
    { tradingsymbol: 'TCS', quantity: 10, avg_price: 400, ltp: 405 },
    { tradingsymbol: 'INFY', quantity: 0, avg_price: 0, ltp: 0 },
  ] }; } };
  const list = await kb.getPositions();
  assert(list.length === 1, `flat rows omitted, got ${list.length}`);
  assert(list[0].symbol === 'TCS' && list[0].unrealizedPnL === 50, `normalized: ${JSON.stringify(list[0])}`);
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`.
- [ ] **Step 3: Implement** — `npm install kiteconnect`, then `src/ai/totp.js` (`totp(secretBase32, timeSec = Date.now()/1000)`), then the KiteBroker changes per Interfaces. Keep the SDK usage identical to what's already there (`this.kite.*`); the TOTP HTTP login uses `fetch` to the two kite endpoints.
- [ ] **Step 4: Run to verify PASS** — `npm test` green.
- [ ] **Step 5: Manual smoke** (no commit-blocker, note result in commit msg): with real creds in `.env`/shell, run `node -e` snippet calling `connect()` — confirms free-tier `getQuote` works; if 403, that's expected (quotes.js falls back) — record it in the journal note of Task 8's first run.
- [ ] **Step 6: Commit** — `git add src/brokers/kiteBroker.js src/ai/totp.js package.json package-lock.json tests/runTests.js && git commit -m "feat: kite totp login, quotes, normalized positions, sl-m"`

### Task 8: Decide runner (`--mode ai`)

**Files:**
- Create: `src/ai/aiRunner.js`
- Modify: `src/app.js` (commander: `--mode ai`, `--live`; init path for AI mode)
- Test: `tests/runTests.js` (append) — runner core tested with stub broker/quotes/LLM (no network).

**Interfaces:**
- Consumes: Tasks 1–7 (`validateDecisions`, `recordAiFill`, `getSpendToday`, `getOpenAiLots`, `getQuotes`, `buildBrief`, `askAdvisor`, `journal.append`, broker `placeOrder`/`placeStopLoss`).
- Produces:
  - `async runDecide({ broker, fetchFn, askFn })` → `{ placed: [], rejected: [], skipped: reason|null }`.
    Flow: kill-switch file check (`data/TRADING_HALTED` → skipped) → daily-loss check (realized today from `tradeRepository`/ledger: if `Σ(sell price - buy price)*qty` of today's ai_ledger sells ≤ `-(dailyBudget * dailyLossLimitPct)` → journal NOTE, skip) → `spentToday = repo.getSpendToday()` (idempotency: second run same day only spends what's left) → quotes → brief → `askFn` (default `askAdvisor`, `GEMINI_API_KEY` missing → skip with NOTE) → `validateDecisions` → journal each accepted + rejected → for each accepted: `broker.placeOrder({id, symbol, side:'BUY', quantity, entryPrice: entry, strategy: 'ai-agent', product, orderType: 'LIMIT'})`; on fill: `repo.recordAiFill(...)` AND `broker.placeStopLoss(symbol, {quantity: filled qty, triggerPrice: stopLoss, product})` — live: real SL-M; paper: no broker SL, stop enforced by `runEod` + a `checkStops` step below.
  - `async checkStops({ broker, fetchFn })` → for each open lot, if current ltp ≤ lot's stop (stop retrieved from journal/ledger — store `stopLoss` in ai_ledger row: add column `stop_loss REAL`), sell via broker at market, `recordAiFill` SELL with reason `'stop'`, journal EXIT.
  - Paper-mode stops: `ai:check` cron line every 15 min (documented in Task 10), same `checkStops`.
- `src/app.js`: `--mode ai` wires `runDecide` with PaperBroker (default) or KiteBroker when `--live` AND `KITE_LIVE=1` (guard: refuse otherwise with a clear message, exit 1). New scripts: `"ai:decide": "node src/app.js --mode ai"`, `"ai:live": "node src/app.js --mode ai --live"`, `"ai:eod": "node src/app.js --mode eod"`, `"ai:check": "node src/app.js --mode check"`.

- [ ] **Step 1: Write failing tests** (stub broker like the existing 'partial closing fill' test's stub):

```js
test('runDecide places gated buys, records fills, and attaches stops', async () => {
  config.set('ai.dailyBudget', 1000);
  const placed = [];
  const stub = { name: 'stub', async isConnected() { return true; },
    async placeOrder(o) { placed.push(o); return { success: true, fillPrice: o.entryPrice, quantity: o.quantity, orderId: 'k9', action: 'OPEN', realizedPnL: 0, closedQuantity: 0 }; },
    async placeStopLoss(sym, p) { placed.push({ slFor: sym, ...p }); return { success: true }; } };
  const r = await aiRunner.runDecide({
    broker: stub,
    fetchFn: async () => ({ ok: true, json: async () => ({ quoteResponse: { result: [
      { symbol: 'TCS.NS', regularMarketPrice: 400, regularMarketPreviousClose: 395 }] } }) }),
    askFn: async () => [{ action: 'BUY', symbol: 'TCS', product: 'MIS', entry: 400, stopLoss: 390, target: 420, confidence: 0.8, rationale: 'test' }],
  });
  assert(r.placed.length === 1 && placed.some(o => o.symbol === 'TCS' && o.strategy === 'ai-agent'), 'buy placed with tag');
  assert(placed.some(o => o.slFor === 'TCS' && o.triggerPrice === 390), 'stop attached after fill');
  assert(aiJournal.read(new Date().toLocaleDateString('sv')).includes('[DECISION]'), 'journaled');
});

test('runDecide skips when halted and spends only remaining budget on rerun', async () => {
  fs.writeFileSync('data/TRADING_HALTED', '');
  const r = await aiRunner.runDecide({ broker: { async isConnected() { return true; } }, askFn: async () => [] });
  fs.unlinkSync('data/TRADING_HALTED');
  assert(r.skipped && /halt/i.test(r.skipped), 'kill switch respected');

  const repo = new tradeRepository.constructor(':memory:'); // injected below via factory if needed
  // (implementer: expose runDecide({repo}) to inject the temp repo)
});
```

(Note: implement `runDecide` to accept optional `repo` and `journal` overrides for testability; second half of the test injects the `:memory:` repo, records a ₹900 BUY for today, then asserts the next run's only BUY computes qty from ₹100 remaining budget.)

- [ ] **Step 2: Run to verify FAIL** — `npm test`.
- [ ] **Step 3: Implement** `runDecide` + `checkStops` + `src/ai/totp.js`-independent wiring per Interfaces; extend `ai_ledger` with `stop_loss REAL` (Task 3 table — add column in `_createTables`, `IF NOT EXISTS` migration line for existing dbs).
- [ ] **Step 4: Run to verify PASS** — `npm test` green.
- [ ] **Step 5: Paper smoke run** — `npm run ai:decide` during market hours (or accept skip outside hours with a NOTE); verify journal file created.
- [ ] **Step 6: Commit** — `git add src/ai/aiRunner.js src/app.js package.json tests/runTests.js && git commit -m "feat: ai decide runner with kill switch, budget idempotency, stops"`

### Task 9: EOD runner (`--mode eod`)

**Files:**
- Modify: `src/ai/aiRunner.js` (add `runEod`), `src/app.js` (`--mode eod`)
- Test: `tests/runTests.js` (append)

**Interfaces:**
- Consumes: `tradeRepository.getOpenAiLots()`, broker `placeOrder` (SELL at MARKET), `journal`.
- Produces: `async runEod({ broker, fetchFn, now })` → `{ closed: [], failed: [] }`. Flow: for each open lot → SELL all qty at market, `strategy:'ai-agent'`, `recordAiFill` SELL with reason `'EOD'`, journal EXIT with realized P&L (`(sellPrice - avgPrice) * qty`). If `config.get('ai.eodExitEnabled') === false` → journal NOTE and close only `product === 'MIS'` lots (MIS must always close). Idempotent: flat ledger → zero work, exit 0. Any broker failure → `failed[]` + journal EXIT-FAILED + exit code 1 (user must see it).

- [ ] **Step 1: Write failing test**

```js
test('runEod squares off open ai lots and is idempotent', async () => {
  const sells = [];
  const stub = { name: 'stub', async isConnected() { return true; },
    async placeOrder(o) { sells.push(o); return { success: true, fillPrice: 410, quantity: o.quantity, orderId: 'e1', action: 'CLOSE', realizedPnL: 120, closedQuantity: o.quantity }; } };
  const repo = tempRepoWithBuy('TCS', 12, 400);
  const r = await aiRunner.runEod({ broker: stub, repo, journal: aiJournal });
  assert(sells.length === 1 && sells[0].side === 'SELL' && sells[0].quantity === 12, `sold 12 TCS, got ${JSON.stringify(sells)}`);
  assert(repo.getOpenAiLots().length === 0, 'ledger flat');
  const r2 = await aiRunner.runEod({ broker: stub, repo, journal: aiJournal });
  assert(r2.closed.length === 0, 'second run is a no-op');
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`.
- [ ] **Step 3: Implement** per Interfaces; wire `--mode eod` in app.js with the same broker-selection/guard logic as Task 8 (extract the shared broker-selection helper if it's now used twice — that's the only allowed reuse refactor).
- [ ] **Step 4: Run to verify PASS** — `npm test` green.
- [ ] **Step 5: Commit** — `git add src/ai/aiRunner.js src/app.js tests/runTests.js && git commit -m "feat: eod square-off runner, idempotent across restarts"`

### Task 10: Ops wiring + docs

**Files:**
- Create: `docs/ai-agent-ops.md`
- Modify: `README.md` (short section linking it)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one ops doc: env var table, Kite developer-app setup (redirect URL), first-run steps, cron lines:

```
20 9 * 1-5 /usr/bin/env npm --prefix /path/to/repo run ai:decide
*/15 9-15 * 1-5 /usr/bin/env npm --prefix /path/to/repo run ai:check
15 15 * 1-5 /usr/bin/env npm --prefix /path/to/repo run ai:eod
```
(weekdays only; `ai:live` swaps for `ai:decide` once approved), paper-first protocol (3–5 paper days, journal audit checklist), kill-switch instructions, and the honest caveats (gap-through stops, free-tier quote uncertainty, LLM can be wrong — the rails are what protect the capital).

- [ ] **Step 1: Write** `docs/ai-agent-ops.md` per above.
- [ ] **Step 2: Verify** every command in the doc actually exists (`grep 'ai:' package.json`) and every env var matches the code (`grep -r 'KITE_\|GEMINI_' src/`).
- [ ] **Step 3: Commit** — `git add docs/ai-agent-ops.md README.md && git commit -m "docs: ai agent ops runbook"`
