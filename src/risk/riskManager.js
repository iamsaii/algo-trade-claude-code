/**
 * Risk Manager
 * Centralized risk management for all trading decisions
 *
 * Implements:
 * - Max risk per trade (1% of capital)
 * - Max daily loss limit (5%)
 * - Max open trades limit
 * - Position sizing
 * - Exposure checks
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import config from '../core/config.js';
import { eventBus } from '../core/eventBus.js';

class RiskManager extends EventEmitter {
  constructor() {
    super();

    // Trading limits from config
    this.initialCapital = config.get('trading.initialCapital');
    this.currentCapital = this.initialCapital;
    this.maxRiskPerTrade = config.get('trading.maxRiskPerTrade');
    this.maxDailyLoss = config.get('trading.maxDailyLoss');
    this.maxOpenTrades = config.get('trading.maxOpenTrades');
    this.defaultStopLoss = config.get('trading.defaultStopLoss');
    this.defaultTarget = config.get('trading.defaultTarget');

    // State tracking
    this.openTrades = [];
    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.totalPnL = 0;
    this.peakCapital = this.initialCapital;
    this.currentDrawdown = 0;
    this.maxDrawdown = 0;

    // Risk state
    this.isTradingBlocked = false;
    this.blockReason = null;

    // Listen for trade events
    this._setupEventListeners();
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    eventBus.on('order_filled', (trade) => {
      this._onTradeFilled(trade);
    });

    eventBus.on('position_closed', (result) => {
      this._onPositionClosed(result);
    });
  }

  /**
   * Check if a trade signal should be approved
   */
  checkSignal(signal, currentPositions = []) {
    const checks = {
      passed: true,
      reason: null,
      positionSize: 0,
      riskAmount: 0,
    };

    // Check if trading is blocked
    if (this.isTradingBlocked) {
      checks.passed = false;
      checks.reason = `Trading blocked: ${this.blockReason}`;
      this._logRejection(signal, checks.reason);
      return checks;
    }

    // Check daily loss limit
    const dailyLossPercent = Math.abs(Math.min(0, this.dailyPnL)) / this.initialCapital;
    if (dailyLossPercent >= this.maxDailyLoss) {
      checks.passed = false;
      checks.reason = `Daily loss limit reached: ${dailyLossPercent.toFixed(2)}% / ${this.maxDailyLoss * 100}%`;
      this._logRejection(signal, checks.reason);
      return checks;
    }

    // Check max open trades
    if (currentPositions.length >= this.maxOpenTrades) {
      checks.passed = false;
      checks.reason = `Max open trades reached: ${currentPositions.length} / ${this.maxOpenTrades}`;
      this._logRejection(signal, checks.reason);
      return checks;
    }

    // Check if we already have a position in this symbol
    const existingPosition = currentPositions.find(p => p.symbol === signal.symbol);
    if (existingPosition) {
      checks.passed = false;
      checks.reason = `Already have position in ${signal.symbol}`;
      this._logRejection(signal, checks.reason);
      return checks;
    }

    // Calculate position size
    const positionData = this._calculatePositionSize(signal);
    checks.positionSize = positionData.quantity;
    checks.riskAmount = positionData.riskAmount;

    // Check max risk per trade
    if (positionData.riskAmount > this.currentCapital * this.maxRiskPerTrade) {
      checks.passed = false;
      checks.reason = `Risk amount exceeds limit: ${positionData.riskAmount.toFixed(2)} > ${(this.currentCapital * this.maxRiskPerTrade).toFixed(2)}`;
      this._logRejection(signal, checks.reason);
      return checks;
    }

    // Check sufficient capital
    const requiredCapital = positionData.quantity * signal.entryPrice;
    if (requiredCapital > this.currentCapital * 0.5) { // Max 50% capital per trade
      checks.passed = false;
      checks.reason = `Insufficient capital: Required ${requiredCapital.toFixed(2)}, Available ${this.currentCapital.toFixed(2)}`;
      this._logRejection(signal, checks.reason);
      return checks;
    }

    // All checks passed
    logger.debug('Risk check passed', {
      symbol: signal.symbol,
      action: signal.action,
      quantity: checks.positionSize,
      riskAmount: checks.riskAmount,
    });

    return checks;
  }

  /**
   * Calculate position size based on risk
   */
  _calculatePositionSize(signal) {
    const riskPerShare = Math.abs(signal.entryPrice - signal.stopLoss);
    const maxRiskAmount = this.currentCapital * this.maxRiskPerTrade;

    // Calculate quantity based on risk
    let quantity = Math.floor(maxRiskAmount / riskPerShare);

    // Ensure minimum quantity
    if (quantity < 1) {
      quantity = 1;
    }

    // Calculate actual risk amount
    const riskAmount = quantity * riskPerShare;

    return {
      quantity,
      riskAmount,
      value: quantity * signal.entryPrice,
      riskPerShare,
    };
  }

  /**
   * Handle trade filled event
   */
  _onTradeFilled(trade) {
    this.openTrades.push({
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      entryTime: trade.timestamp,
      strategy: trade.strategy,
    });

    this.dailyTrades++;
    logger.info('Trade opened', {
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
    });
  }

  /**
   * Handle position closed event
   */
  _onPositionClosed(result) {
    // Remove from open trades
    this.openTrades = this.openTrades.filter(t => t.id !== result.tradeId);

    // Update PnL
    this.dailyPnL += result.pnl;
    this.totalPnL += result.pnl;
    this.currentCapital += result.pnl;

    // Track peak capital for drawdown calculation
    if (this.currentCapital > this.peakCapital) {
      this.peakCapital = this.currentCapital;
    }

    // Calculate current drawdown
    this.currentDrawdown = (this.peakCapital - this.currentCapital) / this.peakCapital;
    this.maxDrawdown = Math.max(this.maxDrawdown, this.currentDrawdown);

    // Check if daily loss limit hit
    if (Math.abs(Math.min(0, this.dailyPnL)) / this.initialCapital >= this.maxDailyLoss) {
      this.isTradingBlocked = true;
      this.blockReason = 'Daily loss limit reached';
      logger.warn('Trading blocked due to daily loss limit');
    }

    logger.info('Position closed', {
      tradeId: result.tradeId,
      pnl: result.pnl,
      dailyPnL: this.dailyPnL,
      totalPnL: this.totalPnL,
    });
  }

  /**
   * Log rejected signal
   */
  _logRejection(signal, reason) {
    if (config.get('risk.logRejections')) {
      logger.debug('Signal rejected', {
        symbol: signal.symbol,
        action: signal.action,
        reason,
      });
    }
    this.emit('signal_rejected', { signal, reason });
  }

  /**
   * Reset daily statistics (call at start of trading day)
   */
  resetDaily() {
    logger.info('Resetting daily statistics', {
      dailyPnL: this.dailyPnL,
      dailyTrades: this.dailyTrades,
    });

    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.isTradingBlocked = false;
    this.blockReason = null;
  }

  /**
   * Close a specific trade (for stop loss / target hits)
   */
  closeTrade(tradeId, exitPrice) {
    const trade = this.openTrades.find(t => t.id === tradeId);
    if (!trade) {
      logger.warn('Trade not found for closing', { tradeId });
      return null;
    }

    // Calculate PnL
    let pnl;
    if (trade.side === 'BUY') {
      pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    } else {
      pnl = (trade.entryPrice - exitPrice) * trade.quantity;
    }

    // Emit position closed event
    eventBus.emitSafe('position_closed', {
      tradeId,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      exitPrice,
      pnl,
    });

    return { tradeId, pnl, exitPrice };
  }

  /**
   * Get current risk exposure
   */
  getExposure() {
    const totalValue = this.openTrades.reduce((sum, t) => sum + t.quantity * t.entryPrice, 0);
    return {
      openTrades: this.openTrades.length,
      totalValue,
      capitalUsed: totalValue,
      availableCapital: this.currentCapital,
      exposurePercent: totalValue / this.currentCapital,
    };
  }

  /**
   * Get risk statistics
   */
  getStats() {
    return {
      initialCapital: this.initialCapital,
      currentCapital: this.currentCapital,
      totalPnL: this.totalPnL,
      totalPnLPercent: (this.totalPnL / this.initialCapital) * 100,
      dailyPnL: this.dailyPnL,
      dailyTrades: this.dailyTrades,
      openTrades: this.openTrades.length,
      maxOpenTrades: this.maxOpenTrades,
      currentDrawdown: this.currentDrawdown * 100,
      maxDrawdown: this.maxDrawdown * 100,
      peakCapital: this.peakCapital,
      isTradingBlocked: this.isTradingBlocked,
      blockReason: this.blockReason,
    };
  }

  /**
   * Update capital (for deposits/withdrawals)
   */
  updateCapital(amount) {
    this.currentCapital += amount;
    logger.info('Capital updated', {
      change: amount,
      newCapital: this.currentCapital,
    });
  }
}

// Singleton export
export const riskManager = new RiskManager();
export default riskManager;
