/**
 * MACD Trend Strategy - LONG BIAS
 * Uses MACD for entry, trailing stop for exit
 * Designed for trending Indian stocks
 */

import BaseStrategy from './baseStrategy.js';
import { macd, atr } from '../utils/indicators.js';
import logger from '../utils/logger.js';

class MACDTrendStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('MACDTrend', {
      fastPeriod: config.fastPeriod || 12,
      slowPeriod: config.slowPeriod || 26,
      signalPeriod: config.signalPeriod || 9,
      minCandles: config.minCandles || 30,
      histogramThreshold: config.histogramThreshold || 1, // Require strong momentum
      trailingStopPct: config.trailingStopPct || 10, // 10% trailing stop
      maxTradeDays: config.maxTradeDays || 60, // Maximum holding period
      ...config,
    });

    this.macdData = null;
    this.entryPrice = null;
    this.positionStart = null;
    this.signalCooldown = 0;
  }

  /**
   * Generate trading signal
   */
  generateSignal() {
    if (this.candles.length < this.config.minCandles) {
      return null;
    }

    // Cooldown period
    if (this.signalCooldown > 0) {
      this.signalCooldown--;
      return null;
    }

    // Get MACD data
    const prices = this.getClosePrices();
    this.macdData = macd(prices, this.config.fastPeriod, this.config.slowPeriod, this.config.signalPeriod);

    if (!this.macdData) {
      return null;
    }

    const currentPrice = prices[prices.length - 1];
    let signal = null;

    // LONG-ONLY STRATEGY: Buy on histogram crossover above zero
    if (this.macdData.histogram > this.config.histogramThreshold) {
      // Only enter if histogram is positive
      signal = this._createBuySignal(currentPrice, this.macdData.histogram);
      this.emit('trend_confirmation', { symbol: this.symbol, histogram: this.macdData.histogram });
    }

    // LONG-ONLY: Sell on trailing stop or max duration
    if (this.entryPrice !== null) {
      const duration = this.positionStart ? Date.now() - this.positionStart : 0;

      // Trailing stop: sell if price drops 5% below entry
      if (currentPrice < this.entryPrice * (1 - this.config.trailingStopPct / 100)) {
        signal = this._createSellSignal(currentPrice, this.entryPrice, 'trailing_stop');
        this.emit('trend_confirmation', { symbol: this.symbol, reason: 'Trailing Stop' });
      }

      // Max duration stop
      if (duration > this.config.maxTradeDays * 24 * 60 * 60 * 1000) {
        signal = this._createSellSignal(currentPrice, this.entryPrice, 'duration_stop');
        this.emit('trend_confirmation', { symbol: this.symbol, reason: 'Duration Stop' });
      }

      // Exit when histogram turns negative (trend reversal)
      if (this.macdData.histogram < 0) {
        signal = this._createSellSignal(currentPrice, this.entryPrice, 'histogram_negative');
        this.emit('trend_confirmation', { symbol: this.symbol, reason: 'Histogram Negative' });
      }
    }

    // Update position tracking
    if (this.entryPrice !== null) {
      this.positionStart = Date.now();
    }

    // Increase cooldown after signal
    this.signalCooldown = 50;

    // Log signals
    if (signal) {
      logger.info(`${this.name} [${this.symbol}]: ${signal.action} - ${signal.reason}`);
    }

    return signal;
  }

  /**
   * Create BUY signal
   */
  _createBuySignal(entryPrice, histogram) {
    const currentATR = atr(this.candles, 14) || entryPrice * 0.02;
    const strength = 0.8;

    return {
      action: 'BUY',
      strength,
      entryPrice,
      stopLoss: parseFloat((entryPrice - currentATR * 2).toFixed(2)),
      target: parseFloat((entryPrice + currentATR * 3).toFixed(2)),
      reason: `MACD Long-Entry: Histogram ${histogram.toFixed(3)} indicates bullish momentum`,
      indicators: {
        macd: this.macdData.macd,
        signal: this.macdData.signal,
        histogram,
        adx: 0,
        trendDirection: 'long',
        signal: 'histogram_positive',
      },
    };
  }

  /**
   * Create SELL signal
   */
  _createSellSignal(entryPrice, histogram, reason) {
    const currentATR = atr(this.candles, 14) || entryPrice * 0.02;
    const strength = 0.9;

    return {
      action: 'SELL',
      strength,
      entryPrice,
      stopLoss: parseFloat((entryPrice + currentATR * 2).toFixed(2)),
      target: parseFloat((entryPrice - currentATR * 3).toFixed(2)),
      reason: `MACD Long-Exit: ${reason}`,
      indicators: {
        macd: this.macdData.macd,
        signal: this.macdData.signal,
        histogram,
        adx: 0,
        trendDirection: 'long',
        signal: reason,
      },
    };
  }

  /**
   * Calculate signal strength
   */
  _calculateStrength(histogram, action) {
    let strength = 0.5;
    if (action === 'BUY' && histogram > 0.5) strength = 0.9;
    return parseFloat(strength.toFixed(2));
  }

  /**
   * Override reset to clear state
   */
  reset() {
    super.reset();
    this.macdData = null;
    this.entryPrice = null;
    this.positionStart = null;
    this.signalCooldown = 0;
  }

  /**
   * Get additional strategy stats
   */
  getStats() {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      trailingStopPct: this.config.trailingStopPct,
      maxTradeDays: this.config.maxTradeDays,
      isLongOnly: true,
    };
  }
}

export default MACDTrendStrategy;
