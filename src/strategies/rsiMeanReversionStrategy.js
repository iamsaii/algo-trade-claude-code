/**
 * RSI Mean Reversion Strategy
 * Trades based on RSI oversold/overbought levels with mean reversion logic
 *
 * Buy Signal: RSI crosses below oversold level then back above (oversold bounce)
 * Sell Signal: RSI crosses above overbought level then back below (overbought rejection)
 */

import BaseStrategy from './baseStrategy.js';
import { rsi, sma, bollingerBands } from '../utils/indicators.js';
import logger from '../utils/logger.js';

class RSIMeanReversionStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('RSIMeanReversion', {
      rsiPeriod: config.rsiPeriod || 14,
      oversoldLevel: config.oversoldLevel || 30,
      overboughtLevel: config.overboughtLevel || 70,
      minCandles: config.minCandles || 30,
      useBollingerBands: config.useBollingerBands || true,
      bbPeriod: config.bbPeriod || 20,
      bbStdDev: config.bbStdDev || 2,
      ...config,
    });

    this.previousRSI = null;
    this.rsiState = 'neutral'; // 'neutral', 'oversold', 'overbought'
    this.signalCooldown = 0; // Prevent rapid signals
  }

  /**
   * Generate trading signal based on RSI mean reversion
   */
  generateSignal() {
    if (this.candles.length < this.config.minCandles) {
      return null;
    }

    // Cooldown period after signal
    if (this.signalCooldown > 0) {
      this.signalCooldown--;
      return null;
    }

    const prices = this.getClosePrices();
    const currentRSI = rsi(prices, this.config.rsiPeriod);

    if (currentRSI === null) {
      return null;
    }

    const currentPrice = prices[prices.length - 1];
    let signal = null;

    // Check Bollinger Bands confirmation if enabled
    let bbConfirmation = { confirmed: true, position: 'none' };
    if (this.config.useBollingerBands) {
      bbConfirmation = this._checkBollingerBands(prices);
    }

    // RSI Mean Reversion Logic
    if (this.previousRSI !== null) {
      // Oversold bounce setup
      if (this.previousRSI < this.config.oversoldLevel && currentRSI >= this.config.oversoldLevel) {
        if (bbConfirmation.confirmed && bbConfirmation.position === 'lower') {
          signal = this._createBuySignal(currentPrice, prices, currentRSI);
          this.rsiState = 'neutral';
          this.signalCooldown = 10; // Cooldown period
        }
      }
      // Overbought rejection setup
      else if (this.previousRSI > this.config.overboughtLevel && currentRSI <= this.config.overboughtLevel) {
        if (bbConfirmation.confirmed && bbConfirmation.position === 'upper') {
          signal = this._createSellSignal(currentPrice, prices, currentRSI);
          this.rsiState = 'neutral';
          this.signalCooldown = 10;
        }
      }
    }

    // Track RSI state
    if (currentRSI < this.config.oversoldLevel) {
      this.rsiState = 'oversold';
    } else if (currentRSI > this.config.overboughtLevel) {
      this.rsiState = 'overbought';
    } else {
      this.rsiState = 'neutral';
    }

    this.previousRSI = currentRSI;

    return signal;
  }

  /**
   * Check Bollinger Bands position
   */
  _checkBollingerBands(prices) {
    const bb = bollingerBands(prices, this.config.bbPeriod, this.config.bbStdDev);
    if (!bb) return { confirmed: false, position: 'none' };

    const currentPrice = prices[prices.length - 1];
    let position = 'none';

    if (currentPrice <= bb.lower) {
      position = 'lower';
    } else if (currentPrice >= bb.upper) {
      position = 'upper';
    } else if (currentPrice >= bb.lower && currentPrice <= bb.middle) {
      position = 'lower-middle';
    } else {
      position = 'middle-upper';
    }

    return { confirmed: true, position, bands: bb };
  }

  /**
   * Create BUY signal
   */
  _createBuySignal(entryPrice, prices, currentRSI) {
    const atr = this._calculateATR(prices);
    const strength = this._calculateStrength(currentRSI, 'BUY');

    return {
      action: 'BUY',
      strength,
      entryPrice,
      stopLoss: parseFloat((entryPrice - atr * 2).toFixed(2)),
      target: parseFloat((entryPrice + atr * 3).toFixed(2)),
      reason: `RSI Mean Reversion: RSI (${currentRSI.toFixed(2)}) bounced from oversold (<${this.config.oversoldLevel})`,
      indicators: {
        rsi: currentRSI,
        rsiState: this.rsiState,
        signal: 'oversold_bounce',
      },
    };
  }

  /**
   * Create SELL signal
   */
  _createSellSignal(entryPrice, prices, currentRSI) {
    const atr = this._calculateATR(prices);
    const strength = this._calculateStrength(currentRSI, 'SELL');

    return {
      action: 'SELL',
      strength,
      entryPrice,
      stopLoss: parseFloat((entryPrice + atr * 2).toFixed(2)),
      target: parseFloat((entryPrice - atr * 3).toFixed(2)),
      reason: `RSI Mean Reversion: RSI (${currentRSI.toFixed(2)}) rejected from overbought (>${this.config.overboughtLevel})`,
      indicators: {
        rsi: currentRSI,
        rsiState: this.rsiState,
        signal: 'overbought_rejection',
      },
    };
  }

  /**
   * Calculate signal strength
   */
  _calculateStrength(currentRSI, action) {
    let strength = 0.5;

    // Stronger signal when RSI is extremely oversold/overbought
    if (action === 'BUY') {
      if (currentRSI < 20) strength = 0.9;
      else if (currentRSI < 25) strength = 0.8;
      else if (currentRSI < 30) strength = 0.7;
    } else {
      if (currentRSI > 80) strength = 0.9;
      else if (currentRSI > 75) strength = 0.8;
      else if (currentRSI > 70) strength = 0.7;
    }

    return parseFloat(strength.toFixed(2));
  }

  /**
   * Calculate ATR
   */
  _calculateATR(prices, period = 14) {
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
   * Override reset
   */
  reset() {
    super.reset();
    this.previousRSI = null;
    this.rsiState = 'neutral';
    this.signalCooldown = 0;
  }

  /**
   * Get additional stats
   */
  getStats() {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      rsiPeriod: this.config.rsiPeriod,
      oversoldLevel: this.config.oversoldLevel,
      overboughtLevel: this.config.overboughtLevel,
      previousRSI: this.previousRSI,
      rsiState: this.rsiState,
      signalCooldown: this.signalCooldown,
    };
  }
}

export default RSIMeanReversionStrategy;
