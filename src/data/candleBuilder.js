/**
 * Candle Builder
 * Aggregates ticks into OHLC candles at configured intervals
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import config from '../core/config.js';
import { marketStream } from './marketStream.js';

class CandleBuilder extends EventEmitter {
  constructor() {
    super();
    this.candleIntervalMs = config.get('market.candleIntervalMinutes') * 60 * 1000;
    this.symbols = config.get('market.symbols');
    this.currentCandles = new Map();
    this.completedCandles = new Map();
    this.isRunning = false;

    // Initialize candle storage for each symbol
    this.symbols.forEach(symbol => {
      this.completedCandles.set(symbol, []);
    });
  }

  /**
   * Initialize with starting prices
   */
  initialize(startingPrices) {
    // Re-read config so overrides applied after import are honoured.
    this.symbols = config.get('market.symbols');
    this.candleIntervalMs = config.get('market.candleIntervalMinutes') * 60 * 1000;

    this.symbols.forEach(symbol => {
      const price = startingPrices[symbol];
      this.currentCandles.set(symbol, this._createCandle(symbol, price));
      this.completedCandles.set(symbol, []);
    });
    logger.info('Candle builder initialized');
  }

  /**
   * Create a new candle object
   */
  _createCandle(symbol, firstPrice) {
    const now = Date.now();
    return {
      symbol,
      open: firstPrice,
      high: firstPrice,
      low: firstPrice,
      close: firstPrice,
      volume: 0,
      timestamp: now,
      startTime: now,
      endTime: now + this.candleIntervalMs,
    };
  }

  /**
   * Process a tick and update current candle
   */
  processTick(tick) {
    const { symbol, price, volume } = tick;
    let candle = this.currentCandles.get(symbol);

    if (!candle) {
      candle = this._createCandle(symbol, price);
      this.currentCandles.set(symbol, candle);
    }

    // Update candle
    candle.close = price;
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.volume += volume;
    candle.timestamp = tick.timestamp;
  }

  /**
   * Close current candle and start new one
   */
  _closeCandle(symbol) {
    const candle = this.currentCandles.get(symbol);
    if (!candle) return;

    // Mark candle as complete
    candle.isComplete = true;

    // Store in history
    const history = this.completedCandles.get(symbol) || [];
    history.push(candle);

    // Keep last 1000 candles per symbol
    if (history.length > 1000) {
      history.shift();
    }
    this.completedCandles.set(symbol, history);

    // Emit candle closed event
    this.emit('candle', candle);
    this.emit(`candle:${symbol}`, candle);

    logger.debug('Candle closed', {
      symbol,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    });

    return candle;
  }

  /**
   * Start building candles from market stream
   */
  start() {
    if (this.isRunning) {
      logger.warn('Candle builder already running');
      return;
    }

    this.isRunning = true;

    // Listen to market ticks
    marketStream.on('tick', (tick) => {
      this.processTick(tick);
    });

    // Close candles at intervals
    this._intervalId = setInterval(() => {
      this.symbols.forEach(symbol => {
        this._closeCandle(symbol);

        // Start new candle with last close price
        const lastCandle = this.completedCandles.get(symbol)?.slice(-1)[0];
        if (lastCandle) {
          const newCandle = this._createCandle(symbol, lastCandle.close);
          this.currentCandles.set(symbol, newCandle);
        }
      });
    }, this.candleIntervalMs);

    logger.info('Candle builder started', { interval: `${this.candleIntervalMs / 1000}s` });
  }

  /**
   * Stop building candles
   */
  stop() {
    if (!this.isRunning) return;

    clearInterval(this._intervalId);
    this.isRunning = false;
    logger.info('Candle builder stopped');
  }

  /**
   * Get current (incomplete) candle for a symbol
   */
  getCurrentCandle(symbol) {
    return this.currentCandles.get(symbol);
  }

  /**
   * Get completed candles for a symbol
   */
  getCandles(symbol, limit = 100) {
    const history = this.completedCandles.get(symbol) || [];
    return history.slice(-limit);
  }

  /**
   * Get all completed candles for all symbols
   */
  getAllCandles(limit = 100) {
    const result = {};
    this.symbols.forEach(symbol => {
      result[symbol] = this.getCandles(symbol, limit);
    });
    return result;
  }

  /**
   * Get OHLC array for a symbol (useful for indicators)
   */
  getOHLC(symbol, limit = 100) {
    const candles = this.getCandles(symbol, limit);
    return {
      open: candles.map(c => c.open),
      high: candles.map(c => c.high),
      low: candles.map(c => c.low),
      close: candles.map(c => c.close),
      volume: candles.map(c => c.volume),
    };
  }

  /**
   * Get latest close prices for all symbols
   */
  getLatestCloses() {
    const closes = {};
    this.symbols.forEach(symbol => {
      const candles = this.completedCandles.get(symbol);
      if (candles && candles.length > 0) {
        closes[symbol] = candles[candles.length - 1].close;
      }
    });
    return closes;
  }
}

// Singleton export
export const candleBuilder = new CandleBuilder();
export default candleBuilder;
