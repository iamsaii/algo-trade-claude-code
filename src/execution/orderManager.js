/**
 * Order Manager
 * Handles order lifecycle, position tracking, and PnL calculation
 *
 * Features:
 * - Order creation and validation
 * - Position tracking per symbol
 * - Real-time PnL calculation
 * - Order history
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import config from '../core/config.js';
import { eventBus } from '../core/eventBus.js';

// Simple ID generator
let orderCounter = 0;
function generateOrderId() {
  orderCounter++;
  return `ORD-${Date.now()}-${orderCounter}`;
}

// UUID generator for trade IDs
function generateTradeId() {
  return `TRD-${randomUUID().split('-')[0]}-${Date.now()}`;
}

class OrderManager extends EventEmitter {
  constructor(broker) {
    super();
    this.broker = broker;
    this.orders = new Map(); // All orders by ID
    this.openOrders = new Map(); // Pending orders
    this.positions = new Map(); // Current positions by symbol
    this.orderHistory = []; // Completed orders
    this.tradeHistory = []; // Executed trades

    // PnL tracking
    this.realizedPnL = 0;
    this.unrealizedPnL = 0;
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;

    this._setupEventListeners();
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    // Listen for market ticks to update unrealized PnL
    eventBus.on('market_tick', (tick) => {
      this._updateUnrealizedPnL(tick);
    });
  }

  /**
   * Create a new order from a signal
   */
  createOrder(signal, quantity, riskApproved = true) {
    const orderId = generateOrderId();

    const order = {
      id: orderId,
      symbol: signal.symbol,
      side: signal.action, // BUY or SELL
      type: 'MARKET', // Default to market order
      quantity,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      target: signal.target,
      strategy: signal.strategy || 'unknown',
      status: 'PENDING',
      createdAt: Date.now(),
      filledAt: null,
      fillPrice: null,
      riskApproved,
    };

    this.orders.set(orderId, order);
    this.openOrders.set(orderId, order);

    logger.info('Order created', {
      orderId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      entryPrice: order.entryPrice,
    });

    // Emit order created event
    eventBus.emitSafe('order_created', order);

    return order;
  }

  /**
   * Execute an order (send to broker)
   */
  async executeOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) {
      logger.error('Order not found', { orderId });
      return null;
    }

    if (order.status !== 'PENDING') {
      logger.warn('Order not in PENDING state', { orderId, status: order.status });
      return null;
    }

    // Update status
    order.status = 'SUBMITTED';
    this.orders.set(orderId, order);

    logger.info('Order submitted to broker', { orderId });
    eventBus.emitSafe('order_placed', order);

    // Send to broker for execution
    try {
      const fillResult = await this.broker.placeOrder(order);

      if (fillResult.success) {
        return this._fillOrder(orderId, fillResult.fillPrice, fillResult.quantity || order.quantity);
      } else {
        return this._rejectOrder(orderId, fillResult.reason);
      }
    } catch (error) {
      logger.error('Order execution failed', { orderId, error: error.message });
      return this._rejectOrder(orderId, error.message);
    }
  }

  /**
   * Fill an order (called when broker executes)
   */
  _fillOrder(orderId, fillPrice, quantity) {
    const order = this.orders.get(orderId);
    if (!order) return null;

    order.status = 'FILLED';
    order.fillPrice = fillPrice;
    order.quantity = quantity;
    order.filledAt = Date.now();

    // Remove from open orders
    this.openOrders.delete(orderId);

    // Add to history
    this.orderHistory.push(order);

    // Update position (a closing fill settles the existing trade record).
    const update = this._updatePosition(order);

    // Maintain exactly one OPEN trade record per open position.
    const { trade, opened } = this._recordFill(order, fillPrice, quantity, update);

    if (trade) {
      logger.trade({
        action: order.side,
        symbol: order.symbol,
        quantity: order.quantity,
        entryPrice: fillPrice,
        strategy: order.strategy,
      });
    } else {
      logger.debug('Closing fill settled existing position', {
        symbol: order.symbol,
        orderId: order.id,
      });
    }

    // Emit only for newly opened positions; closes emit position_closed.
    if (opened && trade) {
      this.totalTrades++;
      eventBus.emitSafe('order_filled', {
        ...trade,
        entryPrice: fillPrice,
      });
    }

    return { success: true, order, trade };
  }

  /**
   * Reject an order
   */
  _rejectOrder(orderId, reason) {
    const order = this.orders.get(orderId);
    if (!order) return null;

    order.status = 'REJECTED';
    order.rejectionReason = reason;

    this.openOrders.delete(orderId);
    this.orderHistory.push(order);

    logger.warn('Order rejected', { orderId, reason });
    eventBus.emitSafe('order_rejected', { orderId, reason });

    return { success: false, reason };
  }

  /**
   * Update position after order fill
   */
  _updatePosition(order) {
    const existing = this.positions.get(order.symbol);

    if (existing && existing.side !== order.side) {
      // Opposite side -> reduce/close, then open the remainder (if any).
      if (order.reason) existing.exitReason = order.reason;
      const closed = this._closePosition(order.symbol, order.fillPrice, order.quantity);
      const remainder = order.quantity - (closed?.quantity || 0);
      let opened = false;
      if (remainder > 0) {
        this._openOrAddPosition(order.symbol, order.side, order.fillPrice, remainder, order);
        opened = true;
      }
      return { closed: !!closed, opened };
    }

    this._openOrAddPosition(order.symbol, order.side, order.fillPrice, order.quantity, order);
    return { closed: false, opened: true };
  }

  /**
   * Maintain exactly one OPEN trade record per open position.
   * A pure closing fill has no new trade record (the close event settles it).
   * Returns { trade, opened } - trade is null for a pure close.
   */
  _recordFill(order, fillPrice, quantity, update = {}) {
    const symbol = order.symbol;

    if (update.closed && !update.opened) {
      return { trade: null, opened: false };
    }

    const existing = this.tradeHistory.find(t => t.symbol === symbol && t.status === 'OPEN');

    if (existing && existing.side === order.side) {
      // Increase: roll into the existing open trade instead of duplicating it.
      const totalQuantity = existing.quantity + quantity;
      existing.entryPrice = (existing.entryPrice * existing.quantity + fillPrice * quantity) / totalQuantity;
      existing.quantity = totalQuantity;
      existing.orderId = order.id;
      if (order.stopLoss != null) existing.stopLoss = order.stopLoss;
      if (order.target != null) existing.target = order.target;
      return { trade: existing, opened: false };
    }

    const trade = {
      id: generateOrderId().replace('ORD', 'TRD'),
      orderId: order.id,
      symbol,
      side: order.side,
      quantity,
      entryPrice: fillPrice,
      exitPrice: null,
      stopLoss: order.stopLoss,
      target: order.target,
      strategy: order.strategy,
      pnl: 0,
      status: 'OPEN',
      timestamp: Date.now(),
    };
    this.tradeHistory.push(trade);
    return { trade, opened: true };
  }

  /**
   * Open or add to position
   */
  _openOrAddPosition(symbol, side, price, quantity, order = {}) {
    const existing = this.positions.get(symbol);

    if (existing) {
      // Add to position (average price)
      const totalValue = existing.quantity * existing.avgPrice + quantity * price;
      const totalQuantity = existing.quantity + quantity;
      existing.avgPrice = totalValue / totalQuantity;
      existing.quantity = totalQuantity;
      if (order.id) existing.orderId = order.id;
      if (order.stopLoss != null) existing.stopLoss = order.stopLoss;
      if (order.target != null) existing.target = order.target;
    } else {
      // New position - keep the protective levels and metadata so the
      // position monitor and exits can act on it later.
      this.positions.set(symbol, {
        symbol,
        side,
        quantity,
        avgPrice: price,
        currentPrice: price,
        unrealizedPnL: 0,
        openedAt: Date.now(),
        orderId: order.id || null,
        stopLoss: order.stopLoss ?? null,
        target: order.target ?? null,
        strategy: order.strategy || 'unknown',
        exiting: false,
      });
    }

    this._recalculateUnrealizedPnL();
  }

  /**
   * Close position (partially or fully)
   */
  _closePosition(symbol, exitPrice, closeQuantity) {
    const position = this.positions.get(symbol);
    if (!position) return null;

    const quantityToClose = Math.min(closeQuantity, position.quantity);
    let pnl;

    if (position.side === 'BUY') {
      pnl = (exitPrice - position.avgPrice) * quantityToClose;
    } else {
      pnl = (position.avgPrice - exitPrice) * quantityToClose;
    }

    // Update realized PnL
    this.realizedPnL += pnl;

    // Update trade stats
    if (pnl > 0) this.winningTrades++;
    else if (pnl < 0) this.losingTrades++;

    // Update or remove position
    position.quantity -= quantityToClose;
    if (position.quantity <= 0) {
      this.positions.delete(symbol);
    }

    // Match this close to the open trade it belongs to (by originating order first).
    const openTrade = this.tradeHistory.find(t =>
      t.status === 'OPEN' &&
      (position.orderId ? t.orderId === position.orderId : t.symbol === symbol)
    ) || this.tradeHistory.find(t => t.symbol === symbol && t.status === 'OPEN');

    if (openTrade) {
      openTrade.exitPrice = exitPrice;
      openTrade.pnl = pnl;
      openTrade.status = 'CLOSED';
      openTrade.closedAt = Date.now();
      openTrade.exitReason = position.exitReason;
    }

    logger.info('Position closed', {
      symbol,
      quantity: quantityToClose,
      exitPrice,
      pnl,
    });

    // Emit event - includes tradeId so the risk manager can settle correctly.
    eventBus.emitSafe('position_closed', {
      tradeId: openTrade?.id || null,
      symbol,
      quantity: quantityToClose,
      exitPrice,
      pnl,
    });

    return { pnl, quantity: quantityToClose };
  }

  /**
   * Close a position by sending the opposite order to the broker, so that the
   * broker's cash ledger and the order manager's ledger stay in sync.
   */
  async closePositionViaBroker(symbol, exitPrice, reason = 'Exit') {
    const position = this.positions.get(symbol);
    if (!position || position.exiting) return null;

    // Guard against double-triggering from rapid ticks before the fill lands.
    position.exiting = true;
    position.exitReason = reason;

    const signal = {
      symbol,
      action: position.side === 'BUY' ? 'SELL' : 'BUY',
      entryPrice: exitPrice,
      stopLoss: exitPrice,
      target: exitPrice,
      strategy: position.strategy || 'Exit',
      reason,
    };

    const order = this.createOrder(signal, position.quantity);
    if (!order) {
      position.exiting = false;
      return null;
    }

    const result = await this.executeOrder(order.id);
    if (!result || !result.success) {
      // Still open (or not found) - allow a future attempt.
      const stillOpen = this.positions.get(symbol);
      if (stillOpen) stillOpen.exiting = false;
    }
    return result;
  }

  /**
   * Update unrealized PnL for a tick
   */
  _updateUnrealizedPnL(tick) {
    const position = this.positions.get(tick.symbol);
    if (!position) return;

    position.currentPrice = tick.price;

    if (position.side === 'BUY') {
      position.unrealizedPnL = (tick.price - position.avgPrice) * position.quantity;
    } else {
      position.unrealizedPnL = (position.avgPrice - tick.price) * position.quantity;
    }

    this._recalculateUnrealizedPnL();
  }

  /**
   * Recalculate total unrealized PnL
   */
  _recalculateUnrealizedPnL() {
    this.unrealizedPnL = 0;
    for (const position of this.positions.values()) {
      this.unrealizedPnL += position.unrealizedPnL;
    }
  }

  /**
   * Get current positions
   */
  getPositions() {
    return Array.from(this.positions.values());
  }

  /**
   * Get position for a symbol
   */
  getPosition(symbol) {
    return this.positions.get(symbol);
  }

  /**
   * Get open orders
   */
  getOpenOrders() {
    return Array.from(this.openOrders.values());
  }

  /**
   * Get trade history
   */
  getTradeHistory(limit = 100) {
    return this.tradeHistory.slice(-limit);
  }

  /**
   * Get PnL summary
   */
  getPnL() {
    return {
      realized: this.realizedPnL,
      unrealized: this.unrealizedPnL,
      total: this.realizedPnL + this.unrealizedPnL,
    };
  }

  /**
   * Get statistics
   */
  getStats() {
    const closedTrades = this.winningTrades + this.losingTrades;
    const winRate = closedTrades > 0
      ? (this.winningTrades / closedTrades) * 100
      : 0;

    return {
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      winRate: winRate.toFixed(2),
      realizedPnL: this.realizedPnL,
      unrealizedPnL: this.unrealizedPnL,
      totalPnL: this.realizedPnL + this.unrealizedPnL,
      openPositions: this.positions.size,
      openOrders: this.openOrders.size,
    };
  }

  /**
   * Close all positions (for shutdown)
   */
  async closeAllPositions(currentPrices) {
    const results = [];

    // Snapshot keys: closing mutates this.positions.
    for (const [symbol, position] of [...this.positions]) {
      const price = currentPrices[symbol] || position.currentPrice;
      const result = await this.closePositionViaBroker(symbol, price, 'Shutdown');
      if (result?.success) {
        results.push({ symbol, pnl: result?.trade?.pnl ?? 0 });
      }
    }

    return results;
  }
}

export default OrderManager;
