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

    // Config-derived limits are read lazily via getters, so runtime overrides
    // (--capital, env vars) applied after this module is imported are honoured.
    // currentCapital is seeded on first use, once config is fully applied.
    this.currentCapital = null;
    this.peakCapital = null;
    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.totalPnL = 0;
    this.currentDrawdown = 0;
    this.maxDrawdown = 0;

    // Risk state
    this.isTradingBlocked = false;
    this.blockReason = null;

    // Listen for trade events
    this._setupEventListeners();
  }

  // ---- Config-backed limits (read at call time) ----
  get initialCapital() { return config.get('trading.initialCapital'); }
  get maxRiskPerTrade() { return config.get('trading.maxRiskPerTrade'); }
  get maxDailyLoss() { return config.get('trading.maxDailyLoss'); }
  get maxOpenTrades() { return config.get('trading.maxOpenTrades'); }
  get defaultStopLoss() { return config.get('trading.defaultStopLoss'); }
  get defaultTarget() { return config.get('trading.defaultTarget'); }

  /**
   * Seed capital/peak on first use so that config.set() after import is seen.
   */
  _ensureCapital() {
    if (this.currentCapital === null) {
      this.currentCapital = this.initialCapital;
      this.peakCapital = this.currentCapital;
    }
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
    this._ensureCapital();

    const checks = {
      passed: true,
      reason: null,
      positionSize: 0,
      riskAmount: 0,
      isExit: false,
    };

    // Exit / reduction signals must always be allowed - even when blocked,
    // because closing out is exactly what we want in a risk-limit scenario.
    const existingPosition = currentPositions.find(p => p.symbol === signal.symbol);
    if (existingPosition && existingPosition.side !== signal.action) {
      checks.isExit = true;
      checks.positionSize = existingPosition.quantity;
      logger.debug('Risk check: exit signal allowed', {
        symbol: signal.symbol,
        action: signal.action,
        positionSize: checks.positionSize,
      });
      return checks;
    }

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
      checks.reason = `Daily loss limit reached: ${(dailyLossPercent * 100).toFixed(2)}% / ${this.maxDailyLoss * 100}%`;
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

    // Already holding this symbol and the signal would ADD to it (exits
    // were allowed above).
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
    this._ensureCapital();
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
   * Handle position closed event. The order manager is the single source of
   * truth for positions, so this only settles PnL / drawdown state here.
   */
  _onPositionClosed(result) {
    this._ensureCapital();

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
   * Get current risk exposure from the order manager's live positions.
   * The risk manager no longer keeps its own position ledger.
   * @param {Array} currentPositions - positions owned by the order manager
   */
  getExposure(currentPositions = []) {
    this._ensureCapital();
    const totalValue = currentPositions.reduce(
      (sum, t) => sum + t.quantity * (t.avgPrice ?? t.entryPrice ?? 0),
      0
    );
    const availableCapital = this.currentCapital;
    return {
      openTrades: currentPositions.length,
      totalValue,
      capitalUsed: totalValue,
      availableCapital,
      exposurePercent: availableCapital > 0 ? totalValue / availableCapital : 0,
    };
  }

  /**
   * Get risk statistics
   * @param {Array} currentPositions - positions owned by the order manager
   */
  getStats(currentPositions = []) {
    this._ensureCapital();
    return {
      initialCapital: this.initialCapital,
      currentCapital: this.currentCapital,
      totalPnL: this.totalPnL,
      totalPnLPercent: (this.totalPnL / this.initialCapital) * 100,
      dailyPnL: this.dailyPnL,
      dailyTrades: this.dailyTrades,
      openTrades: currentPositions.length,
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
    this._ensureCapital();
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
