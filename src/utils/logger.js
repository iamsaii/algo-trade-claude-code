/**
 * Winston Logger Configuration
 * Provides structured logging with console and file outputs
 */

import winston from 'winston';
import 'winston-daily-rotate-file';
import chalk from 'chalk';
import config from '../core/config.js';

// Custom format for console output with colors
const consoleFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
  const levelColor = {
    error: chalk.red,
    warn: chalk.yellow,
    info: chalk.green,
    debug: chalk.blue,
  }[level] || chalk.white;

  const levelStr = levelColor(level.toUpperCase());
  const timeStr = chalk.gray(timestamp);
  let metaStr = '';

  if (Object.keys(meta).length > 0) {
    metaStr = chalk.dim(' ' + JSON.stringify(meta));
  }

  return `${timeStr} [${levelStr}] ${message}${metaStr}`;
});

// Format for file output (JSON)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Get log level from config
const logLevel = config.get('logging.level') || 'info';

// Create daily rotate file transport
const dailyRotateTransport = new winston.transports.DailyRotateFile({
  filename: config.get('logging.directory') + '/algo-trading-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '10m',
  maxFiles: '14d',
  format: fileFormat,
});

// Create logger instance
const logger = winston.createLogger({
  level: logLevel,
  transports: [
    dailyRotateTransport,
  ],
  defaultMeta: { service: 'algo-trading' },
});

// Add console transport if enabled
if (config.get('logging.consoleOutput')) {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      consoleFormat
    ),
  }));
}

// Create child loggers for different modules
export const createChildLogger = (module) => {
  return logger.child({ module });
};

// Trade-specific logger with formatting
logger.trade = (trade) => {
  const actionColor = trade.action === 'BUY' ? chalk.green : chalk.red;
  logger.info(
    `${actionColor(trade.action)} ${trade.symbol} | Qty: ${trade.quantity} | Price: ${trade.entryPrice} | Strategy: ${trade.strategy}`
  );
};

// Signal-specific logger
logger.signal = (signal) => {
  const actionColor = signal.action === 'BUY' ? chalk.green : chalk.red;
  logger.info(
    `SIGNAL: ${actionColor(signal.action)} ${signal.symbol} | Strength: ${signal.strength} | SL: ${signal.stopLoss} | Target: ${signal.target}`
  );
};

// PnL logger
logger.pnl = (pnl, type = 'trade') => {
  const color = pnl >= 0 ? chalk.green : chalk.red;
  const sign = pnl >= 0 ? '+' : '';
  if (type === 'trade') {
    logger.info(`Trade PnL: ${color(`${sign}${pnl.toFixed(2)}`)}`);
  } else if (type === 'daily') {
    logger.info(`Daily PnL: ${color(`${sign}${pnl.toFixed(2)}`)}`);
  } else if (type === 'total') {
    logger.info(`Total PnL: ${color(`${sign}${pnl.toFixed(2)}`)}`);
  }
};

export default logger;
