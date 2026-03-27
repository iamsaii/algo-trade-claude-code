/**
 * Paper Trading Broker
 * Simulates order execution with realistic slippage and delays
 * Used for testing strategies without real money
 */

import BaseBroker from './baseBroker.js';
import logger from '../utils/logger.js';
import config from '../core/config.js';

class PaperBroker extends BaseBroker {
  constructor(initialBalance = 100000) {
    super('PaperBroker', {
      simulateSlippage: config.get('paperTrading.simulateSlippage'),
      slippagePercent: config.get('paperTrading.slippagePercent'),
      simulateDelay: config.get('paperTrading.simulateDelay'),
      delayMs: config.get('paperTrading.delayMs'),
    });

    this.accountBalance = initialBalance;
    this.initialBalance = initialBalance;
    this.availableMargin = initialBalance;
    this.positions = new Map();
    this.orders = new Map();
    this.orderHistory = [];
    this.connected = true; // Paper broker is always connected

    logger.info('Paper Broker initialized', {
      initialBalance,
      simulateSlippage: this.config.simulateSlippage,
      simulateDelay: this.config.simulateDelay,
    });
  }

  /**
   * Connect to paper broker (always succeeds)
   */
  async connect() {
    logger.info('Paper Broker connected');
    this.connected = true;
    return { success: true, message: 'Connected to paper broker' };
  }

  /**
   * Disconnect from paper broker
   */
  async disconnect() {
    logger.info('Paper Broker disconnected');
    this.connected = false;
    return { success: true };
  }

  /**
   * Place and execute an order
   */
  async placeOrder(order) {
    return new Promise(async (resolve) => {
      // Validate order
      const validation = this.validateOrder(order);
      if (!validation.valid) {
        resolve({
          success: false,
          reason: validation.errors.join(', '),
        });
        return;
      }

      // Check available margin
      const requiredMargin = order.quantity * order.entryPrice;
      if (requiredMargin > this.availableMargin) {
        resolve({
          success: false,
          reason: `Insufficient margin. Required: ${requiredMargin.toFixed(2)}, Available: ${this.availableMargin.toFixed(2)}`,
        });
        return;
      }

      // Simulate delay if configured
      if (this.config.simulateDelay) {
        await new Promise(r => setTimeout(r, this.config.delayMs));
      }

      // Calculate fill price with optional slippage
      let fillPrice = order.entryPrice;
      if (this.config.simulateSlippage) {
        fillPrice = this._applySlippage(order.side, order.entryPrice);
      }

      // Calculate actual quantity based on available margin
      const actualQuantity = order.quantity;
      const totalValue = actualQuantity * fillPrice;

      // Update margin
      this.availableMargin -= totalValue;

      // Update or create position
      this._updatePosition(order.side, order.symbol, fillPrice, actualQuantity);

      // Store order
      const filledOrder = {
        ...order,
        fillPrice,
        quantity: actualQuantity,
        status: 'FILLED',
        filledAt: Date.now(),
      };
      this.orders.set(order.id, filledOrder);
      this.orderHistory.push(filledOrder);

      logger.info('Paper order filled', {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        quantity: actualQuantity,
        fillPrice,
        slippage: ((fillPrice - order.entryPrice) / order.entryPrice * 100).toFixed(3) + '%',
      });

      resolve({
        success: true,
        fillPrice,
        quantity: actualQuantity,
        orderId: order.id,
      });
    });
  }

  /**
   * Apply slippage to order price
   */
  _applySlippage(side, price) {
    const slippagePercent = this.config.slippagePercent;
    const randomSlippage = (Math.random() - 0.5) * 2 * slippagePercent;

    if (side === 'BUY') {
      // Buy orders get slightly worse price (higher)
      return price * (1 + Math.abs(randomSlippage));
    } else {
      // Sell orders get slightly worse price (lower)
      return price * (1 - Math.abs(randomSlippage));
    }
  }

  /**
   * Update position after order fill
   */
  _updatePosition(side, symbol, price, quantity) {
    const existing = this.positions.get(symbol);

    if (side === 'BUY') {
      if (existing && existing.side === 'SELL') {
        // Closing short position
        this._closePosition(symbol, price, quantity, 'SELL');
      } else {
        // Opening or adding to long
        this._addToPosition(symbol, 'BUY', price, quantity);
      }
    } else {
      if (existing && existing.side === 'BUY') {
        // Closing long position
        this._closePosition(symbol, price, quantity, 'BUY');
      } else {
        // Opening or adding to short
        this._addToPosition(symbol, 'SELL', price, quantity);
      }
    }
  }

  /**
   * Add to existing position or create new
   */
  _addToPosition(symbol, side, price, quantity) {
    const existing = this.positions.get(symbol);

    if (existing) {
      const totalValue = existing.quantity * existing.avgPrice + quantity * price;
      const totalQuantity = existing.quantity + quantity;
      existing.avgPrice = totalValue / totalQuantity;
      existing.quantity = totalQuantity;
    } else {
      this.positions.set(symbol, {
        symbol,
        side,
        quantity,
        avgPrice: price,
        currentPrice: price,
        unrealizedPnL: 0,
      });
    }
  }

  /**
   * Close position
   */
  _closePosition(symbol, exitPrice, quantity, closingSide) {
    const position = this.positions.get(symbol);
    if (!position) return;

    const closeQuantity = Math.min(quantity, position.quantity);
    let pnl;

    if (closingSide === 'BUY') {
      // Closing short position
      pnl = (position.avgPrice - exitPrice) * closeQuantity;
    } else {
      // Closing long position
      pnl = (exitPrice - position.avgPrice) * closeQuantity;
    }

    // Update balance with PnL
    this.accountBalance += pnl;
    this.availableMargin += pnl;

    // Update or remove position
    position.quantity -= closeQuantity;
    if (position.quantity <= 0) {
      this.positions.delete(symbol);
    }

    logger.info('Position closed', {
      symbol,
      pnl: pnl.toFixed(2),
      pnlPercent: ((pnl / (position.avgPrice * closeQuantity)) * 100).toFixed(2) + '%',
    });
  }

  /**
   * Cancel an order (paper trading - orders fill instantly so this is mostly no-op)
   */
  async cancelOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) {
      return { success: false, reason: 'Order not found' };
    }

    if (order.status === 'FILLED') {
      return { success: false, reason: 'Order already filled' };
    }

    order.status = 'CANCELLED';
    this.orders.set(orderId, order);

    logger.info('Paper order cancelled', { orderId });
    return { success: true };
  }

  /**
   * Get position for a symbol
   */
  async getPosition(symbol) {
    return this.positions.get(symbol) || null;
  }

  /**
   * Get account balance
   */
  async getAccountBalance() {
    return {
      totalBalance: this.accountBalance,
      availableMargin: this.availableMargin,
      usedMargin: this.initialBalance - this.availableMargin,
      initialBalance: this.initialBalance,
      totalPnL: this.accountBalance - this.initialBalance,
    };
  }

  /**
   * Get all holdings/positions
   */
  async getHoldings() {
    return Array.from(this.positions.values());
  }

  /**
   * Update position prices (for unrealized PnL calculation)
   */
  updatePrices(prices) {
    for (const [symbol, position] of this.positions) {
      const currentPrice = prices[symbol] || position.currentPrice;
      position.currentPrice = currentPrice;

      if (position.side === 'BUY') {
        position.unrealizedPnL = (currentPrice - position.avgPrice) * position.quantity;
      } else {
        position.unrealizedPnL = (position.avgPrice - currentPrice) * position.quantity;
      }
    }
  }

  /**
   * Get all orders
   */
  getOrders() {
    return Array.from(this.orders.values());
  }

  /**
   * Get order history
   */
  getOrderHistory() {
    return this.orderHistory;
  }

  /**
   * Get portfolio summary
   */
  getPortfolio() {
    let totalUnrealizedPnL = 0;
    const positions = Array.from(this.positions.values()).map(p => {
      totalUnrealizedPnL += p.unrealizedPnL;
      return {
        ...p,
        value: p.quantity * p.currentPrice,
        unrealizedPnL: p.unrealizedPnL,
        pnlPercent: ((p.currentPrice - p.avgPrice) / p.avgPrice * 100 * (p.side === 'BUY' ? 1 : -1)).toFixed(2),
      };
    });

    return {
      balance: this.accountBalance,
      availableMargin: this.availableMargin,
      positions,
      totalUnrealizedPnL,
      totalValue: this.accountBalance + totalUnrealizedPnL,
    };
  }

  /**
   * Reset paper trading account
   */
  reset(newBalance = null) {
    this.accountBalance = newBalance || this.initialBalance;
    this.availableMargin = this.accountBalance;
    this.positions.clear();
    this.orders.clear();
    this.orderHistory = [];

    logger.info('Paper trading account reset', {
      balance: this.accountBalance,
    });
  }
}

export default PaperBroker;
