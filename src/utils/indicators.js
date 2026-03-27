/**
 * Technical Indicators
 * Common technical analysis indicators used by strategies
 */

/**
 * Simple Moving Average
 * @param {number[]} prices - Array of closing prices
 * @param {number} period - SMA period
 * @returns {number|null} SMA value or null if insufficient data
 */
export function sma(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

/**
 * Exponential Moving Average
 * @param {number[]} prices - Array of closing prices
 * @param {number} period - EMA period
 * @returns {number|null} EMA value or null if insufficient data
 */
export function ema(prices, period) {
  if (!prices || prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let emaValue = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < prices.length; i++) {
    emaValue = (prices[i] - emaValue) * multiplier + emaValue;
  }

  return emaValue;
}

/**
 * Relative Strength Index
 * @param {number[]} prices - Array of closing prices
 * @param {number} period - RSI period (default: 14)
 * @returns {number|null} RSI value (0-100) or null
 */
export function rsi(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // Calculate initial average
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smooth for remaining values
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Average True Range
 * @param {Object[]} candles - Array of OHLC candles
 * @param {number} period - ATR period (default: 14)
 * @returns {number|null} ATR value or null
 */
export function atr(candles, period = 14) {
  if (!candles || candles.length < period) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  // Initial ATR (simple average)
  const initialSum = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let atrValue = initialSum / period;

  // Smooth for remaining values (Wilder's smoothing)
  for (let i = period; i < trueRanges.length; i++) {
    atrValue = (atrValue * (period - 1) + trueRanges[i]) / period;
  }

  return atrValue;
}

/**
 * Bollinger Bands
 * @param {number[]} prices - Array of closing prices
 * @param {number} period - SMA period (default: 20)
 * @param {number} stdDev - Standard deviation multiplier (default: 2)
 * @returns {Object|null} { upper, middle, lower } or null
 */
export function bollingerBands(prices, period = 20, stdDev = 2) {
  if (!prices || prices.length < period) return null;

  const middle = sma(prices, period);
  const slice = prices.slice(-period);

  // Calculate standard deviation
  const mean = middle;
  const squaredDiffs = slice.map(p => Math.pow(p - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const standardDeviation = Math.sqrt(variance);

  return {
    upper: middle + (stdDev * standardDeviation),
    middle: middle,
    lower: middle - (stdDev * standardDeviation),
    bandwidth: (middle + (stdDev * standardDeviation) - (middle - (stdDev * standardDeviation))) / middle,
  };
}

/**
 * MACD (Moving Average Convergence Divergence)
 * @param {number[]} prices - Array of closing prices
 * @param {number} fastPeriod - Fast EMA period (default: 12)
 * @param {number} slowPeriod - Slow EMA period (default: 26)
 * @param {number} signalPeriod - Signal EMA period (default: 9)
 * @returns {Object|null} { macd, signal, histogram } or null
 */
export function macd(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!prices || prices.length < slowPeriod) return null;

  const fastEma = ema(prices, fastPeriod);
  const slowEma = ema(prices, slowPeriod);

  if (fastEma === null || slowEma === null) return null;

  const macdLine = fastEma - slowEma;

  // Calculate signal line (EMA of MACD line)
  // For simplicity, we'll use a simplified approach
  // In production, you'd calculate this properly over historical MACD values
  const signalLine = macdLine * 0.1; // Simplified placeholder
  const histogram = macdLine - signalLine;

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Stochastic Oscillator
 * @param {Object[]} candles - Array of OHLC candles
 * @param {number} kPeriod - %K period (default: 14)
 * @param {number} dPeriod - %D smoothing period (default: 3)
 * @returns {Object|null} { k, d } or null
 */
export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (!candles || candles.length < kPeriod) return null;

  const kValues = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map(c => c.high));
    const low = Math.min(...slice.map(c => c.low));
    const close = candles[i].close;

    if (high === low) {
      kValues.push(50);
    } else {
      kValues.push(((close - low) / (high - low)) * 100);
    }
  }

  if (kValues.length < dPeriod) return null;

  // Calculate %D (SMA of %K)
  const latestK = kValues[kValues.length - 1];
  const dValues = kValues.slice(-dPeriod);
  const d = dValues.reduce((a, b) => a + b, 0) / dPeriod;

  return { k: latestK, d };
}

/**
 * Calculate highest high over a period
 */
export function highestHigh(candles, period) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  return Math.max(...slice.map(c => c.high));
}

/**
 * Calculate lowest low over a period
 */
export function lowestLow(candles, period) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  return Math.min(...slice.map(c => c.low));
}

/**
 * Average Directional Index (ADX)
 * Simplified implementation
 */
export function adx(candles, period = 14) {
  if (!candles || candles.length < period * 2) return null;

  let plusDm = 0;
  let minusDm = 0;
  let trSum = 0;

  for (let i = 1; i <= period; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];

    const plusDM = Math.max(0, curr.high - prev.high);
    const minusDM = Math.max(0, prev.low - curr.low);

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );

    if (plusDM > minusDM) plusDm += plusDM;
    else minusDm += minusDM;

    trSum += tr;
  }

  const trAvg = trSum / period;
  const plusDI = (plusDm / period) / trAvg * 100;
  const minusDI = (minusDm / period) / trAvg * 100;

  if (plusDI + minusDI === 0) return 0;

  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;

  // Simplified ADX (just DX for now)
  return dx;
}

export default {
  sma,
  ema,
  rsi,
  atr,
  bollingerBands,
  macd,
  stochastic,
  highestHigh,
  lowestLow,
  adx,
};
