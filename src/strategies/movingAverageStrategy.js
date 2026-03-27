/**
 * Moving Average Crossover Strategy
 * Generates signals when short-term MA crosses above/below long-term MA
 *
 * Buy Signal: Short MA crosses above Long MA (golden cross)
 * Sell Signal: Short MA crosses below Long MA (death cross)
 */

import BaseStrategy from './baseStrategy.js';
import { sma, ema } from '../utils/indicators.js';
import logger from '../utils/logger.js';

class MovingAverageStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('MovingAverageCrossover', {
      shortPeriod: config.shortPeriod || 10,
      longPeriod: config.longPeriod || 20,
      useEma: config.useEma || false, // Use EMA instead of SMA
      minCandles: config.minCandles || 30,
      ...config,
    });

    this.previousShortMA = null;
    this.previousLongMA = null;
    this.crossoverDetected = false;
  }

  /**
   * Generate trading signal based on MA crossover
   */
  generateSignal() {
    if (this.candles.length < this.config.minCandles) {
      return null;
    }

    const prices = this.getClosePrices();
    const shortMA = this.config.useEma
      ? ema(prices, this.config.shortPeriod)
      : sma(prices, this.config.shortPeriod);
    const longMA = this.config.useEma
      ? ema(prices, this.config.longPeriod)
      : sma(prices, this.config.longPeriod);

    if (shortMA === null || longMA === null) {
      return null;
    }

    const currentPrice = prices[prices.length - 1];
    let signal = null;

    // Detect crossover
    if (this.previousShortMA !== null && this.previousLongMA !== null) {
      // Golden cross: short MA crosses above long MA
      if (this.previousShortMA <= this.previousLongMA && shortMA > longMA) {
        signal = {
          action: 'BUY',
          strength: this._calculateStrength(prices, shortMA, longMA),
          entryPrice: currentPrice,
          stopLoss: this._calculateStopLoss(currentPrice, 'BUY', prices),
          target: this._calculateTarget(currentPrice, 'BUY', prices),
          reason: `Golden Cross: ${this.config.shortPeriod}-MA (${shortMA.toFixed(2)}) crossed above ${this.config.longPeriod}-MA (${longMA.toFixed(2)})`,
          indicators: {
            shortMA: shortMA,
            longMA: longMA,
            crossover: 'bullish',
          },
        };
        this.crossoverDetected = true;
        logger.info(`${this.name} [${this.symbol}]: BUY signal - Golden Cross detected`);
      }
      // Death cross: short MA crosses below long MA
      else if (this.previousShortMA >= this.previousLongMA && shortMA < longMA) {
        signal = {
          action: 'SELL',
          strength: this._calculateStrength(prices, shortMA, longMA),
          entryPrice: currentPrice,
          stopLoss: this._calculateStopLoss(currentPrice, 'SELL', prices),
          target: this._calculateTarget(currentPrice, 'SELL', prices),
          reason: `Death Cross: ${this.config.shortPeriod}-MA (${shortMA.toFixed(2)}) crossed below ${this.config.longPeriod}-MA (${longMA.toFixed(2)})`,
          indicators: {
            shortMA: shortMA,
            longMA: longMA,
            crossover: 'bearish',
          },
        };
        this.crossoverDetected = true;
        logger.info(`${this.name} [${this.symbol}]: SELL signal - Death Cross detected`);
      }
    }

    // Store current MAs for next comparison
    this.previousShortMA = shortMA;
    this.previousLongMA = longMA;

    return signal;
  }

  /**
   * Calculate signal strength (0-1)
   */
  _calculateStrength(prices, shortMA, longMA) {
    const currentPrice = prices[prices.length - 1];
    const maDistance = Math.abs(shortMA - longMA) / longMA;
    const priceDistance = Math.abs(currentPrice - shortMA) / shortMA;

    // Stronger signal when MAs are diverging and price confirms
    let strength = Math.min(maDistance * 50, 1);

    // Reduce strength if price is far from MA (potential reversal)
    if (priceDistance > 0.02) {
      strength *= 0.7;
    }

    return parseFloat(strength.toFixed(3));
  }

  /**
   * Calculate stop loss level
   */
  _calculateStopLoss(entryPrice, action, prices) {
    const atr = this._calculateATR(prices, 14);
    const atrMultiplier = 2;

    if (action === 'BUY') {
      return parseFloat((entryPrice - atr * atrMultiplier).toFixed(2));
    } else {
      return parseFloat((entryPrice + atr * atrMultiplier).toFixed(2));
    }
  }

  /**
   * Calculate target price
   */
  _calculateTarget(entryPrice, action, prices) {
    const atr = this._calculateATR(prices, 14);
    const atrMultiplier = 3; // Risk-reward ratio of 1:1.5

    if (action === 'BUY') {
      return parseFloat((entryPrice + atr * atrMultiplier).toFixed(2));
    } else {
      return parseFloat((entryPrice - atr * atrMultiplier).toFixed(2));
    }
  }

  /**
   * Calculate ATR (simplified)
   */
  _calculateATR(prices, period) {
    if (prices.length < period + 1) return prices[prices.length - 1] * 0.02;

    let trueRanges = [];
    for (let i = 1; i < Math.min(period + 1, prices.length); i++) {
      const range = Math.abs(prices[i] - prices[i - 1]);
      trueRanges.push(range);
    }

    const sum = trueRanges.reduce((a, b) => a + b, 0);
    return sum / trueRanges.length;
  }

  /**
   * Override reset to clear MA tracking
   */
  reset() {
    super.reset();
    this.previousShortMA = null;
    this.previousLongMA = null;
    this.crossoverDetected = false;
  }

  /**
   * Get additional strategy stats
   */
  getStats() {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      shortPeriod: this.config.shortPeriod,
      longPeriod: this.config.longPeriod,
      useEma: this.config.useEma,
      previousShortMA: this.previousShortMA,
      previousLongMA: this.previousLongMA,
    };
  }
}

export default MovingAverageStrategy;
