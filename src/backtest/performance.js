/**
 * Performance Metrics Calculator
 * Calculate trading performance statistics for backtest evaluation
 */

/**
 * Calculate comprehensive performance metrics
 */
export function calculatePerformanceMetrics(data) {
  const {
    trades,
    equityCurve,
    dailyReturns,
    initialCapital,
    finalCapital,
    maxDrawdown,
  } = data;

  if (!trades || trades.length === 0) {
    return {
      totalReturn: 0,
      totalReturnPercent: 0,
      winRate: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      avgTrade: 0,
      winningTrades: 0,
      losingTrades: 0,
    };
  }

  // Basic metrics
  const totalReturn = finalCapital - initialCapital;
  const totalReturnPercent = (totalReturn / initialCapital) * 100;

  // Win/Loss analysis
  const winningTrades = trades.filter(t => t.pnl > 0);
  const losingTrades = trades.filter(t => t.pnl <= 0);
  const winRate = (winningTrades.length / trades.length) * 100;

  // Profit/Loss calculations
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Average trade metrics
  const avgTrade = totalReturn / trades.length;
  const avgWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
  const avgLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : Infinity;

  // Expectancy
  const expectancy = (winRate / 100 * avgWin) - ((1 - winRate / 100) * avgLoss);

  // Drawdown analysis
  const drawdownMetrics = calculateDrawdownMetrics(equityCurve);

  // Risk-adjusted returns
  const sharpeRatio = calculateSharpeRatio(dailyReturns, 0.0001); // Assuming ~0.01% daily risk-free rate
  const sortinoRatio = calculateSortinoRatio(dailyReturns, 0.0001);
  const calmarRatio = calculateCalmarRatio(totalReturnPercent, maxDrawdown);

  // Consecutive wins/losses
  const consecutiveWins = calculateMaxConsecutive(trades, true);
  const consecutiveLosses = calculateMaxConsecutive(trades, false);

  // Time analysis
  const avgTradeDuration = calculateAvgTradeDuration(trades);

  return {
    // Returns
    totalReturn: totalReturn.toFixed(2),
    totalReturnPercent: totalReturnPercent.toFixed(2),
    finalCapital: finalCapital.toFixed(2),

    // Win/Loss
    winRate: winRate.toFixed(2),
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    profitFactor: profitFactor.toFixed(2),
    winLossRatio: winLossRatio.toFixed(2),

    // Trade metrics
    totalTrades: trades.length,
    avgTrade: avgTrade.toFixed(2),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    expectancy: expectancy.toFixed(2),

    // Risk-adjusted
    sharpeRatio: sharpeRatio.toFixed(2),
    sortinoRatio: sortinoRatio.toFixed(2),
    calmarRatio: calmarRatio.toFixed(2),

    // Drawdown
    maxDrawdown: (maxDrawdown * 100).toFixed(2),
    avgDrawdown: (drawdownMetrics.avgDrawdown * 100).toFixed(2),
    maxDrawdownDuration: drawdownMetrics.maxDuration,

    // Streaks
    maxConsecutiveWins: consecutiveWins,
    maxConsecutiveLosses: consecutiveLosses,

    // Time
    avgTradeDuration: avgTradeDuration,
  };
}

/**
 * Calculate drawdown metrics
 */
function calculateDrawdownMetrics(equityCurve) {
  if (!equityCurve || equityCurve.length === 0) {
    return { avgDrawdown: 0, maxDuration: 0 };
  }

  let peak = equityCurve[0].value;
  let maxDrawdown = 0;
  let currentDrawdown = 0;
  let maxDuration = 0;
  let currentDuration = 0;
  let drawdownSum = 0;
  let drawdownCount = 0;

  for (const point of equityCurve) {
    if (point.value > peak) {
      peak = point.value;
      currentDrawdown = 0;
      if (currentDuration > maxDuration) {
        maxDuration = currentDuration;
      }
      currentDuration = 0;
    } else {
      currentDrawdown = (peak - point.value) / peak;
      if (currentDrawdown > 0) {
        currentDuration++;
        drawdownSum += currentDrawdown;
        drawdownCount++;
      }
      if (currentDrawdown > maxDrawdown) {
        maxDrawdown = currentDrawdown;
      }
    }
  }

  // Check final duration
  if (currentDuration > maxDuration) {
    maxDuration = currentDuration;
  }

  return {
    avgDrawdown: drawdownCount > 0 ? drawdownSum / drawdownCount : 0,
    maxDuration,
  };
}

/**
 * Calculate Sharpe Ratio
 * Measures risk-adjusted return
 */
function calculateSharpeRatio(returns, riskFreeRate = 0) {
  if (!returns || returns.length < 2) return 0;

  const excessReturns = returns.map(r => r - riskFreeRate);
  const avgReturn = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
  const stdDev = calculateStandardDeviation(excessReturns);

  if (stdDev === 0) return 0;

  // Annualize (assuming daily returns)
  const annualizedReturn = avgReturn * 252;
  const annualizedStdDev = stdDev * Math.sqrt(252);

  return annualizedReturn / annualizedStdDev;
}

/**
 * Calculate Sortino Ratio
 * Like Sharpe but only considers downside deviation
 */
function calculateSortinoRatio(returns, riskFreeRate = 0) {
  if (!returns || returns.length < 2) return 0;

  const excessReturns = returns.map(r => r - riskFreeRate);
  const avgReturn = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;

  // Calculate downside deviation (only negative returns)
  const negativeReturns = excessReturns.filter(r => r < 0);
  const downsideVariance = negativeReturns.reduce((sum, r) => sum + r * r, 0) / returns.length;
  const downsideDeviation = Math.sqrt(downsideVariance);

  if (downsideDeviation === 0) return avgReturn > 0 ? Infinity : 0;

  // Annualize
  const annualizedReturn = avgReturn * 252;
  const annualizedDownsideDev = downsideDeviation * Math.sqrt(252);

  return annualizedReturn / annualizedDownsideDev;
}

/**
 * Calculate Calmar Ratio
 * Ratio of annualized return to maximum drawdown
 */
function calculateCalmarRatio(totalReturnPercent, maxDrawdown) {
  if (maxDrawdown === 0) return Infinity;
  return (totalReturnPercent / 100) / maxDrawdown;
}

/**
 * Calculate standard deviation
 */
function calculateStandardDeviation(values) {
  if (values.length < 2) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);

  return Math.sqrt(variance);
}

/**
 * Calculate maximum consecutive wins or losses
 */
function calculateMaxConsecutive(trades, isWin) {
  let maxConsecutive = 0;
  let currentConsecutive = 0;

  for (const trade of trades) {
    const isCurrentWin = trade.pnl > 0;
    if (isCurrentWin === isWin) {
      currentConsecutive++;
      if (currentConsecutive > maxConsecutive) {
        maxConsecutive = currentConsecutive;
      }
    } else {
      currentConsecutive = 0;
    }
  }

  return maxConsecutive;
}

/**
 * Calculate average trade duration
 */
function calculateAvgTradeDuration(trades) {
  const tradesWithDuration = trades.filter(t => t.entryTimestamp && t.exitTimestamp);
  if (tradesWithDuration.length === 0) return 'N/A';

  const totalDuration = tradesWithDuration.reduce((sum, t) => {
    return sum + (t.exitTimestamp - t.entryTimestamp);
  }, 0);

  const avgDurationMs = totalDuration / tradesWithDuration.length;
  const avgDurationMinutes = Math.round(avgDurationMs / 60000);

  if (avgDurationMinutes < 60) {
    return `${avgDurationMinutes}m`;
  } else if (avgDurationMinutes < 1440) {
    return `${(avgDurationMinutes / 60).toFixed(1)}h`;
  } else {
    return `${(avgDurationMinutes / 1440).toFixed(1)}d`;
  }
}

/**
 * Calculate Value at Risk (VaR)
 */
export function calculateVaR(returns, confidenceLevel = 0.95) {
  if (!returns || returns.length === 0) return 0;

  const sortedReturns = [...returns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidenceLevel) * sortedReturns.length);

  return sortedReturns[index] || 0;
}

/**
 * Calculate Maximum Favorable Excursion (MFE)
 * Maximum profit a trade reached before closing
 */
export function calculateMFE(trade, highPrices) {
  if (!trade || !highPrices) return 0;

  if (trade.side === 'BUY') {
    const maxHigh = Math.max(...highPrices);
    return maxHigh - trade.entryPrice;
  } else {
    const minLow = Math.min(...highPrices);
    return trade.entryPrice - minLow;
  }
}

/**
 * Calculate Maximum Adverse Excursion (MAE)
 * Maximum loss a trade reached before closing
 */
export function calculateMAE(trade, lowPrices) {
  if (!trade || !lowPrices) return 0;

  if (trade.side === 'BUY') {
    const minLow = Math.min(...lowPrices);
    return trade.entryPrice - minLow;
  } else {
    const maxHigh = Math.max(...lowPrices);
    return maxHigh - trade.entryPrice;
  }
}

/**
 * Generate performance report
 */
export function generatePerformanceReport(metrics, trades = []) {
  const report = {
    summary: {
      'Total Return': `${metrics.totalReturnPercent}%`,
      'Total PnL': `₹${metrics.totalReturn}`,
      'Final Capital': `₹${metrics.finalCapital}`,
      'Total Trades': metrics.totalTrades,
    },
    'Win/Loss Analysis': {
      'Win Rate': `${metrics.winRate}%`,
      'Winning Trades': metrics.winningTrades,
      'Losing Trades': metrics.losingTrades,
      'Profit Factor': metrics.profitFactor,
      'Win/Loss Ratio': metrics.winLossRatio,
    },
    'Trade Metrics': {
      'Avg Trade': `₹${metrics.avgTrade}`,
      'Avg Win': `₹${metrics.avgWin}`,
      'Avg Loss': `₹${metrics.avgLoss}`,
      'Expectancy': `₹${metrics.expectancy}`,
      'Avg Duration': metrics.avgTradeDuration,
    },
    'Risk Metrics': {
      'Sharpe Ratio': metrics.sharpeRatio,
      'Sortino Ratio': metrics.sortinoRatio,
      'Calmar Ratio': metrics.calmarRatio,
      'Max Drawdown': `${metrics.maxDrawdown}%`,
      'Avg Drawdown': `${metrics.avgDrawdown}%`,
    },
    'Streaks': {
      'Max Consecutive Wins': metrics.maxConsecutiveWins,
      'Max Consecutive Losses': metrics.maxConsecutiveLosses,
    },
  };

  // Add sample trades if available
  if (trades.length > 0) {
    report['Sample Trades'] = trades.slice(0, 5).map(t => ({
      symbol: t.symbol,
      side: t.side,
      pnl: `₹${t.pnl.toFixed(2)}`,
      exitReason: t.exitReason,
    }));
  }

  return report;
}

export default {
  calculatePerformanceMetrics,
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateCalmarRatio,
  calculateVaR,
  generatePerformanceReport,
};
