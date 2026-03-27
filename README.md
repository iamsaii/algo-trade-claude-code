# Algo-Trading Framework

A production-ready, modular, event-driven algorithmic trading framework built with Node.js. Supports backtesting, paper trading, and live trading via broker APIs.

## Features

- **Event-Driven Architecture**: Central event bus for inter-module communication
- **Multiple Strategies**: MA Crossover, RSI Mean Reversion, Breakout
- **Risk Management**: Position sizing, daily loss limits, max open trades
- **Backtesting Engine**: Historical testing with performance metrics
- **Paper Trading**: Simulated trading with realistic slippage
- **Live Trading Ready**: Kite Connect (Zerodha) adapter included
- **Trade Storage**: SQLite database for persistent trade records
- **Performance Metrics**: Sharpe ratio, drawdown, win rate, profit factor

## Installation

```bash
npm install
```

## Usage

### Paper Trading

```bash
npm run start:paper
# or
node src/app.js --mode paper
```

### Backtesting

```bash
npm run start:backtest
# or
node src/app.js --mode backtest --symbol RELIANCE --strategy movingaverage
```

### Generate Sample Data

```bash
npm run generate-data
```

## Project Structure

```
src/
├── core/
│   ├── eventBus.js       # Central event dispatcher
│   └── config.js         # Configuration management
├── data/
│   ├── marketStream.js   # Market data simulator
│   ├── candleBuilder.js  # Tick to candle aggregator
│   └── sampleData.js     # Historical data generator
├── strategies/
│   ├── baseStrategy.js            # Base strategy class
│   ├── movingAverageStrategy.js   # MA crossover
│   ├── rsiMeanReversionStrategy.js # RSI mean reversion
│   └── breakoutStrategy.js        # Support/resistance breakout
├── risk/
│   └── riskManager.js    # Risk management and checks
├── execution/
│   └── orderManager.js   # Order lifecycle management
├── brokers/
│   ├── baseBroker.js     # Broker interface
│   ├── paperBroker.js    # Paper trading simulator
│   └── kiteBroker.js     # Kite Connect adapter
├── storage/
│   └── tradeRepository.js # SQLite trade storage
├── backtest/
│   ├── backtester.js     # Backtesting engine
│   └── performance.js    # Performance metrics
├── utils/
│   ├── indicators.js     # Technical indicators
│   └── logger.js         # Winston logger
└── app.js                # Main application
```

## Configuration

Edit `src/core/config.js` to customize:

```javascript
{
  trading: {
    initialCapital: 100000,
    maxRiskPerTrade: 0.01,    // 1%
    maxDailyLoss: 0.05,       // 5%
    maxOpenTrades: 5,
  },
  market: {
    tickIntervalMs: 1000,
    candleIntervalMinutes: 5,
    symbols: ['RELIANCE', 'INFY', 'HDFCBANK'],
  },
  strategies: {
    movingAverage: { shortPeriod: 10, longPeriod: 20 },
    rsiMeanReversion: { period: 14, oversold: 30, overbought: 70 },
    breakout: { lookbackPeriod: 20 },
  },
}
```

## Event System

The framework uses an event-driven architecture:

| Event | Description |
|-------|-------------|
| `market_tick` | New price tick received |
| `candle_closed` | Candle completed |
| `trade_signal` | Strategy signal generated |
| `risk_approved` | Risk manager approved |
| `risk_rejected` | Risk manager rejected |
| `order_placed` | Order sent to broker |
| `order_filled` | Order executed |
| `position_closed` | Position closed with PnL |

## Strategies

### Moving Average Crossover
- Buy when short MA crosses above long MA (Golden Cross)
- Sell when short MA crosses below long MA (Death Cross)

### RSI Mean Reversion
- Buy when RSI bounces from oversold (<30)
- Sell when RSI rejects from overbought (>70)

### Breakout Strategy
- Buy on resistance breakout with volume confirmation
- Sell on support breakdown with volume confirmation

## Performance Metrics

The backtester calculates:
- Total Return & Return %
- Win Rate
- Profit Factor
- Sharpe Ratio
- Sortino Ratio
- Calmar Ratio
- Maximum Drawdown
- Average Trade Duration
- Consecutive Wins/Losses

## Adding Custom Strategies

```javascript
import BaseStrategy from './baseStrategy.js';

class MyStrategy extends BaseStrategy {
  generateSignal() {
    const prices = this.getClosePrices();

    // Your logic here
    if (/* buy condition */) {
      return {
        action: 'BUY',
        strength: 0.8,
        entryPrice: prices[prices.length - 1],
        stopLoss: prices[prices.length - 1] * 0.98,
        target: prices[prices.length - 1] * 1.04,
        reason: 'My signal reason',
      };
    }
    return null;
  }
}
```

## Live Trading Setup

For Kite Connect (Zerodha):

1. Install: `npm install kiteconnect`
2. Set environment variables:
   ```bash
   export KITE_API_KEY=your_api_key
   export KITE_ACCESS_TOKEN=your_access_token
   ```
3. Run: `node src/app.js --mode live`

## Logs

Logs are stored in `logs/` with daily rotation:
- Console output with colors
- JSON files for programmatic access

## Database

SQLite database stored at `data/trading.db`:
- `trades` - All executed trades
- `signals` - All strategy signals
- `daily_pnl` - Daily PnL snapshots
- `portfolio_snapshots` - Portfolio state

## Disclaimer

This framework is for educational purposes. Trading involves risk. Always test thoroughly with paper trading before using real money.

## License

MIT
