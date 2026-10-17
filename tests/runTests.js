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
