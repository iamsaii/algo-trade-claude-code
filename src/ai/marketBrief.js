/**
 * Market Brief
 * Assembles everything the LLM gets to see: budget state, today's
 * quotes, open AI lots, and recent trade outcomes — plus the standing
 * instructions. The LLM reads data; it never computes.
 */

import config from '../core/config.js';
import { todayStr } from '../storage/tradeRepository.js';

/**
 * @param {object} input
 * @param {object} input.quotes        { [symbol]: { ltp, prevClose, changePct } }
 * @param {string[]} input.symbols     Watchlist (config market.symbols)
 * @param {number} input.budget        Daily margin budget
 * @param {number} input.spentToday    Margin already committed today
 * @param {Array} input.openLots       { symbol, quantity }[]
 * @param {Array} input.recentTrades   { symbol, pnl, exitReason }[]
 * @returns {object} plain JSON-able brief
 */
function buildBrief({ quotes = {}, symbols = [], budget = 0, spentToday = 0, openLots = [], recentTrades = [] } = {}) {
  const leverage = config.get('ai.misLeverage');
  const market = symbols
    .filter(s => quotes[s])
    .map(s => ({
      symbol: s,
      ltp: quotes[s].ltp,
      prevClose: quotes[s].prevClose,
      changePct: quotes[s].changePct,
    }));

  const instructions = [
    'You are a cautious Indian equity delivery trader. Long only. Prefer no trade over a bad trade.',
    `Daily margin budget: Rs ${budget}, already committed today: Rs ${spentToday}. The budget resets at market open; sale proceeds never refill it.`,
    `Product: MIS = intraday with about ${leverage}x leverage, always squared off same day; CNC = delivery, can be held overnight.`,
    'Every BUY needs a stop-loss below its entry price. No stop-loss, no trade.',
    'Goal: small profit, total loss as low as possible.',
    'An empty decision list ({"decisions": []}, i.e. no trade at all) is a valid and respectable answer.',
    `Only BUY decisions, only symbols present in the market list, at most as many trades as the budget allows.`,
  ].join('\n');

  return {
    date: todayStr(),
    budget,
    spentToday,
    openLots,
    market,
    recentTrades,
    instructions,
  };
}

export { buildBrief };
export default { buildBrief };
