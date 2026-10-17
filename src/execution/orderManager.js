/**
 * Order Manager
 * Handles order lifecycle, the trade journal, and protective exit levels.
 *
 * The broker is authoritative for positions and realized PnL. This class
 * keeps a refreshed mirror of broker positions (positionCache) plus the
 * working state a broker does not own: open orders, protective stop/target
 * levels, and the trade journal.
 *
 * Features:
 * - Order creation, validation, and execution
 * - Broker-authoritative position mirror (syncPositions)
 * - Protective exit levels (stop/target) and exit in-flight guard
 * - Trade journal with realized PnL settled from the broker's fill report
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
    // The broker is authoritative for positions. We keep a mirror
    // (positionCache) refreshed via syncPositions(), plus exchange-agnostic
    // working state: protective exit levels per symbol.
    this.positionCache = [];
    this.exitLevels = new Map(); // symbol -> { stopLoss, target, strategy, entryOrderId, exiting, exitReason }
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
        return await this._fillOrder(orderId, fillResult);
      } else {
        return this._rejectOrder(orderId, fillResult.reason);
      }
    } catch (error) {
      logger.error('Order execution failed', { orderId, error: error.message });
      return this._rejectOrder(orderId, error.message);
    }
  }

  /**
   * Fill an order (called when broker executes). The broker is authoritative
   * for positions and realized PnL; this method mirrors that state and keeps
   * the trade journal and exit levels in step.
   */
  async _fillOrder(orderId, fillResult) {
    const order = this.orders.get(orderId);
    if (!order) return null;

    const fillPrice = fillResult.fillPrice;
    const quantity = fillResult.quantity || order.quantity;
    const effect = {
      action: fillResult.action || 'OPEN',
      realizedPnL: fillResult.realizedPnL || 0,
      closedQuantity: fillResult.closedQuantity || 0,
    };

    order.status = 'FILLED';
    order.fillPrice = fillPrice;
    order.quantity = quantity;
    order.filledAt = Date.now();
    order.action = effect.action;

    // Remove from open orders
    this.openOrders.delete(orderId);

    // Add to history
    this.orderHistory.push(order);

    // Settle the closed slice (if any) against the open trade record.
    let settledTrade = null;
    if (effect.closedQuantity > 0) {
      this._applyRealizedPnL(effect.realizedPnL);
      settledTrade = this._settleOpenTrade(order.symbol, fillPrice, effect, order.reason);
    }

    // Only opening/increasing/flipping fills create or roll a trade record.
    let trade = null;
    let opened = false;
    if (effect.action === 'OPEN' || effect.action === 'ADD' || effect.action === 'FLIP') {
      ({ trade, opened } = this._openTradeRecord(order, fillPrice, effect));
    }

    // Broker is authoritative: refresh the mirror before exposing positions.
    await this.syncPositions();
    this._syncExitLevels(order, opened);

    if (effect.closedQuantity > 0) {
      eventBus.emitSafe('position_closed', {
        tradeId: settledTrade?.id || null,
        symbol: order.symbol,
        quantity: effect.closedQuantity,
        exitPrice: fillPrice,
        pnl: effect.realizedPnL,
      });
    }

    if (opened && trade) {
      this.totalTrades++;
      logger.trade({
        action: order.side,
        symbol: order.symbol,
        quantity: order.quantity,
        entryPrice: fillPrice,
        strategy: order.strategy,
      });
      eventBus.emitSafe('order_filled', {
        ...trade,
        entryPrice: fillPrice,
      });
    } else {
      logger.debug('Fill settled existing position', {
        symbol: order.symbol,
        orderId: order.id,
        action: effect.action,
      });
    }

    return { success: true, order, trade, settled: settledTrade };
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
   * Apply realized PnL from a closing fill to the local summary and stats.
   * The broker has already moved the cash; this keeps the mirror in step.
   */
  _applyRealizedPnL(pnl) {
    this.realizedPnL += pnl;
    if (pnl > 0) this.winningTrades++;
    else if (pnl < 0) this.losingTrades++;
  }

  /**
   * Settle the open trade record for a symbol against a closing fill.
   * A full close closes the record; a partial reduction settles only the
   * closed slice and leaves the remainder open.
   */
  _settleOpenTrade(symbol, exitPrice, effect, reason) {
    const closedQuantity = effect.closedQuantity;
    const openTrade = this.tradeHistory.find(t => t.symbol === symbol && t.status === 'OPEN');
    if (!openTrade) return null;

    if (closedQuantity >= openTrade.quantity) {
      openTrade.exitPrice = exitPrice;
      openTrade.pnl = effect.realizedPnL;
      openTrade.status = 'CLOSED';
      openTrade.closedAt = Date.now();
      openTrade.exitReason = reason ?? openTrade.exitReason ?? null;
      return openTrade;
    }

    // Partial close: settle the closed slice, keep the remainder open.
    const closedSlice = {
      ...openTrade,
      id: `${openTrade.id}-P${this.tradeHistory.length}`,
      quantity: closedQuantity,
      exitPrice,
      pnl: effect.realizedPnL,
      status: 'CLOSED',
      closedAt: Date.now(),
      exitReason: reason ?? null,
    };
    this.tradeHistory.push(closedSlice);
    openTrade.quantity -= closedQuantity;
    return closedSlice;
  }

  /**
   * Maintain exactly one OPEN trade record per open position.
   * Opening creates a record; adding rolls into the existing one.
   */
  _openTradeRecord(order, fillPrice, effect) {
    const symbol = order.symbol;

    if (effect.action === 'ADD') {
      const existing = this.tradeHistory.find(
        t => t.symbol === symbol && t.status === 'OPEN' && t.side === order.side
      );
      if (existing) {
        const totalQuantity = existing.quantity + order.quantity;
        existing.entryPrice =
          (existing.entryPrice * existing.quantity + fillPrice * order.quantity) / totalQuantity;
        existing.quantity = totalQuantity;
        existing.orderId = order.id;
        if (order.stopLoss != null) existing.stopLoss = order.stopLoss;
        if (order.target != null) existing.target = order.target;
        return { trade: existing, opened: false };
      }
    }

    const trade = {
      id: generateOrderId().replace('ORD', 'TRD'),
      orderId: order.id,
      symbol,
      side: order.side,
      quantity: order.quantity,
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
   * Set or clear protective exit levels so they track the broker's positions.
   */
  _syncExitLevels(order, opened) {
    const symbol = order.symbol;

    if (!this.positionCache.some(p => p.symbol === symbol)) {
      this.exitLevels.delete(symbol);
      return;
    }

    if (opened) {
      this.exitLevels.set(symbol, {
        stopLoss: order.stopLoss ?? null,
        target: order.target ?? null,
        strategy: order.strategy || 'unknown',
        entryOrderId: order.id,
        exiting: false,
        exitReason: null,
      });
    }
  }

  /**
   * Refresh the position mirror from the broker (authoritative) and drop any
   * exit levels whose position no longer exists.
   */
  async syncPositions() {
    this.positionCache = await this.broker.getPositions();

    for (const symbol of [...this.exitLevels.keys()]) {
      if (!this.positionCache.some(p => p.symbol === symbol)) {
        this.exitLevels.delete(symbol);
      }
    }

    this._recalculateUnrealizedPnL();
    return this.positionCache;
  }

  /**
   * Merge a broker position with its local protective levels.
   */
  _mergeExitLevel(position) {
    const level = this.exitLevels.get(position.symbol);
    if (!level) return { ...position };

    return {
      ...position,
      stopLoss: level.stopLoss,
      target: level.target,
      strategy: level.strategy,
      orderId: level.entryOrderId,
      exiting: level.exiting,
      exitReason: level.exitReason,
    };
  }

  /**
   * Close a position by sending the opposite order to the broker, so that the
   * broker's cash ledger and the order manager's ledger stay in sync.
   */
  async closePositionViaBroker(symbol, exitPrice, reason = 'Exit') {
    const position = this.getPosition(symbol);
    if (!position || position.exiting) return null;

    // Guard against double-triggering from rapid ticks before the fill lands.
    const level = this.exitLevels.get(symbol);
    if (level) {
      level.exiting = true;
      level.exitReason = reason;
    }

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
      if (level) level.exiting = false;
      return null;
    }

    const result = await this.executeOrder(order.id);
    if (!result || !result.success) {
      // Still open (or not found) - allow a future attempt.
      const stillOpen = this.exitLevels.get(symbol);
      if (stillOpen) stillOpen.exiting = false;
    }
    return result;
  }

  /**
   * Update unrealized PnL for a tick
   */
  _updateUnrealizedPnL(tick) {
    const position = this.positionCache.find(p => p.symbol === tick.symbol);
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
    this.unrealizedPnL = this.positionCache.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
  }

  /**
   * Get current positions (mirror of the broker, with exit levels merged in)
   */
  getPositions() {
    return this.positionCache.map(p => this._mergeExitLevel(p));
  }

  /**
   * Get position for a symbol
   */
  getPosition(symbol) {
    const position = this.positionCache.find(p => p.symbol === symbol);
    return position ? this._mergeExitLevel(position) : null;
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
      openPositions: this.positionCache.length,
      openOrders: this.openOrders.size,
    };
  }

  /**
   * Close all positions (for shutdown)
   */
  async closeAllPositions(currentPrices) {
    const results = [];

    // Snapshot the mirror first: closing mutates it via syncPositions().
    const open = this.getPositions();

    for (const position of open) {
      const price = currentPrices[position.symbol] || position.currentPrice;
      const result = await this.closePositionViaBroker(position.symbol, price, 'Shutdown');
      if (result?.success) {
        results.push({ symbol: position.symbol, pnl: result?.settled?.pnl ?? 0 });
      }
    }

    return results;
  }
}

export default OrderManager;
