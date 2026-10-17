/**
 * Market Data Stream
 * Simulates live market ticks with realistic price movement
 * Can be replaced with real WebSocket feeds for live trading
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import config from '../core/config.js';

class MarketStream extends EventEmitter {
  constructor() {
    super();
    this.symbols = config.get('market.symbols');
    this.tickInterval = config.get('market.tickIntervalMs');
    this.isRunning = false;
    this.currentPrices = new Map();
    this.priceHistory = new Map();
    this.tickCount = 0;

    // Initialize price history for each symbol
    this.symbols.forEach(symbol => {
      this.priceHistory.set(symbol, []);
    });
  }

  /**
   * Initialize with starting prices
   */
  initialize(startingPrices) {
    // Re-read config so overrides applied after import are honoured.
    this.symbols = config.get('market.symbols');
    this.tickInterval = config.get('market.tickIntervalMs');

    this.symbols.forEach(symbol => {
      const basePrice = startingPrices[symbol] || this._getDefaultPrice(symbol);
      this.currentPrices.set(symbol, {
        price: basePrice,
        timestamp: Date.now(),
        volume: 0,
      });
      this.priceHistory.set(symbol, []);
    });
    logger.info('Market stream initialized', { symbols: this.symbols });
  }

  /**
   * Get default starting price for a symbol
   */
  _getDefaultPrice(symbol) {
    const basePrices = {
      'RELIANCE': 2500,
      'INFY': 1500,
      'HDFCBANK': 1600,
      'TCS': 3800,
      'ICICIBANK': 1000,
    };
    return basePrices[symbol] || 1000;
  }

  /**
   * Generate realistic price movement using geometric Brownian motion
   */
  _generateNextPrice(currentPrice) {
    const volatility = 0.0002; // Per-tick volatility
    const drift = 0.00001; // Slight upward drift

    // Random component (normal distribution approximation)
    const u1 = Math.random();
    const u2 = Math.random();
    const random = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    // Calculate next price
    const change = currentPrice * (drift + volatility * random);
    let newPrice = currentPrice + change;

    // Ensure price doesn't go negative
    newPrice = Math.max(newPrice, currentPrice * 0.99);

    return parseFloat(newPrice.toFixed(2));
  }

  /**
   * Generate a single tick for a symbol
   */
  _generateTick(symbol) {
    const current = this.currentPrices.get(symbol);
    if (!current) return null;

    const newPrice = this._generateNextPrice(current.price);
    const volume = Math.floor(Math.random() * 1000) + 100;

    const tick = {
      symbol,
      price: newPrice,
      previousPrice: current.price,
      change: newPrice - current.price,
      changePercent: ((newPrice - current.price) / current.price) * 100,
      volume,
      timestamp: Date.now(),
    };

    // Update current price
    this.currentPrices.set(symbol, {
      price: newPrice,
      timestamp: tick.timestamp,
      volume,
    });

    // Store in history
    const history = this.priceHistory.get(symbol) || [];
    history.push({ price: newPrice, timestamp: tick.timestamp });
    if (history.length > 10000) history.shift(); // Keep last 10000 ticks
    this.priceHistory.set(symbol, history);

    return tick;
  }

  /**
   * Start the market data stream
   */
  start() {
    if (this.isRunning) {
      logger.warn('Market stream already running');
      return;
    }

    this.isRunning = true;
    logger.info('Market stream started');

    // Generate ticks at configured interval
    this._intervalId = setInterval(() => {
      this.symbols.forEach(symbol => {
        const tick = this._generateTick(symbol);
        if (tick) {
          this.tickCount++;
          this.emit('tick', tick);
          this.emit(`tick:${symbol}`, tick);
        }
      });
    }, this.tickInterval);
  }

  /**
   * Stop the market data stream
   */
  stop() {
    if (!this.isRunning) return;

    clearInterval(this._intervalId);
    this.isRunning = false;
    logger.info('Market stream stopped', { totalTicks: this.tickCount });
  }

  /**
   * Get current price for a symbol
   */
  getCurrentPrice(symbol) {
    return this.currentPrices.get(symbol);
  }

  /**
   * Get current prices for all symbols
   */
  getAllPrices() {
    const prices = {};
    this.symbols.forEach(symbol => {
      const data = this.currentPrices.get(symbol);
      if (data) {
        prices[symbol] = data.price;
      }
    });
    return prices;
  }

  /**
   * Get price history for a symbol
   */
  getPriceHistory(symbol, limit = 100) {
    const history = this.priceHistory.get(symbol) || [];
    return history.slice(-limit);
  }

  /**
   * Get statistics for a symbol
   */
  getStats(symbol) {
    const history = this.priceHistory.get(symbol) || [];
    if (history.length === 0) return null;

    const prices = history.map(h => h.price);
    return {
      symbol,
      currentPrice: prices[prices.length - 1],
      high: Math.max(...prices),
      low: Math.min(...prices),
      avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
      tickCount: history.length,
    };
  }
}

// Singleton export
export const marketStream = new MarketStream();
export default marketStream;
