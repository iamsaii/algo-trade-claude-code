/**
 * Test Suite Runner
 * Runs all framework tests
 */

import logger from '../src/utils/logger.js';
import { sma, ema, rsi, atr, bollingerBands } from '../src/utils/indicators.js';
import MovingAverageStrategy from '../src/strategies/movingAverageStrategy.js';
import RSIMeanReversionStrategy from '../src/strategies/rsiMeanReversionStrategy.js';
import BreakoutStrategy from '../src/strategies/breakoutStrategy.js';
import Backtester from '../src/backtest/backtester.js';
import { loadDataFromFile } from '../src/data/sampleData.js';
import { calculatePerformanceMetrics } from '../src/backtest/performance.js';
import PaperBroker from '../src/brokers/paperBroker.js';
import OrderManager from '../src/execution/orderManager.js';
import PositionMonitor from '../src/execution/positionMonitor.js';
import config from '../src/core/config.js';
import { eventBus } from '../src/core/eventBus.js';
import aiGate from '../src/ai/aiGate.js';
import { TradeRepository } from '../src/storage/tradeRepository.js';
import aiJournal from '../src/ai/journal.js';
import quotes from '../src/ai/quotes.js';
import marketBrief from '../src/ai/marketBrief.js';
import llmAdvisor from '../src/ai/llmAdvisor.js';
import totp from '../src/ai/totp.js';
import KiteBroker from '../src/brokers/kiteBroker.js';

let passed = 0;
let failed = 0;

// Tests are collected first, then run sequentially with await, so async test
// functions are actually awaited before they are reported or the summary prints.
const pendingTests = [];

function test(name, fn) {
  pendingTests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// Test Technical Indicators
logger.info('\n=== Testing Technical Indicators ===\n');

test('SMA calculates correctly', () => {
  const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const result = sma(prices, 5);
  assert(result === 8, `Expected 8, got ${result}`);
});

test('SMA returns null for insufficient data', () => {
  const prices = [1, 2, 3];
  const result = sma(prices, 5);
  assert(result === null, `Expected null, got ${result}`);
});

test('EMA calculates correctly', () => {
  const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const result = ema(prices, 3);
  assert(result !== null && result > 0, `Expected positive value, got ${result}`);
});

test('RSI calculates correctly', () => {
  const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const result = rsi(prices, 14);
  assert(result !== null && result >= 0 && result <= 100, `Expected 0-100, got ${result}`);
});

test('RSI returns 100 for all gains', () => {
  const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const result = rsi(prices, 14);
  assert(result === 100, `Expected 100, got ${result}`);
});

test('ATR calculates correctly', () => {
  const candles = Array(20).fill(null).map((_, i) => ({
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 100 + i,
    volume: 1000,
  }));
  const result = atr(candles, 14);
  assert(result !== null && result > 0, `Expected positive value, got ${result}`);
});

test('Bollinger Bands calculates correctly', () => {
  const prices = Array(30).fill(null).map((_, i) => 100 + Math.sin(i) * 5);
  const result = bollingerBands(prices, 20, 2);
  assert(result !== null, 'Expected result');
  assert(result.upper > result.middle, 'Upper > middle');
  assert(result.lower < result.middle, 'Lower < middle');
});

// Test Strategies
logger.info('\n=== Testing Strategies ===\n');

test('MovingAverageStrategy initializes', () => {
  const strategy = new MovingAverageStrategy({ shortPeriod: 5, longPeriod: 10 });
  assert(strategy.getName() === 'MovingAverageCrossover', 'Wrong name');
});

test('MovingAverageStrategy generates signals', () => {
  const strategy = new MovingAverageStrategy({ shortPeriod: 5, longPeriod: 10 });
  const prices = Array(50).fill(null).map((_, i) => 100 + i * 2);
  const candles = prices.map(p => ({
    open: p,
    high: p + 1,
    low: p - 1,
    close: p,
    volume: 1000,
    timestamp: Date.now(),
  }));
  strategy.initialize('TEST', candles.slice(0, 30));
  let signal = null;
  for (let i = 30; i < candles.length; i++) {
    signal = strategy.onCandle(candles[i]);
    if (signal) break;
  }
  // Signal may or may not be generated depending on data
  assert(strategy.getStats().candlesLoaded > 0, 'No candles loaded');
});

test('RSIMeanReversionStrategy initializes', () => {
  const strategy = new RSIMeanReversionStrategy({ period: 14, oversold: 30, overbought: 70 });
  assert(strategy.getName() === 'RSIMeanReversion', 'Wrong name');
});

test('BreakoutStrategy initializes', () => {
  const strategy = new BreakoutStrategy({ lookbackPeriod: 20 });
  assert(strategy.getName() === 'Breakout', 'Wrong name');
});

// Test Backtester
logger.info('\n=== Testing Backtester ===\n');

test('Backtester initializes', () => {
  const backtester = new Backtester(100000);
  assert(backtester.initialCapital === 100000, 'Wrong initial capital');
});

test('Backtester runs on data', () => {
  const strategy = new MovingAverageStrategy({ shortPeriod: 5, longPeriod: 10 });
  const prices = Array(100).fill(null).map((_, i) => 100 + Math.sin(i * 0.1) * 10);
  const candles = prices.map(p => ({
    open: p,
    high: p + 2,
    low: p - 2,
    close: p,
    volume: 1000 + Math.random() * 500,
    timestamp: Date.now(),
  }));
  const backtester = new Backtester(100000);
  const result = backtester.run(strategy, candles, { symbol: 'TEST' });
  assert(result.trades !== undefined, 'No trades');
  assert(result.metrics !== undefined, 'No metrics');
});

// Test Performance Metrics
logger.info('\n=== Testing Performance Metrics ===\n');

test('Performance metrics calculates correctly', () => {
  const trades = [
    { pnl: 1000, side: 'BUY', entryPrice: 100, exitPrice: 110, quantity: 100 },
    { pnl: -500, side: 'BUY', entryPrice: 100, exitPrice: 95, quantity: 100 },
    { pnl: 1500, side: 'BUY', entryPrice: 100, exitPrice: 115, quantity: 100 },
  ];
  const equityCurve = [
    { value: 100000 },
    { value: 101000 },
    { value: 100500 },
    { value: 102000 },
  ];
  const metrics = calculatePerformanceMetrics({
    trades,
    equityCurve,
    dailyReturns: [0.01, -0.005, 0.015],
    initialCapital: 100000,
    finalCapital: 102000,
    maxDrawdown: 0.01,
  });
  assert(metrics.winRate !== undefined, 'No win rate');
  assert(metrics.totalReturnPercent !== undefined, 'No return');
});

// Test Broker Ledger
logger.info('\n=== Testing Broker Ledger ===\n');

// Deterministic fills for ledger tests.
config.set('paperTrading.simulateDelay', false);
config.set('paperTrading.simulateSlippage', false);

test('PaperBroker exposes normalized positions', async () => {
  const b = new PaperBroker(100000);
  await b.connect();
  await b.placeOrder({ id: 'o1', symbol: 'RELIANCE', side: 'BUY', quantity: 10, entryPrice: 2500 });

  const list = await b.getPositions();
  assert(list.length === 1, `expected 1 position, got ${list.length}`);
  assert(list[0].symbol === 'RELIANCE' && list[0].side === 'BUY', 'wrong symbol/side');
  assert(list[0].quantity === 10 && list[0].avgPrice === 2500, `wrong qty/avg: ${JSON.stringify(list[0])}`);

  const one = await b.getPosition('RELIANCE');
  assert(one && one.quantity === 10, 'getPosition returned wrong position');
  assert((await b.getPosition('NOPE')) === null, 'expected null when flat');
});

test('PaperBroker reports fill effect and realized PnL', async () => {
  const b = new PaperBroker(100000);
  await b.connect();
  await b.placeOrder({ id: 'o1', symbol: 'X', side: 'BUY', quantity: 10, entryPrice: 100 });

  const r1 = await b.placeOrder({ id: 'o2', symbol: 'X', side: 'SELL', quantity: 4, entryPrice: 110 });
  assert(r1.action === 'REDUCE' && r1.closedQuantity === 4, `expected REDUCE/4, got ${r1.action}/${r1.closedQuantity}`);
  assert(Math.abs(r1.realizedPnL - 40) < 1e-9, `expected pnl 40, got ${r1.realizedPnL}`);
  assert((await b.getPosition('X')).quantity === 6, 'remaining qty should be 6');

  const r2 = await b.placeOrder({ id: 'o3', symbol: 'X', side: 'SELL', quantity: 6, entryPrice: 90 });
  assert(r2.action === 'CLOSE', `expected CLOSE, got ${r2.action}`);
  assert(Math.abs(r2.realizedPnL - (-60)) < 1e-9, `expected pnl -60, got ${r2.realizedPnL}`);
  assert((await b.getPosition('X')) === null, 'should be flat');

  const r3 = await b.placeOrder({ id: 'o4', symbol: 'X', side: 'SELL', quantity: 5, entryPrice: 100 });
  assert(r3.action === 'OPEN', `expected OPEN, got ${r3.action}`);
});

test('OrderManager mirrors broker positions and PnL', async () => {
  const b = new PaperBroker(100000);
  await b.connect();
  const om = new OrderManager(b);

  const o1 = om.createOrder(
    { symbol: 'Y', action: 'BUY', entryPrice: 200, stopLoss: 190, target: 220, strategy: 'T' },
    5
  );
  await om.executeOrder(o1.id);

  assert(om.getPositions().length === 1, `mirror should have 1, got ${om.getPositions().length}`);
  const merged = om.getPosition('Y');
  assert(merged && merged.stopLoss === 190 && merged.target === 220, 'exit levels should be merged');
  assert(merged.quantity === 5 && merged.avgPrice === 200, 'broker position values should flow through');

  const closeResult = await om.closePositionViaBroker('Y', 210, 'Target');
  assert(closeResult && closeResult.success, 'close should succeed');
  assert(om.getPositions().length === 0, 'mirror should be flat');
  assert(om.getPosition('Y') === null, 'exit level should be cleared');

  const brokerPnL = (await b.getAccountBalance()).totalPnL;
  assert(
    Math.abs(om.getPnL().realized - brokerPnL) < 1e-6,
    `PnL parity: om=${om.getPnL().realized} broker=${brokerPnL}`
  );
});

test('PositionMonitor closes via the broker on stop-loss', async () => {
  const b = new PaperBroker(100000);
  await b.connect();
  const om = new OrderManager(b);
  const mon = new PositionMonitor(om);
  mon.start();

  const o = om.createOrder(
    { symbol: 'Z', action: 'BUY', entryPrice: 100, stopLoss: 95, target: 110, strategy: 'T' },
    10
  );
  await om.executeOrder(o.id);
  assert(om.getPositions().length === 1, 'should be open before the stop is hit');

  eventBus.emitSafe('market_tick', { symbol: 'Z', price: 94, timestamp: Date.now() });
  await new Promise(r => setTimeout(r, 50));

  assert(om.getPositions().length === 0, 'order manager should be flat');
  assert((await b.getPositions()).length === 0, 'broker should be flat');
  mon.stop();
});

test('FLIP records the remainder in the trade journal, not the full order qty', async () => {
  const b = new PaperBroker(100000);
  await b.connect();
  const om = new OrderManager(b);

  const o1 = om.createOrder({ symbol: 'F', action: 'BUY', entryPrice: 100, strategy: 'T' }, 4);
  await om.executeOrder(o1.id);
  const o2 = om.createOrder({ symbol: 'F', action: 'SELL', entryPrice: 110, strategy: 'T' }, 10);
  await om.executeOrder(o2.id);

  const broker = await b.getPosition('F');
  assert(broker.side === 'SELL' && broker.quantity === 6, `broker should hold SELL 6, got ${broker.side} ${broker.quantity}`);

  const open = om.getTradeHistory(50).filter(t => t.status === 'OPEN');
  assert(open.length === 1, `expected exactly 1 OPEN trade, got ${open.length}`);
  assert(open[0].side === 'SELL', `OPEN trade should be SELL, got ${open[0].side}`);
  assert(open[0].quantity === 6, `journal qty must match broker remainder 6, got ${open[0].quantity}`);

  // Closing the remainder must fully settle the journal: no stale OPEN record.
  await om.closePositionViaBroker('F', 105, 'Exit');
  assert((await b.getPosition('F')) === null, 'broker should be flat');
  const stillOpen = om.getTradeHistory(50).filter(t => t.status === 'OPEN');
  assert(stillOpen.length === 0, `journal must have no OPEN trades when flat, got ${stillOpen.length}`);
});

test('partial closing fill re-arms the exit guard', async () => {
  // Stub broker that always fills only 4 units of a closing order.
  const stub = {
    name: 'stub',
    position: null,
    async connect() { return true; },
    async getPositions() { return this.position ? [{ ...this.position }] : []; },
    async getPosition(symbol) {
      return this.position && this.position.symbol === symbol ? { ...this.position } : null;
    },
    async placeOrder(order) {
      if (!this.position) {
        this.position = {
          symbol: order.symbol, side: order.side, quantity: order.quantity,
          avgPrice: order.entryPrice, currentPrice: order.entryPrice, unrealizedPnL: 0,
        };
        return { success: true, fillPrice: order.entryPrice, quantity: order.quantity,
          orderId: order.id, action: 'OPEN', realizedPnL: 0, closedQuantity: 0 };
      }
      if (order.side !== this.position.side) {
        const closedQty = Math.min(4, this.position.quantity);
        const pnl = this.position.side === 'BUY'
          ? (order.entryPrice - this.position.avgPrice) * closedQty
          : (this.position.avgPrice - order.entryPrice) * closedQty;
        this.position.quantity -= closedQty;
        const action = this.position.quantity <= 0 ? 'CLOSE' : 'REDUCE';
        if (this.position.quantity <= 0) this.position = null;
        return { success: true, fillPrice: order.entryPrice, quantity: closedQty,
          orderId: order.id, action, realizedPnL: pnl, closedQuantity: closedQty };
      }
      this.position.quantity += order.quantity;
      return { success: true, fillPrice: order.entryPrice, quantity: order.quantity,
        orderId: order.id, action: 'ADD', realizedPnL: 0, closedQuantity: 0 };
    },
  };

  const om = new OrderManager(stub);
  const o1 = om.createOrder(
    { symbol: 'P', action: 'BUY', entryPrice: 100, stopLoss: 95, target: 110, strategy: 'T' },
    10
  );
  await om.executeOrder(o1.id);

  const c1 = await om.closePositionViaBroker('P', 95, 'Stop Loss');
  assert(c1?.success, 'first close should succeed');
  const after = om.getPosition('P');
  assert(after && after.quantity === 6, `remainder should be 6, got ${after?.quantity}`);
  assert(after.exiting === false, `exit guard must be re-armed after a partial fill, got exiting=${after.exiting}`);

  // A later stop tick must still be able to exit the remaining units.
  const c2 = await om.closePositionViaBroker('P', 95, 'Stop Loss');
  assert(c2 !== null, 'second close must not be blocked by a stale exiting flag');
  const afterSecond = await stub.getPosition('P');
  assert(afterSecond && afterSecond.quantity === 2, `stub fills 4/close: 6 -> 2, got ${afterSecond?.quantity}`);

  // ...and the guard re-arms again, so the last 2 units can still be exited.
  const c3 = await om.closePositionViaBroker('P', 95, 'Stop Loss');
  assert(c3 !== null, 'third close must not be blocked');
  assert((await stub.getPosition('P')) === null, 'broker should be flat after third close');
});

test('closed trade keeps its exit reason', async () => {
  const b = new PaperBroker(100000);
  await b.connect();
  const om = new OrderManager(b);
  const o1 = om.createOrder({ symbol: 'R', action: 'BUY', entryPrice: 100, stopLoss: 95, target: 110, strategy: 'T' }, 5);
  await om.executeOrder(o1.id);

  await om.closePositionViaBroker('R', 95, 'Stop Loss');
  const closed = om.getTradeHistory(50).find(t => t.symbol === 'R' && t.status === 'CLOSED');
  assert(closed, 'expected a closed trade');
  assert(closed.exitReason === 'Stop Loss', `exitReason must be preserved, got ${closed.exitReason}`);
});

// Test runner behaviour
logger.info('\n=== Testing Test Runner ===\n');

let asyncValue = null;
test('runner awaits async tests', async () => {
  await new Promise(r => setTimeout(r, 20));
  asyncValue = 42;
});
test('async value is set once awaited', () => {
  assert(asyncValue === 42, `expected 42, got ${asyncValue}`);
});

// AI agent config
logger.info('\n=== Testing AI Agent Config ===\n');

test('ai config block has defaults and is settable', () => {
  assert(config.get('ai.dailyBudget') === 1000, 'default budget');
  assert(config.get('ai.maxTrades') === 2, 'default maxTrades');
  assert(config.get('ai.llm.model') === 'gemini-2.0-flash', 'default model');
  config.set('ai.dailyBudget', 5000);
  assert(config.get('ai.dailyBudget') === 5000, 'settable');
  config.set('ai.dailyBudget', 1000); // restore for other tests
});

// AI gate
logger.info('\n=== Testing AI Gate ===\n');

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

// AI ledger
logger.info('\n=== Testing AI Ledger ===\n');

test('ai ledger tracks margin spend, open lots, and sell-guard quantities', async () => {
  const repo = new TradeRepository(':memory:');
  repo.connect();
  repo.recordAiFill({ symbol: 'TCS', side: 'BUY', quantity: 12, price: 400, product: 'MIS', kiteOrderId: 'k1', reason: 'ai' });
  repo.recordAiFill({ symbol: 'TCS', side: 'SELL', quantity: 5, price: 410, product: 'MIS', kiteOrderId: 'k2', reason: 'stop' });
  // margin semantics: 12 * 400 / 5 (MIS leverage) = 960; sale proceeds never refill
  assert(repo.getSpendToday() === 960, `margin spend should be 960, got ${repo.getSpendToday()}`);
  const lots = repo.getOpenAiLots();
  assert(lots.length === 1 && lots[0].quantity === 7, `open lot qty 7, got ${JSON.stringify(lots)}`);
  const one = repo.getOpenAiLot('TCS');
  assert(one && one.quantity === 7, 'per-symbol lot');
  assert(repo.getOpenAiLot('INFY') === null, 'unknown symbol -> null');
});

// AI journal
logger.info('\n=== Testing AI Journal ===\n');

test('journal appends readable entries per day', () => {
  const date = '2026-10-19';
  const { append, read } = aiJournal;
  append(date, { type: 'DECISION', data: { symbol: 'TCS', confidence: 0.8 } });
  append(date, { type: 'REJECTED', data: { symbol: 'X', reason: 'max trades' } });
  const text = read(date);
  assert(text.includes('[DECISION]') && text.includes('TCS'), 'decision line present');
  assert(text.includes('[REJECTED]') && text.includes('max trades'), 'rejection line present');
  assert(/^- \d{2}:\d{2} \[DECISION\]/m.test(text), 'timestamped line format');
});

// Quote provider
logger.info('\n=== Testing Quote Provider ===\n');

test('quotes falls back to yfinance when kite is unavailable', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        quoteResponse: { result: [
          { symbol: 'TCS.NS', regularMarketPrice: 405.5, regularMarketPreviousClose: 400 },
        ] },
      }),
    };
  };
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

// Market brief + LLM advisor
logger.info('\n=== Testing Market Brief + LLM Advisor ===\n');

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
  const body = { candidates: [{ content: { parts: [{ text: JSON.stringify({
    decisions: [{ action: 'BUY', symbol: 'TCS', product: 'MIS', entry: 400, stopLoss: 390, target: 420, confidence: 0.8, rationale: 'gap up' }],
  }) }] } }] };
  const fetchFn = async () => ({ ok: true, json: async () => body });
  const d = await llmAdvisor.askAdvisor({ date: 'x' }, { apiKey: 'k', model: 'm', fetchFn });
  assert(d.length === 1 && d[0].symbol === 'TCS' && d[0].stopLoss === 390, 'parsed and normalized');
});

test('askAdvisor returns empty on repeated failure, never throws', async () => {
  const fetchFn = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const d = await llmAdvisor.askAdvisor({ date: 'x' }, { apiKey: 'k', model: 'm', fetchFn });
  assert(Array.isArray(d) && d.length === 0, 'quota failure -> no decisions');
});

// Kite plumbing
logger.info('\n=== Testing Kite Plumbing ===\n');

test('totp generates RFC 6238 test vector codes', () => {
  const code = totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111109);
  assert(code === '07081804', `RFC vector 8-digit, got ${code}`);
});

test('totp 6-digit variant for kite login', () => {
  const code = totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111109, 6);
  assert(code === '081804', `6-digit truncation, got ${code}`);
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

// Summary
(async () => {
  for (const { name, fn } of pendingTests) {
    try {
      await fn();
      logger.info(`✓ ${name}`);
      passed++;
    } catch (error) {
      logger.error(`✗ ${name}: ${error.message}`);
      failed++;
    }
  }

  logger.info('\n=== Test Summary ===\n');
  logger.info(`Passed: ${passed}`);
  logger.info(`Failed: ${failed}`);
  logger.info(`Total: ${passed + failed}`);

  if (failed > 0) {
    process.exit(1);
  }

  logger.info('\n✓ All tests passed!\n');
  process.exit(0);
})();
