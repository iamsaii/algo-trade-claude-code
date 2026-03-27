# Algo-Trading Framework - Development Guide

## Overview
Production-ready, event-driven algorithmic trading framework built with Node.js. Supports backtesting, paper trading, and live trading via broker APIs (Zerodha Kite Connect).

## Quick Start
```bash
# Install dependencies
npm install

# Generate sample historical data
npm run generate-data

# Run paper trading (simulated)
npm run start:paper

# Run backtest
npm run start:backtest -- --symbol RELIANCE --strategy movingaverage

# Custom config
node src/app.js --mode paper --capital 200000
```

## Architecture

### Core Modules
```
src/
├── core/
│   ├── eventBus.js       # Central event dispatcher (EventEmitter)
│   └── config.js         # Configuration management
├── data/
│   ├── marketStream.js   # Market data simulator
│   ├── candleBuilder.js  # Tick to candle aggregator
│   └── sampleData.js     # Historical data generator
├── strategies/
│   ├── baseStrategy.js            # Abstract base class
│   ├── movingAverageStrategy.js   # MA crossover
│   ├── rsiMeanReversionStrategy.js # RSI mean reversion
│   └── breakoutStrategy.js        # Support/resistance breakout
├── risk/
│   └── riskManager.js    # Risk checks (daily loss, position limits)
├── execution/
│   └── orderManager.js   # Order lifecycle management
├── brokers/
│   ├── baseBroker.js     # Broker interface
│   ├── paperBroker.js    # Simulated broker
│   └── kiteBroker.js     # Zerodha Kite Connect
├── backtest/
│   ├── backtester.js     # Backtesting engine
│   └── performance.js    # Metrics calculation
└── utils/
    ├── indicators.js   # Technical indicators (SMA, EMA, RSI, etc.)
    └── logger.js       # Winston logger with daily rotation
```

### Event Flow
```
Market Data → Candle Builder → Strategy → Risk Manager → Order Manager → Broker
                                    ↓
                              Event Bus (all modules subscribe)
```

## Key Patterns

### 1. Event-Driven Architecture
All modules communicate via `eventBus` (Node.js EventEmitter). Events:
- `market_tick` - New price tick
- `candle_closed` - Candle completed
- `trade_signal` - Strategy generated signal
- `risk_approved/rejected` - Risk check result
- `order_placed/filled/cancelled` - Order events
- `position_opened/closed` - Position events

**Example: Subscribe to events**
```javascript
import { eventBus } from '../core/eventBus.js';

eventBus.on('trade_signal', (signal) => {
  console.log(`Signal: ${signal.action} ${signal.symbol}`);
});
```

### 2. Strategy Pattern
All strategies extend `BaseStrategy`:

```javascript
class MyStrategy extends BaseStrategy {
  constructor(config) {
    super('MyStrategy', config);
  }

  generateSignal() {
    // Your logic here
    return {
      action: 'BUY',
      entryPrice: 100,
      stopLoss: 98,
      target: 110,
      strength: 0.8,
      reason: 'Strategy condition met',
      indicators: { rsi: 35, sma: 95, ema: 98 }
    };
  }

  onCandle(candle) {
    // Called on each new candle
    return this.generateSignal();
  }
}
```

### 3. Risk Management
Risk manager checks before every order:
- Daily loss limit (default: 5%)
- Maximum concurrent positions (default: 5)
- Position size limits

```javascript
import riskManager from '../risk/riskManager.js';

// Check before trade
if (riskManager.check(signal)) {
  // Proceed with order
} else {
  // Log rejection
}
```

### 4. Order Lifecycle
```javascript
// 1. Risk approves signal
// 2. Order manager places limit order
// 3. Broker executes (simulated or real)
// 4. Position opened
// 5. On price hit: stop loss / target
// 6. Position closed with PnL
```

### 5. Backtesting
```javascript
import Backtester from '../backtest/backtester.js';
import MovingAverageStrategy from '../strategies/movingAverageStrategy.js';

const strategy = new MovingAverageStrategy({ shortPeriod: 5, longPeriod: 10 });
const backtester = new Backtester(100000);

const result = backtester.run(strategy, historicalData, {
  symbol: 'RELIANCE',
  commission: 0.0003,
  slippage: 0.001
});

console.log(result.metrics); // Performance metrics
```

### 6. Technical Indicators
```javascript
import { sma, ema, rsi, bollingerBands } from '../utils/indicators.js';

const sma50 = sma(prices, 50);
const ema20 = ema(prices, 20);
const rsi = rsi(prices, 14);
const bb = bollingerBands(prices, 20, 2);
```

## Configuration

### Default Config (`src/core/config.js`)
```javascript
{
  trading: {
    initialCapital: 100000,
    maxRiskPerTrade: 0.01,
    maxDailyLoss: 0.05,
    maxOpenTrades: 5
  },
  strategies: {
    movingAverage: { enabled: true, shortPeriod: 10, longPeriod: 20 },
    rsiMeanReversion: { enabled: true, period: 14, oversold: 30, overbought: 70 },
    breakout: { enabled: true, lookbackPeriod: 20 }
  },
  paperTrading: {
    simulateSlippage: true,
    slippagePercent: 0.001
  }
}
```

### Environment Overrides
```bash
export TRADING_CAPITAL=200000
export MAX_RISK_PER_TRADE=0.02
export LOG_LEVEL=debug
```

## Custom Strategy Example

**File: `src/strategies/myCustomStrategy.js`**
```javascript
import BaseStrategy from './baseStrategy.js';
import { rsi } from '../utils/indicators.js';

export default class MyCustomStrategy extends BaseStrategy {
  generateSignal() {
    const rsi = rsi(this.getClosePrices(), 14);

    if (!rsi) return null;

    if (rsi < 30) { // Oversold
      return {
        action: 'BUY',
        entryPrice: this.candles[this.candles.length - 1].close,
        stopLoss: this.candles[this.candles.length - 1].low * 0.98,
        target: this.candles[this.candles.length - 1].high * 1.04,
        strength: (30 - rsi) / 100,
        reason: `RSI oversold (${rsi.toFixed(2)})`
      };
    }

    if (rsi > 70) { // Overbought
      return {
        action: 'SELL',
        entryPrice: this.candles[this.candles.length - 1].close,
        stopLoss: this.candles[this.candles.length - 1].high * 1.02,
        target: this.candles[this.candles.length - 1].low * 0.96,
        strength: (rsi - 70) / 100,
        reason: `RSI overbought (${rsi.toFixed(2)})`
      };
    }

    return null;
  }
}
```

## Broker Integration

### Paper Trading (Default)
```javascript
import PaperBroker from '../brokers/paperBroker.js';

const broker = new PaperBroker(100000);
broker.connected = true; // Always connected
```

### Live Trading (Zerodha Kite Connect)
```javascript
import KiteBroker from '../brokers/kiteBroker.js';

const broker = new KiteBroker({
  apiKey: process.env.KITE_API_KEY,
  apiSecret: process.env.KITE_API_SECRET,
  environment: 'sandbox'
});

await broker.connect();
await broker.subscribeSymbols(['RELIANCE', 'INFY']);
```

## Performance Metrics (Backtest)
- Total return (%)
- Win rate
- Profit factor
- Sharpe/Sortino/Calmar ratios
- Max drawdown
- Average trade duration
- Consecutive win/loss streaks

## Common Tasks

### Add New Indicator
```javascript
// src/utils/indicators.js
export function stochastic(prices, kPeriod = 14, dPeriod = 3) {
  // Implementation
}
```

### Add New Strategy
1. Create `src/strategies/newStrategy.js`
2. Extend `BaseStrategy`
3. Implement `generateSignal()`
4. Export and test

### Debug Mode
```bash
node src/app.js --mode paper --debug
```

### View Logs
```bash
tail -f logs/algo-trading-*.log
```

## Troubleshooting

**Issue: No signals generated**
- Strategy needs warmup period (default: 30 candles)
- Check `src/core/config.js` strategy config

**Issue: Orders not filling**
- Paper trading has simulated 100ms delay
- Check `src/data/marketStream.js` for data flow

**Issue: Daily loss limit hit**
- Check `src/risk/riskManager.js`
- Reset with `riskManager.resetDaily()`

## Security Notes
- Never commit API keys
- Use `.env` file for secrets
- Paper trading always preferred for testing
- Never run with `--mode live` without sandbox testing

## Testing
```bash
npm test              # Run all tests
npm run generate-data # Generate sample data
npm run start:paper  # Start paper trading
npm run start:backtest # Run backtest
```

## File Reference
- `src/app.js` - Main entry point
- `src/core/eventBus.js` - Event system
- `src/core/config.js` - Configuration
- `src/strategies/*.js` - Strategy implementations
- `src/risk/riskManager.js` - Risk management
- `src/execution/orderManager.js` - Order lifecycle
- `src/brokers/*.js` - Broker implementations
- `src/backtest/backtester.js` - Backtesting engine
- `src/utils/indicators.js` - Technical indicators
- `src/data/*.js` - Market data and candle building

## Support
- Check `logs/algo-trading-*.log` for issues
- Review `data/trading.db` for trade history
- Check `src/core/config.js` for configuration

## License
MIT - Personal project
