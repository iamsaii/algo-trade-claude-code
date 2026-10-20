/**
 * Configuration Management
 * Centralized configuration for all trading parameters
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default trading configuration
const defaultConfig = {
  // Trading parameters
  trading: {
    initialCapital: 100000,        // Starting capital in INR
    maxRiskPerTrade: 0.01,         // 1% of capital per trade
    maxDailyLoss: 0.05,            // 5% daily loss limit
    maxOpenTrades: 5,              // Maximum concurrent positions
    defaultStopLoss: 0.02,         // 2% stop loss
    defaultTarget: 0.04,           // 4% profit target
  },

  // Market data settings
  market: {
    tickIntervalMs: 1000,          // Simulated tick frequency
    candleIntervalMinutes: 5,      // Candle timeframe
    symbols: ['RELIANCE', 'INFY', 'HDFCBANK', 'TCS', 'ICICIBANK'],
    // A real market-data feed. Disabled by default: when false, `--mode live`
    // refuses to start rather than price real orders off the simulator.
    liveFeed: {
      enabled: false,
      url: null,
    },
  },

  // Strategy settings
  strategies: {
    movingAverage: {
      enabled: true,
      shortPeriod: 10,
      longPeriod: 20,
    },
    rsiMeanReversion: {
      enabled: true,
      period: 14,
      oversold: 30,
      overbought: 70,
    },
    breakout: {
      enabled: true,
      lookbackPeriod: 20,
    },
    // MACD Trend Strategy (NEW - trend-following with histogram divergence)
    macdTrend: {
      enabled: true,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      adxThreshold: 25,
      useADXFilter: true,
    },
    // VWAP Mean Reversion Strategy (NEW - volume-based mean reversion)
    vwapMeanReversion: {
      enabled: true,
      bbPeriod: 20,
      stdDev: 2,
      rsiPeriod: 14,
      resetTime: 86400,
    },
  },

  // Risk management
  risk: {
    enabled: true,
    checkBeforeTrade: true,
    logRejections: true,
  },

  // Database settings
  database: {
    path: join(__dirname, '../../data/trading.db'),
  },

  // Logging settings
  logging: {
    level: 'info',
    directory: join(__dirname, '../../logs'),
    consoleOutput: true,
  },

  // Paper trading settings
  paperTrading: {
    enabled: true,
    simulateSlippage: true,
    slippagePercent: 0.001,        // 0.1% slippage
    simulateDelay: true,
    delayMs: 100,                  // Simulated fill delay
  },

  // Backtesting settings
  backtest: {
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    initialCapital: 100000,
  },

  // AI trading agent settings
  ai: {
    dailyBudget: 1000,            // Gross rupees the agent may spend per day (resets 09:15)
    maxTrades: 2,                 // Max new AI trades per day
    dailyLossLimitPct: 0.05,      // Halt for the day beyond 5% of budget lost
    misLeverage: 5,               // Intraday margin multiplier for qty math
    eodExitEnabled: true,         // Square off all AI lots at end of day
    eodExitTime: '15:15',
    llm: {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    },
    tag: 'ai-agent',              // Kite order tag AND strategy value
  },
};

// Environment-specific overrides
function loadEnvConfig() {
  const envOverrides = {};

  // Override from environment variables if set
  if (process.env.TRADING_CAPITAL) {
    envOverrides.trading = { initialCapital: parseFloat(process.env.TRADING_CAPITAL) };
  }

  if (process.env.MAX_RISK_PER_TRADE) {
    envOverrides.trading = { ...envOverrides.trading, maxRiskPerTrade: parseFloat(process.env.MAX_RISK_PER_TRADE) };
  }

  if (process.env.LOG_LEVEL) {
    envOverrides.logging = { level: process.env.LOG_LEVEL };
  }

  return envOverrides;
}

// Deep merge utility
function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] instanceof Object && key in target) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

class ConfigManager {
  constructor() {
    this.config = null;
  }

  getConfig() {
    if (!this.config) {
      this.config = deepMerge(defaultConfig, loadEnvConfig());
    }
    return this.config;
  }

  get(path) {
    const config = this.getConfig();
    return path.split('.').reduce((obj, key) => obj?.[key], config);
  }

  set(path, value) {
    if (!this.config) {
      this.getConfig();
    }
    const keys = path.split('.');
    let current = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }
}

// Singleton export
export const config = new ConfigManager();
export default config;
