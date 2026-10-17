/**
 * Base Broker Interface
 * Abstract class defining the broker interface
 * All broker implementations must extend this class
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

class BaseBroker extends EventEmitter {
  constructor(name, config = {}) {
    super();
    this.name = name;
    this.config = config;
    this.connected = false;
    this.accountBalance = null;
    this.positions = [];
    this.orders = [];
  }

  /**
   * Connect to broker API - must be implemented by subclass
   */
  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from broker API - must be implemented by subclass
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Place an order - must be implemented by subclass
   */
  async placeOrder(order) {
    throw new Error('placeOrder() must be implemented by subclass');
  }

  /**
   * Cancel an order - must be implemented by subclass
   */
  async cancelOrder(orderId) {
    throw new Error('cancelOrder() must be implemented by subclass');
  }

  /**
   * Get all open positions - must be implemented by subclass.
   * Contract: returns NormalizedPosition[] where each is
   *   { symbol, side:'BUY'|'SELL', quantity, avgPrice, currentPrice, unrealizedPnL }
   * Flat rows (quantity <= 0) must be omitted.
   */
  async getPositions() {
    throw new Error('getPositions() must be implemented by subclass');
  }

  /**
   * Get current position for a symbol - must be implemented by subclass.
   * Returns the normalized shape above, or null when flat.
   */
  async getPosition(symbol) {
    throw new Error('getPosition() must be implemented by subclass');
  }

  /**
   * Get account balance - must be implemented by subclass
   */
  async getAccountBalance() {
    throw new Error('getAccountBalance() must be implemented by subclass');
  }

  /**
   * Get all holdings - must be implemented by subclass
   */
  async getHoldings() {
    throw new Error('getHoldings() must be implemented by subclass');
  }

  /**
   * Check if broker is connected
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Validate order before sending
   */
  validateOrder(order) {
    const errors = [];

    if (!order.symbol) errors.push('Symbol is required');
    if (!order.side || !['BUY', 'SELL'].includes(order.side)) {
      errors.push('Side must be BUY or SELL');
    }
    if (!order.quantity || order.quantity <= 0) {
      errors.push('Quantity must be positive');
    }
    if (!order.entryPrice || order.entryPrice <= 0) {
      errors.push('Price must be positive');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get broker status
   */
  getStatus() {
    return {
      name: this.name,
      connected: this.connected,
      hasPositions: this.positions.length > 0,
      pendingOrders: this.orders.filter(o => o.status === 'PENDING').length,
    };
  }
}

export default BaseBroker;
