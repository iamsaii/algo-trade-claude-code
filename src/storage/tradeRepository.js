/**
 * Trade Repository
 * SQLite-based storage for trades, signals, and performance data
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import logger from '../utils/logger.js';
import config from '../core/config.js';

/** Local calendar date YYYY-MM-DD — the one definition of "today". */
export function todayStr() {
  return new Date().toLocaleDateString('sv');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TradeRepository {
  constructor(dbPath = null) {
    this.dbPath = dbPath || config.get('database.path');

    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = null;
    this.initialized = false;
  }

  /**
   * Initialize database connection and create tables
   */
  connect() {
    try {
      this.db = new Database(this.dbPath);

      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');

      // Create tables
      this._createTables();

      this.initialized = true;
      logger.info('Database connected', { path: this.dbPath });

      return true;
    } catch (error) {
      logger.error('Database connection failed', { error: error.message });
      return false;
    }
  }

  /**
   * Create database tables
   */
  _createTables() {
    // Trades table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL,
        pnl REAL DEFAULT 0,
        pnl_percent REAL DEFAULT 0,
        strategy TEXT NOT NULL,
        status TEXT DEFAULT 'OPEN',
        entry_timestamp INTEGER NOT NULL,
        exit_timestamp INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Signals table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        strength REAL,
        entry_price REAL,
        stop_loss REAL,
        target REAL,
        strategy TEXT NOT NULL,
        reason TEXT,
        indicators TEXT,
        approved INTEGER DEFAULT 0,
        rejected INTEGER DEFAULT 0,
        rejection_reason TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Daily PnL summary table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_pnl (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        opening_balance REAL NOT NULL,
        closing_balance REAL NOT NULL,
        realized_pnl REAL DEFAULT 0,
        unrealized_pnl REAL DEFAULT 0,
        trades_count INTEGER DEFAULT 0,
        winning_trades INTEGER DEFAULT 0,
        losing_trades INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Portfolio snapshots table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        balance REAL NOT NULL,
        unrealized_pnl REAL DEFAULT 0,
        total_value REAL NOT NULL,
        positions_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // AI agent ledger: the sell-guard source of truth. The agent may
    // only ever sell what it has bought and recorded here.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price REAL NOT NULL,
        product TEXT,
        kite_order_id TEXT,
        reason TEXT,
        day TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Create indexes for better query performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
      CREATE INDEX IF NOT EXISTS idx_trades_entry_timestamp ON trades(entry_timestamp);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
      CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy);
      CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
    `);

    logger.debug('Database tables created');
  }

  /**
   * Save a trade
   */
  saveTrade(trade) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO trades (
          id, symbol, side, quantity, entry_price, exit_price,
          pnl, pnl_percent, strategy, status, entry_timestamp, exit_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        trade.id,
        trade.symbol,
        trade.side,
        trade.quantity,
        trade.entryPrice,
        trade.exitPrice || null,
        trade.pnl || 0,
        trade.pnlPercent || 0,
        trade.strategy,
        trade.status,
        trade.timestamp,
        trade.closedAt || null
      );

      logger.debug('Trade saved', { tradeId: trade.id });
      return true;
    } catch (error) {
      logger.error('Failed to save trade', { error: error.message });
      return false;
    }
  }

  /**
   * Save a signal
   */
  saveSignal(signal, approved = true, rejectionReason = null) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO signals (
          id, symbol, action, strength, entry_price, stop_loss, target,
          strategy, reason, indicators, approved, rejected, rejection_reason, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        `SIG-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        signal.symbol,
        signal.action,
        signal.strength || null,
        signal.entryPrice || null,
        signal.stopLoss || null,
        signal.target || null,
        signal.strategy || 'unknown',
        signal.reason || null,
        signal.indicators ? JSON.stringify(signal.indicators) : null,
        approved ? 1 : 0,
        !approved ? 1 : 0,
        rejectionReason,
        Date.now()
      );

      logger.debug('Signal saved', {
        symbol: signal.symbol,
        action: signal.action,
        approved,
      });
      return true;
    } catch (error) {
      logger.error('Failed to save signal', { error: error.message });
      return false;
    }
  }

  /**
   * Update trade on exit
   */
  updateTradeExit(tradeId, exitPrice, pnl) {
    try {
      const stmt = this.db.prepare(`
        UPDATE trades
        SET exit_price = ?, pnl = ?, pnl_percent = ?, status = 'CLOSED',
            exit_timestamp = ?, updated_at = strftime('%s', 'now')
        WHERE id = ?
      `);

      const trade = this.getTrade(tradeId);
      if (!trade) return false;

      const pnlPercent = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100 *
        (trade.side === 'BUY' ? 1 : -1);

      stmt.run(exitPrice, pnl, pnlPercent, Date.now(), tradeId);
      logger.debug('Trade exit updated', { tradeId, pnl });
      return true;
    } catch (error) {
      logger.error('Failed to update trade exit', { error: error.message });
      return false;
    }
  }

  /**
   * Get a specific trade
   */
  getTrade(tradeId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM trades WHERE id = ?');
      return stmt.get(tradeId);
    } catch (error) {
      logger.error('Failed to get trade', { error: error.message });
      return null;
    }
  }

  /**
   * Get all trades with filters
   */
  getTrades(filters = {}) {
    try {
      let query = 'SELECT * FROM trades WHERE 1=1';
      const params = [];

      if (filters.symbol) {
        query += ' AND symbol = ?';
        params.push(filters.symbol);
      }

      if (filters.status) {
        query += ' AND status = ?';
        params.push(filters.status);
      }

      if (filters.strategy) {
        query += ' AND strategy = ?';
        params.push(filters.strategy);
      }

      if (filters.startDate) {
        query += ' AND entry_timestamp >= ?';
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        query += ' AND entry_timestamp <= ?';
        params.push(filters.endDate);
      }

      query += ' ORDER BY entry_timestamp DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      const stmt = this.db.prepare(query);
      return stmt.all(...params);
    } catch (error) {
      logger.error('Failed to get trades', { error: error.message });
      return [];
    }
  }

  /**
   * Get open trades
   */
  getOpenTrades() {
    return this.getTrades({ status: 'OPEN' });
  }

  /**
   * Get closed trades
   */
  getClosedTrades(limit = 100) {
    return this.getTrades({ status: 'CLOSED', limit });
  }

  /**
   * Get signals with filters
   */
  getSignals(filters = {}) {
    try {
      let query = 'SELECT * FROM signals WHERE 1=1';
      const params = [];

      if (filters.symbol) {
        query += ' AND symbol = ?';
        params.push(filters.symbol);
      }

      if (filters.strategy) {
        query += ' AND strategy = ?';
        params.push(filters.strategy);
      }

      if (filters.approved !== undefined) {
        query += ' AND approved = ?';
        params.push(filters.approved ? 1 : 0);
      }

      if (filters.startDate) {
        query += ' AND timestamp >= ?';
        params.push(filters.startDate);
      }

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      query += ' ORDER BY timestamp DESC';

      const stmt = this.db.prepare(query);
      return stmt.all(...params);
    } catch (error) {
      logger.error('Failed to get signals', { error: error.message });
      return [];
    }
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats() {
    try {
      const stats = {};

      // Total trades
      const totalStmt = this.db.prepare(`
        SELECT COUNT(*) as count, SUM(pnl) as totalPnl
        FROM trades WHERE status = 'CLOSED'
      `);
      stats.total = totalStmt.get();

      // Winning trades
      const winningStmt = this.db.prepare(`
        SELECT COUNT(*) as count, SUM(pnl) as totalPnl
        FROM trades WHERE status = 'CLOSED' AND pnl > 0
      `);
      stats.winning = winningStmt.get();

      // Losing trades
      const losingStmt = this.db.prepare(`
        SELECT COUNT(*) as count, SUM(pnl) as totalPnl
        FROM trades WHERE status = 'CLOSED' AND pnl < 0
      `);
      stats.losing = losingStmt.get();

      // By strategy
      const strategyStmt = this.db.prepare(`
        SELECT strategy, COUNT(*) as count, SUM(pnl) as totalPnl,
               AVG(pnl) as avgPnl
        FROM trades WHERE status = 'CLOSED'
        GROUP BY strategy
      `);
      stats.byStrategy = strategyStmt.all();

      // Win rate
      const totalClosed = stats.total?.count || 0;
      const winningCount = stats.winning?.count || 0;
      stats.winRate = totalClosed > 0 ? (winningCount / totalClosed) * 100 : 0;

      // Profit factor
      const grossProfit = Math.abs(stats.winning?.totalPnl || 0);
      const grossLoss = Math.abs(stats.losing?.totalPnl || 0);
      stats.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

      return stats;
    } catch (error) {
      logger.error('Failed to get performance stats', { error: error.message });
      return null;
    }
  }

  /**
   * Save daily PnL snapshot
   */
  saveDailyPnL(dailyData) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO daily_pnl (
          date, opening_balance, closing_balance, realized_pnl,
          unrealized_pnl, trades_count, winning_trades, losing_trades
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const today = new Date().toISOString().split('T')[0];

      stmt.run(
        today,
        dailyData.openingBalance,
        dailyData.closingBalance,
        dailyData.realizedPnL,
        dailyData.unrealizedPnL,
        dailyData.tradesCount,
        dailyData.winningTrades,
        dailyData.losingTrades
      );

      return true;
    } catch (error) {
      logger.error('Failed to save daily PnL', { error: error.message });
      return false;
    }
  }

  /**
   * Save portfolio snapshot
   */
  savePortfolioSnapshot(snapshot) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO portfolio_snapshots (
          timestamp, balance, unrealized_pnl, total_value, positions_count
        ) VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(
        Date.now(),
        snapshot.balance,
        snapshot.unrealizedPnL,
        snapshot.totalValue,
        snapshot.positionsCount
      );

      return true;
    } catch (error) {
      logger.error('Failed to save portfolio snapshot', { error: error.message });
      return false;
    }
  }

  /**
   * Record an AI agent fill (buy or sell) in the agent's own ledger.
   * Thrown errors must propagate: an unrecorded fill would break the
   * sell-guard, so the caller must never continue past this silently.
   */
  recordAiFill({ symbol, side, quantity, price, product = null, kiteOrderId = null, reason = null }) {
    const stmt = this.db.prepare(`
      INSERT INTO ai_ledger (symbol, side, quantity, price, product, kite_order_id, reason, day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(symbol, side, quantity, price, product, kiteOrderId, reason, todayStr());
    return info.lastInsertRowid;
  }

  /**
   * Margin rupees consumed today: buys count quantity*price/leverage
   * (MIS leveraged, CNC full); sale proceeds never refill the budget.
   */
  getSpendToday() {
    const misLeverage = config.get('ai.misLeverage');
    const rows = this.db.prepare(
      "SELECT quantity, price, product FROM ai_ledger WHERE day = ? AND side = 'BUY'"
    ).all(todayStr());
    return rows.reduce((sum, r) => {
      const leverage = r.product === 'MIS' ? misLeverage : 1;
      return sum + (r.quantity * r.price) / leverage;
    }, 0);
  }

  /**
   * Net open AI lots (buys minus sells, positive quantities only).
   */
  getOpenAiLots() {
    const rows = this.db.prepare(`
      SELECT symbol, SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END) AS qty
      FROM ai_ledger
      GROUP BY symbol
      HAVING qty > 0
    `).all();
    return rows.map(r => ({ symbol: r.symbol, quantity: r.qty }));
  }

  /**
   * Open lot for one symbol with weighted-average buy price, or null.
   */
  getOpenAiLot(symbol) {
    const rows = this.db.prepare(
      'SELECT side, quantity, price FROM ai_ledger WHERE symbol = ?'
    ).all(symbol);
    if (!rows.length) return null;
    let qty = 0;
    let buyQty = 0;
    let buyAmount = 0;
    for (const r of rows) {
      if (r.side === 'BUY') {
        buyQty += r.quantity;
        buyAmount += r.quantity * r.price;
      }
      qty += r.side === 'BUY' ? r.quantity : -r.quantity;
    }
    if (qty <= 0) return null;
    return { symbol, quantity: qty, avgPrice: buyQty > 0 ? buyAmount / buyQty : 0 };
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      logger.info('Database connection closed');
    }
    this.initialized = false;
  }
}

// Singleton export
export const tradeRepository = new TradeRepository();
export default tradeRepository;
