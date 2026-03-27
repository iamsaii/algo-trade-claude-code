/**
 * VWAP Mean Reversion Strategy
 * Trades reversion to VWAP (Volume Weighted Average Price)
 *
 * Buy Signal: Price falls 2+ standard deviations below VWAP
 * Sell Signal: Price rises 2+ standard deviations above VWAP
 *
 * Features:
 * - Uses volume-weighted price (more robust than simple price)
 * - Intraday-focused strategy (resets daily)
 * - Ideal for range-bound to trending markets
 * - Institutional-style trading logic
 */

import BaseStrategy from './baseStrategy.js';
import { vwap, vwapBands, rsi, atr } from '../utils/indicators.js';
import logger from '../utils/logger.js';

class VWAPMeanReversionStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('VWAPMeanReversion', {
      bbPeriod: config.bbPeriod || 20,
      stdDev: config.stdDev || 2,
      minCandles: config.minCandles || 30,
      useRSIFilter: config.useRSIFilter || true,
      rsiPeriod: config.rsiPeriod || 14,
      rsiOversold: config.rsiOversold || 35,
      rsiOverbought: config.rsiOverbought || 65,
      resetTime: config.resetTime || 86400, // 1 day in seconds
      atrPeriod: config.atrPeriod || 14,
      entryThreshold: config.entryThreshold || 1.5, // 1.5 std devs to enter
      exitThreshold: config.exitThreshold || 1.0, // 1.0 std devs to exit
      maxTradeDuration: config.maxTradeDuration || 20, // Max candles to hold
      ...config,
    });

    this.vwap = null;
    this.vwapUpper = null;
    this.vwapLower = null;
    this.currentPosition = null; // 'long', 'short', or null
    this.entryPrice = null;
    this.tradesToday = 0;
    this.cooldownCandles = 0;
  }

  /**
   * Generate trading signal based on VWAP mean reversion
   */
  generateSignal() {
    if (this.candles.length < this.config.minCandles) {
      return null;
    }

    // Get VWAP bands
    const bands = vwapBands(this.candles, this.config.bbPeriod, this.config.stdDev, this.config.resetTime);

    if (!bands) {
      return null;
    }

    const currentPrice = this.candles[this.candles.length - 1].close;
    let signal = null;

    // Check if we're in cooldown after a trade
    if (this.cooldownCandles > 0) {
      this.cooldownCandles--;
      return null;
    }

    // Calculate distance from VWAP in standard deviations
    const deviation = (currentPrice - bands.vwap) / bands.vwap;
    const zScore = deviation / (this.config.stdDev / bands.vwap * 100); // Normalize to std devs

    // Calculate RSI for additional filter
    const prices = this.getClosePrices();
    const currentRSI = rsi(prices, this.config.rsiPeriod) || 50;

    // Check current position state
    const isInProfit = this.currentPosition === 'long' ? currentPrice > this.entryPrice : currentPrice < this.entryPrice;
    const tradeAge = this.candles.length - this.candles.findIndex(c => c.close === this.entryPrice);

    // SELL current position: Price exits profitable range
    if (this.currentPosition === 'long' && isInProfit) {
      // Take profit: price above upper band
      if (currentPrice >= bands.upper) {
        signal = this._createSellSignal(currentPrice, bands.upper, bands.vwap);
        this.closePosition();
      }
      // Stop loss: price below VWAP - exitThreshold
      else if (currentPrice <= bands.vwap * (1 - this.config.exitThreshold / 100)) {
        signal = this._createSellSignal(currentPrice, bands.lower, bands.vwap);
        this.closePosition();
      }
    }

    // BUY new position: Price below lower band
    else if (currentPrice <= bands.lower * (1 - this.config.entryThreshold / 100)) {
      // RSI filter - don't buy if already overbought
      if (this.config.useRSIFilter && currentRSI > this.config.rsiOverbought) {
        logger.debug(`${this.name} [${this.symbol}]: RSI ${currentRSI.toFixed(1)} too high for buy`);
        return null;
      }

      signal = this._createBuySignal(currentPrice, bands.lower, bands.vwap);
      this.currentPosition = 'long';
      this.entryPrice = currentPrice;
      this.tradesToday++;
      this.emit('position_opened', { symbol: this.symbol, position: 'long', vwap: bands.vwap });
    }

    // SELL short position: Price exits profitable range
    else if (this.currentPosition === 'short') {
      // Take profit: price below lower band
      if (currentPrice <= bands.lower) {
        signal = this._createBuySignal(currentPrice, bands.lower, bands.vwap);
        this.closePosition();
      }
      // Stop loss: price above VWAP + exitThreshold
      else if (currentPrice >= bands.vwap * (1 + this.config.exitThreshold / 100)) {
        signal = this._createSellSignal(currentPrice, bands.upper, bands.vwap);
        this.closePosition();
      }
    }

    // Check for trade timeout
    if (this.currentPosition && tradeAge > this.config.maxTradeDuration) {
      logger.debug(`${this.name} [${this.symbol}]: Trade timeout, closing position`);
      this.closePosition();
    }

    // Log signals
    if (signal) {
      logger.info(`${this.name} [${this.symbol}]: ${signal.action} - ${signal.reason}`);
    }

    return signal;
  }

  /**
   * Create BUY signal (mean reversion from oversold)
   */
  _createBuySignal(entryPrice, lowerBand, vwap) {
    const currentATR = atr(this.candles, this.config.atrPeriod) || entryPrice * 0.02;
    const strength = this._calculateStrength(lowerBand, vwap);

    return {
      action: 'BUY',
      strength,
      entryPrice,
      stopLoss: parseFloat((vwap * 0.97).toFixed(2)), // 3% below VWAP
      target: parseFloat((entryPrice + currentATR * 2).toFixed(2)),
      reason: `VWAP Mean Reversion: Price bounced from oversold, below VWAP`,
      indicators: {
        vwap,
        vwapUpper: this.vwapUpper,
        vwapLower: this.vwapLower,
        currentPrice: entryPrice,
        rsi: currentRSI || 50,
        position: 'none',
      },
    };
  }

  /**
   * Create SELL signal (mean reversion from overbought)
   */
  _createSellSignal(entryPrice, upperBand, vwap) {
    const currentATR = atr(this.candles, this.config.atrPeriod) || entryPrice * 0.02;
    const strength = this._calculateStrength(upperBand, vwap);

    return {
      action: 'SELL',
      strength,
      entryPrice,
      stopLoss: parseFloat((vwap * 1.03).toFixed(2)), // 3% above VWAP
      target: parseFloat((entryPrice - currentATR * 2).toFixed(2)),
      reason: `VWAP Mean Reversion: Price rejected from overbought, above VWAP`,
      indicators: {
        vwap,
        vwapUpper: this.vwapUpper,
        vwapLower: this.vwapLower,
        currentPrice: entryPrice,
        rsi: currentRSI || 50,
        position: 'none',
      },
    };
  }

  /**
   * Close current position
   */
  closePosition() {
    if (!this.currentPosition) return;

    const priceChange = this.currentPosition === 'long'
      ? this.candles[this.candles.length - 1].close - this.entryPrice
      : this.entryPrice - this.candles[this.candles.length - 1].close;

    const pnlPercent = (priceChange / this.entryPrice * 100).toFixed(2);

    logger.info(`VWAP Position closed: ${this.currentPosition === 'long' ? 'LONG' : 'SHORT'} - PnL: ${pnlPercent}%`);

    this.currentPosition = null;
    this.entryPrice = null;
    this.cooldownCandles = 5; // 5 candle cooldown
  }

  /**
   * Calculate signal strength
   */
  _calculateStrength(band, vwap) {
    let strength = 0.6;

    // Stronger signal when price is further from VWAP
    const distance = Math.abs(band - vwap) / vwap * 100;

    if (distance > 5) strength = 0.9;
    else if (distance > 4) strength = 0.85;
    else if (distance > 3) strength = 0.8;
    else if (distance > 2) strength = 0.7;

    // Reduce strength if price is very far (potential reversal)
    if (distance > 8) strength *= 0.7;

    return parseFloat(strength.toFixed(2));
  }

  /**
   * Override reset to reset VWAP state
   */
  reset() {
    super.reset();
    this.vwap = null;
    this.vwapUpper = null;
    this.vwapLower = null;
    this.currentPosition = null;
    this.entryPrice = null;
    this.tradesToday = 0;
    this.cooldownCandles = 0;
  }

  /**
   * Get additional strategy stats
   */
  getStats() {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      bbPeriod: this.config.bbPeriod,
      stdDev: this.config.stdDev,
      vwap: this.vwap,
      currentPosition: this.currentPosition,
      tradesToday: this.tradesToday,
      cooldownCandles: this.cooldownCandles,
    };
  }
}

export default VWAPMeanReversionStrategy;