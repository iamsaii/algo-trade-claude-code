/**
 * Sample Data Generator
 * Generates realistic historical candle data for backtesting
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generate realistic price data using geometric Brownian motion
 */
function generatePriceSeries(startPrice, numCandles, volatility = 0.02) {
  const prices = [startPrice];

  for (let i = 1; i < numCandles; i++) {
    const prevPrice = prices[i - 1];

    // Random return with drift and volatility
    const drift = 0.0001; // Slight upward bias
    const randomReturn = (Math.random() - 0.5) * 2 * volatility;
    const newPrice = prevPrice * (1 + drift + randomReturn);

    prices.push(Math.max(newPrice, prevPrice * 0.9)); // Limit downside
  }

  return prices;
}

/**
 * Generate OHLC candles from price series
 */
function generateCandles(prices, numCandles, startTime) {
  const candles = [];
  const intervalMs = 5 * 60 * 1000; // 5 minutes

  for (let i = 0; i < numCandles; i++) {
    const open = prices[i];
    const close = prices[i + 1] || prices[i];

    // Generate high/low based on open/close
    const range = Math.abs(close - open) * (1 + Math.random() * 2);
    let high, low;

    if (close >= open) {
      high = Math.max(open, close) + Math.random() * range;
      low = Math.min(open, close) - Math.random() * range * 0.5;
    } else {
      high = Math.max(open, close) + Math.random() * range * 0.5;
      low = Math.min(open, close) - Math.random() * range;
    }

    // Ensure high >= open, close >= low
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);

    // Generate volume
    const baseVolume = 10000 + Math.random() * 50000;
    const volume = Math.floor(baseVolume * (1 + Math.random()));

    candles.push({
      timestamp: startTime + i * intervalMs,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    });
  }

  return candles;
}

/**
 * Generate historical data for a symbol
 */
function generateSymbolData(symbol, numCandles = 1000, startTime = null) {
  const basePrices = {
    'RELIANCE': 2500,
    'INFY': 1500,
    'HDFCBANK': 1600,
    'TCS': 3800,
    'ICICIBANK': 1000,
    'SBIN': 600,
    'BHARTIARTL': 900,
    'ITC': 450,
    'KOTAKBANK': 1800,
    'LT': 3500,
  };

  const startPrice = basePrices[symbol] || 1000;
  const prices = generatePriceSeries(startPrice, numCandles + 1, 0.02);

  // Default start time: 30 days ago
  if (!startTime) {
    startTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
  }

  return generateCandles(prices, numCandles, startTime);
}

/**
 * Generate data for all symbols
 */
function generateAllSymbolsData(numCandles = 1000) {
  const symbols = [
    'RELIANCE', 'INFY', 'HDFCBANK', 'TCS', 'ICICIBANK',
    'SBIN', 'BHARTIARTL', 'ITC', 'KOTAKBANK', 'LT'
  ];

  const allData = {};
  const startTime = Date.now() - 30 * 24 * 60 * 60 * 1000;

  symbols.forEach(symbol => {
    allData[symbol] = generateSymbolData(symbol, numCandles, startTime);
    console.log(`Generated ${numCandles} candles for ${symbol}`);
  });

  return allData;
}

/**
 * Save data to JSON file
 */
function saveDataToFile(data, filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Data saved to ${filePath}`);
}

/**
 * Load data from JSON file
 */
function loadDataFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Generate and save sample data
 */
function main() {
  console.log('Generating sample historical data...\n');

  const numCandles = 1000;
  const allData = generateAllSymbolsData(numCandles);

  // Save combined file
  const outputPath = path.join(__dirname, '../../data/historical/sample-data.json');
  saveDataToFile(allData, outputPath);

  // Also save individual symbol files
  const symbolsDir = path.join(__dirname, '../../data/historical/symbols');
  if (!fs.existsSync(symbolsDir)) {
    fs.mkdirSync(symbolsDir, { recursive: true });
  }

  Object.entries(allData).forEach(([symbol, candles]) => {
    const symbolPath = path.join(symbolsDir, `${symbol}.json`);
    saveDataToFile(candles, symbolPath);
  });

  console.log('\nSample data generation complete!');
  console.log(`Total symbols: ${Object.keys(allData).length}`);
  console.log(`Candles per symbol: ${numCandles}`);
}

// Export functions
export {
  generateSymbolData,
  generateAllSymbolsData,
  generateCandles,
  generatePriceSeries,
  saveDataToFile,
  loadDataFromFile,
};

// Run if executed directly
if (process.argv[1] && process.argv[1].includes('sampleData.js')) {
  main();
}

export default {
  generateSymbolData,
  generateAllSymbolsData,
  generateCandles,
  generatePriceSeries,
  saveDataToFile,
  loadDataFromFile,
  main,
};
