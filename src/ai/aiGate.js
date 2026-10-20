/**
 * AI Gate
 * Pure validation of LLM trade decisions. Nothing reaches a broker
 * without passing every rule here. The LLM never does math; quantity
 * and spend are always computed by this gate.
 *
 * Budget semantics: the daily budget is MARGIN (rupees of buying
 * power). MIS trades count spend/leverage against it; CNC counts full
 * spend. Sale proceeds never refill the same-day budget.
 */

import config from '../core/config.js';

/**
 * @param {object} input
 * @param {Array} input.decisions   Raw LLM decisions (action, symbol, product, entry, stopLoss, target, confidence, rationale)
 * @param {object} input.quotes     { [symbol]: { ltp, prevClose } }
 * @param {number} input.spentToday Margin rupees already committed today
 * @param {Array}  input.openLots   { symbol, quantity }[] currently open
 * @returns {{ accepted: Array, rejected: Array<{decision: object, reason: string}> }}
 */
function validateDecisions({ decisions = [], quotes = {}, spentToday = 0, openLots = [] } = {}) {
  const dailyBudget = config.get('ai.dailyBudget');
  const maxTrades = config.get('ai.maxTrades');
  const misLeverage = config.get('ai.misLeverage');

  const accepted = [];
  const rejected = [];
  const heldSymbols = new Set((openLots || []).map(l => l.symbol));
  let marginUsed = Number(spentToday) || 0;
  // Structurally-valid decisions evaluated so far, seeded with the lots
  // already held: overnight CNC lots and same-day re-runs consume the
  // daily cap too — the cap is "trades per day", not "per process".
  let evaluated = (openLots || []).length;

  for (const d of decisions || []) {
    const reject = (reason) => { rejected.push({ decision: d, reason }); };

    if (!d || d.action !== 'BUY') {
      reject('SELL decisions are not allowed; exits are stop-loss/EOD only');
      continue;
    }
    const quote = quotes[d.symbol];
    if (!quote || typeof quote.ltp !== 'number' || !(quote.ltp > 0)) {
      reject('symbol not in watchlist');
      continue;
    }
    if (d.product !== 'MIS' && d.product !== 'CNC') {
      reject('invalid product');
      continue;
    }
    if (typeof d.entry !== 'number' || !(d.entry > 0)) {
      reject('invalid entry price');
      continue;
    }
    if (typeof d.stopLoss !== 'number' || !(d.stopLoss < d.entry)) {
      reject('stop-loss must be below entry');
      continue;
    }
    // An SL at or above the live price is already triggered: the buy
    // would fill and stop out instantly — a guaranteed loss.
    if (typeof d.stopLoss !== 'number' || !(d.stopLoss < quote.ltp)) {
      reject('stop-loss must be below current market price');
      continue;
    }
    if (typeof d.target !== 'number' || !(d.target > d.entry)) {
      reject('target must be above entry');
      continue;
    }
    if (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1) {
      reject('invalid confidence');
      continue;
    }

    // Evaluation cap before sizing: maxTrades viable decisions per run.
    if (evaluated >= maxTrades) {
      reject('max trades for today reached');
      continue;
    }
    evaluated++;

    const leverage = d.product === 'MIS' ? misLeverage : 1;
    const budgetLeft = dailyBudget - marginUsed;
    const quantity = Math.floor((budgetLeft * leverage) / quote.ltp);
    if (quantity < 1) {
      reject('cannot afford even 1 share within remaining budget');
      continue;
    }
    const spend = quantity * quote.ltp;
    const margin = spend / leverage;
    if (marginUsed + margin > dailyBudget) {
      reject('daily budget exceeded');
      continue;
    }
    if (heldSymbols.has(d.symbol)) {
      reject('already holding this symbol');
      continue;
    }

    marginUsed += margin;
    heldSymbols.add(d.symbol);
    accepted.push({ ...d, quantity, spend });
  }

  return { accepted, rejected };
}

export { validateDecisions };
export default { validateDecisions };
