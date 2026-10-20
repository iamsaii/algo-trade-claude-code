/**
 * Quote provider
 * Kite first (live NSE quotes), single batched yfinance fallback, and
 * a symbol omitted from the result entirely if neither source has it —
 * the gate then rejects any decision on that symbol (safe default).
 */

import logger from '../utils/logger.js';

const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * @param {string[]} symbols        Base NSE symbols (e.g. ['TCS'])
 * @param {object}   opts
 * @param {object}   opts.kiteBroker Optional connected broker with getQuote()
 * @param {Function} opts.fetchFn    Injectable fetch for tests
 * @returns {Promise<Object>} { [symbol]: { ltp, prevClose, changePct } }
 */
async function getQuotes(symbols, { kiteBroker = null, fetchFn = fetch } = {}) {
  const out = {};

  // 1. Kite first — free tier may refuse quotes; any failure falls through.
  if (kiteBroker && typeof kiteBroker.getQuote === 'function') {
    try {
      if (typeof kiteBroker.isConnected !== 'function' || kiteBroker.isConnected()) {
        const kiteQuotes = await kiteBroker.getQuote(symbols);
        for (const s of symbols) {
          const q = kiteQuotes?.[s];
          if (q && typeof q.ltp === 'number' && q.ltp > 0) {
            out[s] = { ltp: q.ltp, prevClose: q.prevClose };
          }
        }
      }
    } catch (error) {
      logger.warn('Kite quotes unavailable, falling back to yfinance', { error: error.message });
    }
  }

  // 2. Batched yfinance fallback for whatever is still missing.
  const missing = symbols.filter(s => !out[s]);
  if (missing.length > 0) {
    try {
      const url = `${YAHOO_QUOTE_URL}${missing.map(s => `${s}.NS`).join(',')}`;
      const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) {
        const data = await res.json();
        for (const row of data?.quoteResponse?.result || []) {
          const base = String(row.symbol || '').replace(/\.NS$/, '');
          if (base && typeof row.regularMarketPrice === 'number' && row.regularMarketPrice > 0) {
            out[base] = { ltp: row.regularMarketPrice, prevClose: row.regularMarketPreviousClose };
          }
        }
      } else {
        logger.warn('yfinance quote request failed', { status: res.status });
      }
    } catch (error) {
      logger.warn('yfinance quotes failed', { error: error.message });
    }
  }

  // 3. Final shape; omit symbols no source could price.
  const final = {};
  for (const [symbol, q] of Object.entries(out)) {
    const prevClose = typeof q.prevClose === 'number' && q.prevClose > 0 ? q.prevClose : null;
    final[symbol] = {
      ltp: q.ltp,
      prevClose,
      changePct: prevClose ? ((q.ltp - prevClose) / prevClose) * 100 : 0,
    };
  }
  for (const s of symbols) {
    if (!final[s]) logger.warn('No quote from any source, omitting symbol', { symbol: s });
  }
  return final;
}

export { getQuotes };
export default { getQuotes };
