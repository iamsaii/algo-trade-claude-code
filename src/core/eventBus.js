/**
 * Event Bus - Central Event Dispatcher
 * Uses Node.js native EventEmitter for inter-module communication
 *
 * Events:
 * - market_tick: New price tick received
 * - candle_closed: Candle completed
 * - trade_signal: Strategy signal generated
 * - risk_approved: Risk manager approved trade
 * - risk_rejected: Risk manager rejected trade
 * - order_placed: Order sent to broker
 * - order_filled: Order executed
 * - order_cancelled: Order cancelled
 * - position_opened: New position opened
 * - position_closed: Position closed with PnL
 * - error: System error occurred
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Allow many subscribers
    this.eventHistory = [];
    this.maxHistory = 1000;

    // Log all events in debug mode
    this.on('newListener', (event) => {
      logger.debug(`Event listener registered: ${event}`);
    });

    // Track event history for debugging (override emit to capture all events)
    const originalEmit = this.emit.bind(this);
    this.emit = (event, ...args) => {
      const timestamp = new Date().toISOString();
      this.eventHistory.push({ timestamp, event, args: this._sanitizeArgs(args) });
      if (this.eventHistory.length > this.maxHistory) {
        this.eventHistory.shift();
      }
      logger.debug(`Event emitted: ${event}`);
      return originalEmit(event, ...args);
    };
  }

  // Sanitize arguments for logging (prevent circular refs)
  _sanitizeArgs(args) {
    try {
      return JSON.parse(JSON.stringify(args, (key, value) => {
        if (typeof value === 'function') return '[Function]';
        if (value instanceof EventEmitter) return '[EventEmitter]';
        return value;
      }));
    } catch {
      return '[Circular Reference]';
    }
  }

  // Emit with error handling
  emitSafe(event, ...args) {
    try {
      return this.emit(event, ...args);
    } catch (error) {
      logger.error(`Error emitting event '${event}': ${error.message}`);
      this.emit('error', { event, error });
      return false;
    }
  }

  // Get event history
  getHistory(limit = 100) {
    return this.eventHistory.slice(-limit);
  }

  // Clear history
  clearHistory() {
    this.eventHistory = [];
  }

  // Get listener count for an event
  getListenerCount(event) {
    return this.listenerCount(event);
  }

  // Get all registered events
  getRegisteredEvents() {
    return this.eventNames();
  }
}

// Singleton export
export const eventBus = new EventBus();
export default eventBus;
