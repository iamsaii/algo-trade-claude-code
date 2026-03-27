/**
 * Base Strategy Class
 * Abstract class that all strategies must extend
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

class BaseStrategy extends EventEmitter {
  constructor(name, config = {}) {
    super();
    this.name = name;
    this.config = config;
    this.enabled = true;
    this.symbol = null;
    this.candles = [];
    this.lastSignal = null;
    this.signalCount = 0;
  }

  /**
   * Initialize strategy with symbol and initial data
   */
  initialize(symbol, initialCandles = []) {
    this.symbol = symbol;
    this.candles = [...initialCandles];
    logger.debug(`Strategy ${this.name} initialized for ${symbol}`, {
      candlesLoaded: this.candles.length,
    });
  }

  /**
   * Process a new candle - must be implemented by subclass
   */
  onCandle(candle) {
    if (!this.enabled) return null;

    // Add candle to history
    this.candles.push(candle);

    // Limit history size
    const maxHistory = this.config.maxHistory || 500;
    if (this.candles.length > maxHistory) {
      this.candles.shift();
    }

    // Generate signal based on new data
    const signal = this.generateSignal();

    if (signal) {
      this.lastSignal = signal;
      this.signalCount++;
      this.emit('signal', signal);
    }

    return signal;
  }

  /**
   * Generate trading signal - must be implemented by subclass
   * Returns: { action, strength, stopLoss, target, reason }
   */
  generateSignal() {
    throw new Error('generateSignal() must be implemented by subclass');
  }

  /**
   * Get strategy name
   */
  getName() {
    return this.name;
  }

  /**
   * Enable/disable strategy
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    logger.info(`Strategy ${this.name} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get current position recommendation
   */
  getPosition() {
    if (!this.lastSignal) return 'FLAT';
    return this.lastSignal.action;
  }

  /**
   * Get strategy statistics
   */
  getStats() {
    return {
      name: this.name,
      symbol: this.symbol,
      enabled: this.enabled,
      candlesLoaded: this.candles.length,
      signalCount: this.signalCount,
      lastSignal: this.lastSignal,
    };
  }

  /**
   * Reset strategy state
   */
  reset() {
    this.candles = [];
    this.lastSignal = null;
    this.signalCount = 0;
  }

  /**
   * Get closing prices array (helper for indicators)
   */
  getClosePrices() {
    return this.candles.map(c => c.close);
  }

  /**
   * Get OHLC data (helper for indicators)
   */
  getOHLC() {
    return {
      open: this.candles.map(c => c.open),
      high: this.candles.map(c => c.high),
      low: this.candles.map(c => c.low),
      close: this.candles.map(c => c.close),
      volume: this.candles.map(c => c.volume),
    };
  }

  /**
   * Calculate risk-reward ratio for a signal
   */
  calculateRiskReward(signal) {
    if (!signal || !signal.entryPrice) return null;

    const risk = Math.abs(signal.entryPrice - signal.stopLoss);
    const reward = Math.abs(signal.target - signal.entryPrice);

    if (risk === 0) return null;

    return {
      risk,
      reward,
      ratio: reward / risk,
    };
  }
}

export default BaseStrategy;
