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

    this.accountBalance = initialBalance; // Realized cash equity (initial + realized PnL)
    this.initialBalance = initialBalance;
    this.availableMargin = initialBalance; // Free cash available for new positions
    this.usedMargin = 0; // Notional reserved by open positions
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
    // Validate order
    const validation = this.validateOrder(order);
    if (!validation.valid) {
      return { success: false, reason: validation.errors.join(', ') };
    }

    // Margin is only required when opening/increasing a position, never when reducing it.
    const isOpening = this._isOpeningOrder(order.side, order.symbol);
    if (isOpening) {
      const requiredMargin = order.quantity * order.entryPrice;
      if (requiredMargin > this.availableMargin) {
        return {
          success: false,
          reason: `Insufficient margin. Required: ${requiredMargin.toFixed(2)}, Available: ${this.availableMargin.toFixed(2)}`,
        };
      }
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

    const actualQuantity = order.quantity;

    // Update position + margin/balance. This is where cash actually moves.
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

    return {
      success: true,
      fillPrice,
      quantity: actualQuantity,
      orderId: order.id,
    };
  }

  /**
   * An order opens/increases exposure when there is no position, or the order
   * is on the same side as the existing position. Opposite-side orders reduce.
   */
  _isOpeningOrder(side, symbol) {
    const existing = this.positions.get(symbol);
    return !existing || existing.side === side;
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
   * Update position after an order fill. Routes to open (add) or close based
   * on the incoming side versus any existing position, and handles flips.
   */
  _updatePosition(side, symbol, price, quantity) {
    const existing = this.positions.get(symbol);

    if (existing && existing.side !== side) {
      // Opposite side -> reduce/close, then open the remainder (if any).
      const closed = this._closePosition(symbol, price, quantity);
      const remainder = quantity - (closed?.quantity || 0);
      if (remainder > 0) {
        this._addToPosition(symbol, side, price, remainder);
      }
      return;
    }

    this._addToPosition(symbol, side, price, quantity);
  }

  /**
   * Add to existing position or create new. Reserves notional margin.
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

    // Reserve cash for the newly opened notional.
    const notional = price * quantity;
    this.usedMargin += notional;
    this.availableMargin -= notional;

    return { action: 'OPENED', symbol, side, price, quantity };
  }

  /**
   * Reduce/close a position. Releases the reserved notional plus realized PnL
   * back to available cash. PnL is always derived from the position's own side.
   */
  _closePosition(symbol, exitPrice, quantity) {
    const position = this.positions.get(symbol);
    if (!position) return null;

    const closeQuantity = Math.min(quantity, position.quantity);
    const entryNotional = position.avgPrice * closeQuantity;

    const pnl = position.side === 'BUY'
      ? (exitPrice - position.avgPrice) * closeQuantity
      : (position.avgPrice - exitPrice) * closeQuantity;

    // Cash movements: return the reserved notional and add the realized PnL.
    this.accountBalance += pnl;
    this.usedMargin -= entryNotional;
    this.availableMargin += entryNotional + pnl;

    // Update or remove position
    position.quantity -= closeQuantity;
    if (position.quantity <= 0) {
      this.positions.delete(symbol);
    }

    logger.info('Position closed', {
      symbol,
      side: position.side,
      quantity: closeQuantity,
      exitPrice,
      pnl: pnl.toFixed(2),
      pnlPercent: ((pnl / entryNotional) * 100).toFixed(2) + '%',
    });

    return { action: 'CLOSED', symbol, side: position.side, exitPrice, quantity: closeQuantity, pnl };
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
      usedMargin: this.usedMargin,
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
    this.usedMargin = 0;
    this.positions.clear();
    this.orders.clear();
    this.orderHistory = [];

    logger.info('Paper trading account reset', {
      balance: this.accountBalance,
    });
  }
}

export default PaperBroker;
