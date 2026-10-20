/**
 * Position Monitor
 * Watches incoming market ticks and closes open positions when their
 * protective stop-loss / target levels are hit.
 *
 * This is the exit lifecycle that was previously missing: without it, paper
 * and live positions could only ever be closed at shutdown. Closes are routed
 * back through the OrderManager -> broker, so both ledgers stay in sync.
 */

import logger from '../utils/logger.js';
import { eventBus } from '../core/eventBus.js';

class PositionMonitor {
  constructor(orderManager) {
    this.orderManager = orderManager;
    this.started = false;
    this.triggered = 0;
    this._onTick = this._onTick.bind(this);
  }

  /**
   * Subscribe to market ticks on the central event bus.
   */
  start() {
    if (this.started) return;
    this.started = true;
    eventBus.on('market_tick', this._onTick);
    logger.debug('Position monitor started');
  }

  /**
   * Unsubscribe (idempotent).
   */
  stop() {
    if (!this.started) return;
    this.started = false;
    eventBus.off('market_tick', this._onTick);
    logger.debug('Position monitor stopped');
  }

  /**
   * Evaluate a single tick against open positions.
   * @param {{symbol:string, price:number}} tick
   */
  _onTick(tick) {
    if (!tick || typeof tick.price !== 'number') return;

    const position = this.orderManager?.getPosition(tick.symbol);
    if (!position || position.exiting) return;

    const { side, stopLoss, target } = position;
    let exitPrice = null;
    let reason = null;

    if (side === 'BUY') {
      // Stop-loss takes precedence: check it first.
      if (stopLoss != null && tick.price <= stopLoss) {
        exitPrice = stopLoss;
        reason = 'Stop Loss';
      } else if (target != null && tick.price >= target) {
        exitPrice = target;
        reason = 'Target';
      }
    } else {
      if (stopLoss != null && tick.price >= stopLoss) {
        exitPrice = stopLoss;
        reason = 'Stop Loss';
      } else if (target != null && tick.price <= target) {
        exitPrice = target;
        reason = 'Target';
      }
    }

    if (reason === null) return;

    this.triggered++;
    logger.info(`Position monitor: closing ${tick.symbol} (${reason})`, {
      side,
      qty: position.quantity,
      exitPrice,
      currentPrice: tick.price,
    });

    // Fire-and-forget; the OrderManager guards against double-triggering.
    Promise.resolve(
      this.orderManager.closePositionViaBroker(tick.symbol, exitPrice, reason)
    ).catch((error) => {
      logger.error('Position monitor close failed', {
        symbol: tick.symbol,
        error: error.message,
      });
    });
  }

  getStats() {
    return { started: this.started, triggered: this.triggered };
  }
}

export default PositionMonitor;
