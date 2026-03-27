/**
 * Backtesting Engine
 * Run strategies on historical data and calculate performance metrics
 */

import logger from '../utils/logger.js';
import { sma, ema, rsi, atr, bollingerBands } from '../utils/indicators.js';
import { calculatePerformanceMetrics } from './performance.js';

class Backtester {
  constructor(initialCapital = 100000) {
    this.initialCapital = initialCapital;
    this.capital = initialCapital;
    this.positions = new Map();
    this.trades = [];
    this.equityCurve = [];
    this.dailyReturns = [];
  }

  /**
   * Run backtest on historical data
   */
  run(strategy, historicalData, options = {}) {
    const {
      symbol = 'TEST',
      startDate = null,
      endDate = null,
      initialCapital = this.initialCapital,
      commission = 0.0003, // 0.03% per trade
      slippage = 0.001,    // 0.1% slippage
    } = options;

    // Reset state
    this.capital = initialCapital;
    this.positions.clear();
    this.trades = [];
    this.equityCurve = [{ value: initialCapital, index: 0 }];
    this.dailyReturns = [];

    logger.info('Starting backtest', {
      strategy: strategy.getName(),
      symbol,
      candles: historicalData.length,
      initialCapital,
    });

    // Initialize strategy with historical data
    const warmupPeriod = strategy.config.minCandles || 30;
    strategy.initialize(symbol, historicalData.slice(0, warmupPeriod));

    // Process each candle
    let peakEquity = initialCapital;
    let maxDrawdown = 0;

    for (let i = warmupPeriod; i < historicalData.length; i++) {
      const candle = historicalData[i];
      const previousCandle = historicalData[i - 1];

      // Check for stop loss / target hits on existing positions
      this._checkExitConditions(candle, commission);

      // Process candle through strategy
      const signal = strategy.onCandle(candle);

      // Execute signal if no existing position
      if (signal && !this.positions.has(symbol)) {
        this._executeSignal(signal, candle, symbol, commission, slippage);
      }

      // Update equity curve
      const currentEquity = this._calculateEquity(candle.close);
      this.equityCurve.push({
        value: currentEquity,
        index: i,
        timestamp: candle.timestamp,
        price: candle.close,
      });

      // Track drawdown
      if (currentEquity > peakEquity) {
        peakEquity = currentEquity;
      }
      const drawdown = (peakEquity - currentEquity) / peakEquity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }

      // Calculate daily return
      if (i > 0) {
        const prevEquity = this.equityCurve[i - warmupPeriod].value;
        const dailyReturn = (currentEquity - prevEquity) / prevEquity;
        this.dailyReturns.push(dailyReturn);
      }
    }

    // Close any remaining positions at last candle
    const lastCandle = historicalData[historicalData.length - 1];
    this._closeAllPositions(lastCandle.close, commission);

    // Calculate performance metrics
    const metrics = calculatePerformanceMetrics({
      trades: this.trades,
      equityCurve: this.equityCurve,
      dailyReturns: this.dailyReturns,
      initialCapital,
      finalCapital: this.capital,
      maxDrawdown,
    });

    logger.info('Backtest completed', {
      totalTrades: this.trades.length,
      finalCapital: this.capital.toFixed(2),
      totalReturn: ((this.capital - initialCapital) / initialCapital * 100).toFixed(2) + '%',
    });

    return {
      trades: this.trades,
      equityCurve: this.equityCurve,
      metrics,
      summary: {
        symbol,
        strategy: strategy.getName(),
        candles: historicalData.length,
        trades: this.trades.length,
        initialCapital,
        finalCapital: this.capital,
        totalReturn: (this.capital - initialCapital).toFixed(2),
        totalReturnPercent: ((this.capital - initialCapital) / initialCapital * 100).toFixed(2),
        maxDrawdown: (maxDrawdown * 100).toFixed(2),
        ...metrics,
      },
    };
  }

  /**
   * Execute a trading signal
   */
  _executeSignal(signal, candle, symbol, commission, slippage) {
    // Apply slippage to entry price
    const slippageFactor = signal.action === 'BUY' ? (1 + slippage) : (1 - slippage);
    const entryPrice = candle.close * slippageFactor;

    // Calculate position size (use full capital for simplicity)
    const quantity = Math.floor(this.capital / entryPrice);
    if (quantity <= 0) return;

    // Calculate commission
    const tradeValue = quantity * entryPrice;
    const commissionCost = tradeValue * commission;

    // Update capital
    this.capital -= commissionCost;

    // Create position
    this.positions.set(symbol, {
      symbol,
      side: signal.action,
      quantity,
      entryPrice,
      stopLoss: signal.stopLoss,
      target: signal.target,
      entryCandle: candle,
      strategy: signal.strategy,
    });

    logger.debug('Backtest position opened', {
      symbol,
      side: signal.action,
      quantity,
      entryPrice: entryPrice.toFixed(2),
    });
  }

  /**
   * Check exit conditions (stop loss / target)
   */
  _checkExitConditions(candle, commission) {
    for (const [symbol, position] of this.positions) {
      let shouldExit = false;
      let exitReason = '';

      if (position.side === 'BUY') {
        // Check stop loss
        if (candle.low <= position.stopLoss) {
          shouldExit = true;
          exitReason = 'Stop Loss';
        }
        // Check target
        else if (candle.high >= position.target) {
          shouldExit = true;
          exitReason = 'Target';
        }
      } else {
        // Check stop loss (for short)
        if (candle.high >= position.stopLoss) {
          shouldExit = true;
          exitReason = 'Stop Loss';
        }
        // Check target (for short)
        else if (candle.low <= position.target) {
          shouldExit = true;
          exitReason = 'Target';
        }
      }

      if (shouldExit) {
        // Use stop loss or target price, or close if neither hit
        let exitPrice;
        if (exitReason === 'Stop Loss') {
          exitPrice = position.stopLoss;
        } else {
          exitPrice = position.target;
        }

        this._closePosition(symbol, exitPrice, commission, exitReason);
      }
    }
  }

  /**
   * Close a position
   */
  _closePosition(symbol, exitPrice, commission, reason = 'Exit') {
    const position = this.positions.get(symbol);
    if (!position) return;

    // Calculate PnL
    let pnl;
    if (position.side === 'BUY') {
      pnl = (exitPrice - position.entryPrice) * position.quantity;
    } else {
      pnl = (position.entryPrice - exitPrice) * position.quantity;
    }

    // Subtract commission
    const tradeValue = position.quantity * exitPrice;
    const commissionCost = tradeValue * commission;
    pnl -= commissionCost;

    // Update capital
    this.capital += pnl;

    // Record trade
    this.trades.push({
      symbol,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl,
      pnlPercent: (pnl / (position.entryPrice * position.quantity)) * 100,
      strategy: position.strategy,
      entryTimestamp: position.entryCandle.timestamp,
      exitTimestamp: Date.now(),
      exitReason: reason,
    });

    // Remove position
    this.positions.delete(symbol);

    logger.debug('Backtest position closed', {
      symbol,
      pnl: pnl.toFixed(2),
      reason,
    });
  }

  /**
   * Close all positions
   */
  _closeAllPositions(exitPrice, commission) {
    for (const symbol of this.positions.keys()) {
      this._closePosition(symbol, exitPrice, commission, 'End of Data');
    }
  }

  /**
   * Calculate current equity
   */
  _calculateEquity(currentPrice) {
    let equity = this.capital;

    for (const [symbol, position] of this.positions) {
      if (position.side === 'BUY') {
        equity += (currentPrice - position.entryPrice) * position.quantity;
      } else {
        equity += (position.entryPrice - currentPrice) * position.quantity;
      }
    }

    return equity;
  }

  /**
   * Get open positions
   */
  getPositions() {
    return Array.from(this.positions.values());
  }

  /**
   * Get trade history
   */
  getTrades() {
    return this.trades;
  }
}

/**
 * Compare multiple strategies
 */
export function compareStrategies(strategies, historicalData, options = {}) {
  const results = [];

  for (const strategy of strategies) {
    logger.info(`Backtesting strategy: ${strategy.getName()}`);
    const backtester = new Backtester(options.initialCapital || 100000);
    const result = backtester.run(strategy, historicalData, options);
    results.push(result);
  }

  // Sort by total return
  results.sort((a, b) => b.summary.finalCapital - a.summary.finalCapital);

  return results;
}

/**
 * Run strategy optimization (parameter sweep)
 */
export function optimizeStrategy(strategyClass, historicalData, paramGrid, baseConfig = {}) {
  const results = [];
  const params = Object.keys(paramGrid);

  // Generate all parameter combinations
  function generateCombinations(params, index = 0, current = {}) {
    if (index >= params.length) {
      return [current];
    }

    const param = params[index];
    const values = paramGrid[param];
    const combinations = [];

    for (const value of values) {
      const newConfig = { ...current, [param]: value };
      combinations.push(...generateCombinations(params, index + 1, newConfig));
    }

    return combinations;
  }

  const combinations = generateCombinations(params);
  logger.info(`Starting optimization with ${combinations.length} parameter combinations`);

  for (const config of combinations) {
    const strategy = new strategyClass({ ...baseConfig, ...config });
    const backtester = new Backtester(baseConfig.initialCapital || 100000);
    const result = backtester.run(strategy, historicalData);

    results.push({
      parameters: config,
      ...result.summary,
    });
  }

  // Sort by Sharpe ratio
  results.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  return {
    bestParameters: results[0]?.parameters,
    bestMetrics: results[0],
    allResults: results,
  };
}

export default Backtester;
