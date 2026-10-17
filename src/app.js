/**
 * Algo-Trading Framework - Main Application
 *
 * A modular, event-driven trading system supporting:
 * - Backtesting on historical data
 * - Paper trading with simulated fills
 * - Live trading (via broker adapters)
 *
 * Usage:
 *   node src/app.js --mode paper     # Run paper trading
 *   node src/app.js --mode backtest  # Run backtest
 *   node src/app.js --mode live      # Run live trading (requires broker setup)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import logger from './utils/logger.js';
import config from './core/config.js';
import { eventBus } from './core/eventBus.js';
import { marketStream } from './data/marketStream.js';
import { candleBuilder } from './data/candleBuilder.js';
import { loadDataFromFile } from './data/sampleData.js';
import MovingAverageStrategy from './strategies/movingAverageStrategy.js';
import RSIMeanReversionStrategy from './strategies/rsiMeanReversionStrategy.js';
import BreakoutStrategy from './strategies/breakoutStrategy.js';
import MACDTrendStrategy from './strategies/macdTrendStrategy.js';
import VWAPMeanReversionStrategy from './strategies/vwapMeanReversionStrategy.js';
import riskManager from './risk/riskManager.js';
import OrderManager from './execution/orderManager.js';
import PositionMonitor from './execution/positionMonitor.js';
import PaperBroker from './brokers/paperBroker.js';
import KiteBroker from './brokers/kiteBroker.js';
import tradeRepository from './storage/tradeRepository.js';
import Backtester from './backtest/backtester.js';
import { generatePerformanceReport } from './backtest/performance.js';

// Application state
const app = {
  mode: 'paper',
  running: false,
  strategies: [],
  broker: null,
  orderManager: null,
  positionMonitor: null,
  symbols: [],
  historicalData: new Map(),
};

/**
 * Initialize the application
 */
async function initialize(mode, options = {}) {
  app.mode = mode;
  app.symbols = config.get('market.symbols');

  logger.info('='.repeat(50));
  logger.info('Algo-Trading Framework Starting');
  logger.info(`Mode: ${chalk.bold(mode.toUpperCase())}${options.dryRun ? chalk.yellow(' (dry-run)') : ''}`);
  logger.info('='.repeat(50));

  // Initialize database
  if (mode !== 'backtest') {
    tradeRepository.connect();
  }

  // Initialize broker based on mode
  await initializeBroker(mode, options);

  // Initialize strategies
  initializeStrategies();

  // Setup event handlers
  setupEventHandlers();

  logger.info('Initialization complete');
  return true;
}

/**
 * Initialize broker based on mode
 *
 * In live mode this connects to the real broker and aborts before any order
 * can be sent if authentication fails. `dryRun` forces the paper broker so the
 * full pipeline can be exercised without touching real money.
 */
async function initializeBroker(mode, { dryRun = false } = {}) {
  const initialCapital = config.get('trading.initialCapital');
  const effectiveMode = dryRun ? 'paper' : mode;

  switch (effectiveMode) {
    case 'paper':
      app.broker = new PaperBroker(initialCapital);
      await app.broker.connect();
      break;

    case 'live': {
      // Fail fast before constructing a live broker connection.
      if (!process.env.KITE_API_KEY || !process.env.KITE_ACCESS_TOKEN) {
        logger.error('Live mode requires KITE_API_KEY and KITE_ACCESS_TOKEN. Aborting.');
        process.exit(1);
      }

      app.broker = new KiteBroker({
        apiKey: process.env.KITE_API_KEY,
        apiSecret: process.env.KITE_API_SECRET,
        accessToken: process.env.KITE_ACCESS_TOKEN,
      });
      const result = await app.broker.connect();
      if (!result.success) {
        if (result.requiresAuth) {
          logger.error('Kite requires authentication. Open this URL to get an access token:', {
            loginUrl: result.loginUrl,
          });
        } else {
          logger.error('Failed to connect to live broker', { reason: result.reason });
        }
        process.exit(1);
      }
      break;
    }

    case 'backtest':
      // No broker needed for backtesting
      break;

    default:
      logger.error(`Unknown mode: ${effectiveMode}`);
      process.exit(1);
  }

  // Initialize order manager with broker
  if (app.broker) {
    app.orderManager = new OrderManager(app.broker);
    // P1-4: monitor open positions for stop-loss / target hits.
    app.positionMonitor = new PositionMonitor(app.orderManager);
  }

  logger.info(`Broker initialized: ${app.broker?.name || 'N/A'}`);
}

/**
 * Initialize trading strategies
 */
function initializeStrategies() {
  const strategyConfigs = config.get('strategies');

  // Moving Average Crossover
  if (strategyConfigs.movingAverage.enabled) {
    app.strategies.push(
      new MovingAverageStrategy({
        shortPeriod: strategyConfigs.movingAverage.shortPeriod,
        longPeriod: strategyConfigs.movingAverage.longPeriod,
      })
    );
  }

  // RSI Mean Reversion
  if (strategyConfigs.rsiMeanReversion.enabled) {
    app.strategies.push(
      new RSIMeanReversionStrategy({
        rsiPeriod: strategyConfigs.rsiMeanReversion.period,
        oversoldLevel: strategyConfigs.rsiMeanReversion.oversold,
        overboughtLevel: strategyConfigs.rsiMeanReversion.overbought,
      })
    );
  }

  // Breakout Strategy
  if (strategyConfigs.breakout.enabled) {
    app.strategies.push(
      new BreakoutStrategy({
        lookbackPeriod: strategyConfigs.breakout.lookbackPeriod,
      })
    );
  }

  // MACD Trend Strategy (NEW - default enabled)
  if (strategyConfigs.macdTrend.enabled) {
    app.strategies.push(
      new MACDTrendStrategy({
        fastPeriod: strategyConfigs.macdTrend.fastPeriod,
        slowPeriod: strategyConfigs.macdTrend.slowPeriod,
        signalPeriod: strategyConfigs.macdTrend.signalPeriod,
        adxThreshold: strategyConfigs.macdTrend.adxThreshold,
      })
    );
  }

  // VWAP Mean Reversion Strategy (NEW - default enabled)
  if (strategyConfigs.vwapMeanReversion.enabled) {
    app.strategies.push(
      new VWAPMeanReversionStrategy({
        bbPeriod: strategyConfigs.vwapMeanReversion.bbPeriod,
        stdDev: strategyConfigs.vwapMeanReversion.stdDev,
        rsiPeriod: strategyConfigs.vwapMeanReversion.rsiPeriod,
      })
    );
  }

  logger.info(`Loaded ${app.strategies.length} strategies`);
  app.strategies.forEach(s => logger.debug(`- ${s.getName()}`));
}

/**
 * Setup event handlers
 */
function setupEventHandlers() {
  // Handle trade signals from strategies
  eventBus.on('trade_signal', async (signal) => {
    await handleTradeSignal(signal);
  });

  // Handle order fills (newly opened positions) -> persist the trade row
  eventBus.on('order_filled', (trade) => {
    if (app.mode !== 'backtest' && tradeRepository.initialized) {
      tradeRepository.saveTrade(trade);
    }
  });

  // Handle closes -> persist the exit so trades don't stay OPEN forever
  eventBus.on('position_closed', (result) => {
    if (app.mode !== 'backtest' && tradeRepository.initialized && result?.tradeId) {
      tradeRepository.updateTradeExit(result.tradeId, result.exitPrice, result.pnl);
    }
  });

  // Handle errors
  eventBus.on('error', (error) => {
    logger.error('Event bus error', error);
  });
}

/**
 * Handle a trade signal
 */
async function handleTradeSignal(signal) {
  logger.info('Received trade signal', {
    symbol: signal.symbol,
    action: signal.action,
    strategy: signal.strategy,
  });

  // Get current positions
  const positions = app.orderManager?.getPositions() || [];

  // Run risk checks
  const riskCheck = riskManager.checkSignal(signal, positions);

  // Save signal to database
  if (app.mode !== 'backtest') {
    tradeRepository.saveSignal(signal, riskCheck.passed, riskCheck.reason);
  }

  if (!riskCheck.passed) {
    logger.debug('Signal rejected by risk manager', { reason: riskCheck.reason });
    eventBus.emitSafe('risk_rejected', { signal, reason: riskCheck.reason });
    return;
  }

  // Create and execute order
  if (app.orderManager) {
    const order = app.orderManager.createOrder(signal, riskCheck.positionSize);
    if (order) {
      await app.orderManager.executeOrder(order.id);
    }
  }
}

/**
 * Run paper trading mode
 */
async function runPaperTrading() {
  logger.info('Starting Paper Trading...');

  // Initialize market data
  const startingPrices = {
    'RELIANCE': 2500,
    'INFY': 1500,
    'HDFCBANK': 1600,
    'TCS': 3800,
    'ICICIBANK': 1000,
  };

  marketStream.initialize(startingPrices);
  candleBuilder.initialize(startingPrices);

  // Initialize strategies with each symbol
  app.symbols.forEach(symbol => {
    app.strategies.forEach(strategy => {
      strategy.initialize(symbol, []);
    });
  });

  // P1-6: bridge simulator ticks onto the central event bus, so the order
  // manager's unrealized PnL and the broker's price marks actually update.
  marketStream.on('tick', (tick) => {
    eventBus.emitSafe('market_tick', tick);
    if (typeof app.broker?.updatePrices === 'function') {
      app.broker.updatePrices({ [tick.symbol]: tick.price });
    }
  });

  // P1-4: start the exit lifecycle (stop-loss / target enforcement).
  if (app.positionMonitor) {
    app.positionMonitor.start();
  }

  // Start market data
  marketStream.start();
  candleBuilder.start();

  // Subscribe strategies to candle events
  candleBuilder.on('candle', (candle) => {
    app.strategies.forEach(strategy => {
      const signal = strategy.onCandle(candle);
      if (signal) {
        signal.strategy = strategy.getName();
        signal.symbol = candle.symbol;
        eventBus.emitSafe('trade_signal', signal);
      }
    });
  });

  // Print status periodically
  const statusInterval = setInterval(() => {
    printStatus();
  }, 30000); // Every 30 seconds

  app.running = true;

  // Handle shutdown
  process.on('SIGINT', () => shutdown(statusInterval));
  process.on('SIGTERM', () => shutdown(statusInterval));

  logger.info('Paper trading started. Press Ctrl+C to stop.');
}

/**
 * Run backtest mode
 */
async function runBacktest(options = {}) {
  const { symbol = 'RELIANCE', strategy: strategyName = 'all' } = options;

  logger.info('Starting Backtest...');

  // Load historical data
  const historicalData = loadDataFromFile(
    new URL('../data/historical/symbols/' + symbol + '.json', import.meta.url).pathname
  );

  if (!historicalData || historicalData.length === 0) {
    logger.error(`No historical data found for ${symbol}`);
    return;
  }

  logger.info(`Loaded ${historicalData.length} candles for ${symbol}`);

  // Select strategies
  let strategiesToTest = app.strategies;
  if (strategyName !== 'all') {
    strategiesToTest = app.strategies.filter(s =>
      s.getName().toLowerCase().includes(strategyName.toLowerCase())
    );
  }

  // Run backtests
  const results = [];
  for (const strategy of strategiesToTest) {
    logger.info(`\n${'='.repeat(40)}`);
    logger.info(`Backtesting: ${chalk.bold(strategy.getName())}`);
    logger.info('='.repeat(40));

    // Clone strategy to avoid state pollution
    const strategyClone = new (strategy.constructor)(strategy.config);

    const backtester = new Backtester(config.get('backtest.initialCapital'));
    const result = backtester.run(strategyClone, historicalData, {
      symbol,
      commission: 0.0003,
      slippage: 0.001,
    });

    results.push(result);

    // Print performance report
    const report = generatePerformanceReport(result.metrics, result.trades.slice(0, 10));
    printReport(report);
  }

  // Compare strategies
  if (results.length > 1) {
    logger.info(`\n${chalk.bold('Strategy Comparison')}`);
    logger.info('-'.repeat(40));
    results.forEach((r, i) => {
      logger.info(`${i + 1}. ${r.summary.strategy}: ${chalk.green(r.summary.totalReturnPercent)}% return`);
    });
  }

  return results;
}

/**
 * Run live trading mode
 */
async function runLiveTrading() {
  logger.warn('LIVE TRADING MODE - Real money at risk!');

  // Confirm before starting
  const confirm = process.env.CONFIRM_LIVE_TRADING;
  if (!confirm) {
    logger.error('Set CONFIRM_LIVE_TRADING=1 to enable live trading');
    process.exit(1);
  }

  // P0-1: never drive a real broker off the simulated feed. `runPaperTrading`
  // used to be called here, which would have sent genuine Kite orders priced
  // from random-walk numbers. Refuse unless a real feed is configured.
  if (!config.get('market.liveFeed.enabled')) {
    logger.error(
      'Refusing to start live trading: no real market-data feed is configured ' +
      '(market.liveFeed.enabled is false), so the built-in simulator would be ' +
      'pricing real orders.'
    );
    logger.error(
      'Either implement market/liveFeed.js and set market.liveFeed.enabled=true, ' +
      'or use --dry-run to exercise the full pipeline against the paper broker.'
    );
    process.exit(1);
  }

  // TODO(live-feed): once market.liveFeed.enabled is true, stream real ticks
  // onto eventBus as 'market_tick' and run the same order/exit pipeline.
  logger.error('Live market-data feed is not implemented yet.');
  process.exit(1);
}

/**
 * Print current status
 */
function printStatus() {
  const portfolio = app.broker?.getPortfolio?.();
  const stats = app.orderManager?.getStats();
  const positions = app.orderManager?.getPositions() || [];
  const riskStats = riskManager.getStats(positions);

  logger.info('\n' + '='.repeat(40));
  logger.info('PORTFOLIO STATUS');
  logger.info('='.repeat(40));

  if (portfolio) {
    logger.info(`Balance: ₹${portfolio.balance.toFixed(2)}`);
    logger.info(`Total Value: ₹${portfolio.totalValue.toFixed(2)}`);
    logger.info(`Unrealized PnL: ₹${portfolio.totalUnrealizedPnL.toFixed(2)}`);
    logger.info(`Positions: ${portfolio.positions.length}`);
  }

  if (stats) {
    logger.info(`\nTrades: ${stats.totalTrades} | Win Rate: ${stats.winRate}%`);
    logger.info(`Realized PnL: ₹${stats.realizedPnL.toFixed(2)}`);
  }

  if (riskStats) {
    logger.info(`\nDaily PnL: ₹${riskStats.dailyPnL.toFixed(2)}`);
    logger.info(`Total PnL: ₹${riskStats.totalPnL.toFixed(2)}`);
    logger.info(`Drawdown: ${riskStats.currentDrawdown.toFixed(2)}%`);
  }

  logger.info('='.repeat(40));
}

/**
 * Print report
 */
function printReport(report) {
  for (const [section, data] of Object.entries(report)) {
    logger.info(`\n${chalk.bold(section)}`);
    logger.info('-'.repeat(section.length));
    for (const [key, value] of Object.entries(data)) {
      logger.info(`  ${key}: ${value}`);
    }
  }
}

/**
 * Shutdown application
 */
async function shutdown(statusInterval) {
  logger.info('Shutting down...');
  app.running = false;

  clearInterval(statusInterval);

  // Stop market data and the position monitor
  app.positionMonitor?.stop();
  marketStream.stop();
  candleBuilder.stop();

  // Close all positions in paper/live mode
  if (app.orderManager && app.mode !== 'backtest') {
    logger.info('Closing all positions...');
    const prices = marketStream.getAllPrices();
    await app.orderManager.closeAllPositions(prices);
  }

  // Save final snapshot
  if (tradeRepository.initialized) {
    const portfolio = app.broker?.getPortfolio?.();
    if (portfolio) {
      tradeRepository.savePortfolioSnapshot({
        balance: portfolio.balance,
        unrealizedPnL: portfolio.totalUnrealizedPnL,
        totalValue: portfolio.totalValue,
        positionsCount: portfolio.positions.length,
      });
    }
    tradeRepository.close();
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
  const program = new Command();

  program
    .name('algo-trading')
    .description('Algorithmic Trading Framework')
    .version('1.0.0');

  program
    .option('--mode <mode>', 'Trading mode: paper, backtest, live', 'paper')
    .option('--symbol <symbol>', 'Symbol to trade/backtest', 'RELIANCE')
    .option('--strategy <strategy>', 'Strategy to use/backtest', 'all')
    .option('--capital <amount>', 'Initial capital', '100000')
    .option('--dry-run', 'Force the paper broker regardless of --mode (never real money)', false);

  const options = program.parse().opts();

  // Override capital if specified
  if (options.capital) {
    config.set('trading.initialCapital', parseFloat(options.capital));
    config.set('backtest.initialCapital', parseFloat(options.capital));
  }

  // --dry-run never runs live code; paper broker + simulated feed only.
  try {
    await initialize(options.mode, { dryRun: options.dryRun });

    switch (options.mode) {
      case 'paper':
        await runPaperTrading();
        break;
      case 'backtest':
        await runBacktest({
          symbol: options.symbol,
          strategy: options.strategy,
        });
        break;
      case 'live':
        if (options.dryRun) {
          logger.warn('DRY RUN: --mode live --dry-run uses the PaperBroker with simulated data.');
          await runPaperTrading();
          break;
        }
        await runLiveTrading();
        break;
      default:
        logger.error(`Unknown mode: ${options.mode}`);
        process.exit(1);
    }
  } catch (error) {
    logger.error('Application error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Start application
main();

export default app;
