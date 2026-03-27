/**
 * Breakout Strategy
 * Trades breakouts from support/resistance levels
 *
 * Buy Signal: Price breaks above resistance with volume confirmation
 * Sell Signal: Price breaks below support with volume confirmation
 */

import BaseStrategy from './baseStrategy.js';
import { highestHigh, lowestLow, sma, atr } from '../utils/indicators.js';
import logger from '../utils/logger.js';

class BreakoutStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('Breakout', {
      lookbackPeriod: config.lookbackPeriod || 20,
      minCandles: config.minCandles || 30,
      volumeMultiplier: config.volumeMultiplier || 1.5, // Volume must be X times average
      useATRFilter: config.useATRFilter || true, // Filter false breakouts using ATR
      atrPeriod: config.atrPeriod || 14,
      breakoutBuffer: config.breakoutBuffer || 0.001, // 0.1% buffer above/below level
      ...config,
    });

    this.lastResistance = null;
    this.lastSupport = null;
    this.breakoutLevels = [];
  }

  /**
   * Generate trading signal based on breakout detection
   */
  generateSignal() {
    if (this.candles.length < this.config.minCandles) {
      return null;
    }

    const currentCandle = this.candles[this.candles.length - 1];
    const previousCandle = this.candles[this.candles.length - 2];

    if (!previousCandle) return null;

    // Calculate support and resistance levels
    const resistance = this._calculateResistance();
    const support = this._calculateSupport();

    if (!resistance || !support) return null;

    this.lastResistance = resistance;
    this.lastSupport = support;

    const currentPrice = currentCandle.close;
    const buffer = currentPrice * this.config.breakoutBuffer;

    let signal = null;

    // Check for resistance breakout (BUY)
    if (currentPrice > resistance + buffer && previousCandle.close <= resistance) {
      if (this._confirmBreakout(currentCandle, 'up')) {
        signal = this._createBuySignal(currentPrice, resistance, support);
        logger.info(`${this.name} [${this.symbol}]: BUY signal - Resistance breakout at ${resistance.toFixed(2)}`);
      }
    }
    // Check for support breakdown (SELL)
    else if (currentPrice < support - buffer && previousCandle.close >= support) {
      if (this._confirmBreakout(currentCandle, 'down')) {
        signal = this._createSellSignal(currentPrice, resistance, support);
        logger.info(`${this.name} [${this.symbol}]: SELL signal - Support breakdown at ${support.toFixed(2)}`);
      }
    }

    return signal;
  }

  /**
   * Calculate resistance level (highest high over lookback period)
   */
  _calculateResistance() {
    const recentCandles = this.candles.slice(-this.config.lookbackPeriod);
    if (recentCandles.length < this.config.lookbackPeriod) return null;

    // Find highest high excluding the most recent candle
    const historicalCandles = this.candles.slice(-this.config.lookbackPeriod - 1, -1);
    if (historicalCandles.length === 0) return null;

    return Math.max(...historicalCandles.map(c => c.high));
  }

  /**
   * Calculate support level (lowest low over lookback period)
   */
  _calculateSupport() {
    const recentCandles = this.candles.slice(-this.config.lookbackPeriod);
    if (recentCandles.length < this.config.lookbackPeriod) return null;

    // Find lowest low excluding the most recent candle
    const historicalCandles = this.candles.slice(-this.config.lookbackPeriod - 1, -1);
    if (historicalCandles.length === 0) return null;

    return Math.min(...historicalCandles.map(c => c.low));
  }

  /**
   * Confirm breakout with volume and other filters
   */
  _confirmBreakout(candle, direction) {
    // Volume confirmation
    const avgVolume = this._calculateAverageVolume();
    const volumeConfirmed = candle.volume >= avgVolume * this.config.volumeMultiplier;

    if (!volumeConfirmed) {
      logger.debug(`${this.name} [${this.symbol}]: Breakout failed volume confirmation`);
      return false;
    }

    // ATR filter - ensure breakout has meaningful movement
    if (this.config.useATRFilter) {
      const currentATR = atr(this.candles, this.config.atrPeriod);
      const candleRange = candle.high - candle.low;

      // Breakout candle should have range > ATR
      if (candleRange < currentATR * 0.5) {
        logger.debug(`${this.name} [${this.symbol}]: Breakout failed ATR filter`);
        return false;
      }
    }

    return true;
  }

  /**
   * Calculate average volume
   */
  _calculateAverageVolume(period = 20) {
    const volumes = this.candles.slice(-period).map(c => c.volume);
    if (volumes.length === 0) return 0;
    return sma(volumes, Math.min(period, volumes.length)) || 0;
  }

  /**
   * Create BUY signal
   */
  _createBuySignal(entryPrice, resistance, support) {
    const prices = this.getClosePrices();
    const currentATR = atr(this.candles, this.config.atrPeriod) || entryPrice * 0.02;
    const strength = this._calculateStrength('up');

    return {
      action: 'BUY',
      strength,
      entryPrice,
      stopLoss: parseFloat((resistance - currentATR * 1.5).toFixed(2)),
      target: parseFloat((entryPrice + (resistance - support) * 0.5).toFixed(2)),
      reason: `Breakout: Price broke above resistance at ${resistance.toFixed(2)} with volume confirmation`,
      indicators: {
        resistance,
        support,
        breakoutLevel: resistance,
        volumeConfirmed: true,
      },
    };
  }

  /**
   * Create SELL signal
   */
  _createSellSignal(entryPrice, resistance, support) {
    const prices = this.getClosePrices();
    const currentATR = atr(this.candles, this.config.atrPeriod) || entryPrice * 0.02;
    const strength = this._calculateStrength('down');

    return {
      action: 'SELL',
      strength,
      entryPrice,
      stopLoss: parseFloat((support + currentATR * 1.5).toFixed(2)),
      target: parseFloat((entryPrice - (resistance - support) * 0.5).toFixed(2)),
      reason: `Breakout: Price broke below support at ${support.toFixed(2)} with volume confirmation`,
      indicators: {
        resistance,
        support,
        breakoutLevel: support,
        volumeConfirmed: true,
      },
    };
  }

  /**
   * Calculate signal strength
   */
  _calculateStrength(direction) {
    // Base strength
    let strength = 0.6;

    // Increase strength for multi-touch levels
    const touchCount = this._countLevelTouches(direction === 'up' ? this.lastResistance : this.lastSupport);
    if (touchCount >= 3) strength += 0.2;
    else if (touchCount >= 2) strength += 0.1;

    return Math.min(strength, 1);
  }

  /**
   * Count how many times price touched a level
   */
  _countLevelTouches(level, tolerance = 0.01) {
    if (!level) return 0;

    let count = 0;
    const recentCandles = this.candles.slice(-this.config.lookbackPeriod * 2);

    recentCandles.forEach(candle => {
      if (Math.abs(candle.high - level) / level < tolerance ||
          Math.abs(candle.low - level) / level < tolerance) {
        count++;
      }
    });

    return count;
  }

  /**
   * Override reset
   */
  reset() {
    super.reset();
    this.lastResistance = null;
    this.lastSupport = null;
    this.breakoutLevels = [];
  }

  /**
   * Get additional stats
   */
  getStats() {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      lookbackPeriod: this.config.lookbackPeriod,
      lastResistance: this.lastResistance,
      lastSupport: this.lastSupport,
      volumeMultiplier: this.config.volumeMultiplier,
    };
  }
}

export default BreakoutStrategy;
