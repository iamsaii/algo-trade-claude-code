/**
 * AI Decide Runner
 * One-shot commands (cron): runDecide makes the morning decisions,
 * checkStops enforces broker-side-less stops in paper mode. Both are
 * idempotent — all state lives in the sqlite ledger and the daily
 * journal, never in memory.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import config from '../core/config.js';
import { tradeRepository, todayStr } from '../storage/tradeRepository.js';
import journal from './journal.js';
import quotesProvider from './quotes.js';
import { buildBrief } from './marketBrief.js';
import { askAdvisor } from './llmAdvisor.js';
import { validateDecisions } from './aiGate.js';

const HALT_FILE = fileURLToPath(new URL('../../data/TRADING_HALTED', import.meta.url));

/**
 * Kill switch: a TRADING_HALTED file in data/ stops every AI action.
 */
function halted() {
  return fs.existsSync(HALT_FILE);
}

/**
 * Realized PnL today from the ledger (buys matched to today's sells by
 * symbol at average buy price). Zero when nothing was sold today.
 */
function realizedToday(repo) {
  return repo.getRealizedToday();
}

/**
 * Morning decision run.
 *
 * @param {object} input
 * @param {object} input.broker   Paper or Kite broker (connected)
 * @param {Function} input.fetchFn Injectable fetch for quotes (tests)
 * @param {Function} input.askFn  Injectable LLM advisor (tests)
 * @param {object} input.repo     Injectable repository (tests)
 * @returns {Promise<{placed: Array, rejected: Array, skipped: string|null}>}
 */
async function runDecide({ broker, fetchFn = fetch, askFn = askAdvisor, repo = tradeRepository } = {}) {
  const budget = config.get('ai.dailyBudget');
  const lossLimitPct = config.get('ai.dailyLossLimitPct');
  const tag = config.get('ai.tag');
  const symbols = config.get('market.symbols') || [];

  // 1. Kill switch.
  if (halted()) {
    return { placed: [], rejected: [], skipped: 'TRADING_HALTED file present — kill switch engaged' };
  }

  // 2. Daily loss kill switch: stop trading for the day once realized
  //    losses reach the configured fraction of the budget.
  const realized = realizedToday(repo);
  if (realized <= -(budget * lossLimitPct)) {
    journal.append(todayStr(), { type: 'NOTE', data: { event: 'daily-loss-limit', realized, limit: -(budget * lossLimitPct) } });
    return { placed: [], rejected: [], skipped: `daily loss limit hit (realized ${realized})` };
  }

  // 3. LLM availability (default advisor needs the key; injected advisors don't).
  if (askFn === askAdvisor && !process.env.GEMINI_API_KEY) {
    journal.append(todayStr(), { type: 'NOTE', data: { event: 'no-gemini-key', detail: 'GEMINI_API_KEY not set — no trades this run' } });
    return { placed: [], rejected: [], skipped: 'GEMINI_API_KEY not set' };
  }

  // 4. Market data.
  const spentToday = repo.getSpendToday();
  const openLots = repo.getOpenAiLots();
  const q = await quotesProvider.getQuotes(symbols, { kiteBroker: broker, fetchFn });

  // 5. One LLM call.
  const brief = buildBrief({ quotes: q, symbols, budget, spentToday, openLots, recentTrades: [] });
  const decisions = await askFn(brief, { apiKey: process.env.GEMINI_API_KEY, model: config.get('ai.llm.model'), fetchFn });

  // 6. The gate — the LLM never touches quantities or the broker.
  const { accepted, rejected } = validateDecisions({ decisions, quotes: q, spentToday, openLots });

  // 7. Journal everything.
  for (const r of rejected) {
    journal.append(todayStr(), { type: 'REJECTED', data: { symbol: r.decision?.symbol, reason: r.reason } });
  }
  for (const a of accepted) {
    journal.append(todayStr(), {
      type: 'DECISION',
      data: { symbol: a.symbol, product: a.product, quantity: a.quantity, entry: a.entry, stopLoss: a.stopLoss, target: a.target, confidence: a.confidence, rationale: a.rationale },
    });
  }

  // 8. Place accepted orders, record every fill, attach a broker-side
  //    SL-M where the broker supports it (paper: ai:check enforces).
  const placed = [];
  for (const d of accepted) {
    const result = await broker.placeOrder({
      id: `AI-${Date.now()}-${d.symbol}`,
      symbol: d.symbol,
      side: 'BUY',
      quantity: d.quantity,
      entryPrice: d.entry,
      strategy: tag,
      product: d.product,
      orderType: 'LIMIT',
    });
    if (!result || !result.success) {
      journal.append(todayStr(), { type: 'ORDER-FAILED', data: { symbol: d.symbol, side: 'BUY', reason: result?.reason } });
      continue;
    }
    const filledQty = result.quantity ?? d.quantity;
    const fillPrice = result.fillPrice ?? d.entry;
    repo.recordAiFill({
      symbol: d.symbol,
      side: 'BUY',
      quantity: filledQty,
      price: fillPrice,
      product: d.product,
      kiteOrderId: result.orderId,
      reason: 'ai',
      stopLoss: d.stopLoss,
    });

    let stopPlaced = false;
    if (typeof broker.placeStopLoss === 'function') {
      const sl = await broker.placeStopLoss(d.symbol, { quantity: filledQty, triggerPrice: d.stopLoss, product: d.product });
      stopPlaced = !!(sl && sl.success);
    }
    if (!stopPlaced) {
      journal.append(todayStr(), { type: 'NOTE', data: { event: 'no-broker-stop', symbol: d.symbol, stopLoss: d.stopLoss, detail: 'stops enforced by ai:check / runEod' } });
    }
    placed.push({ symbol: d.symbol, quantity: filledQty, fillPrice, orderId: result.orderId, stopLoss: d.stopLoss, stopPlaced });
  }

  return { placed, rejected, skipped: null };
}

/**
 * Stop check (paper mode every 15 min; also the EOD backstop helper).
 * Sells open lots whose ltp touched their stored stop. Lots without a
 * stored stop are left to the EOD runner.
 *
 * @returns {Promise<{checked: number, exited: Array, skipped: string|null}>}
 */
async function checkStops({ broker, fetchFn = fetch, repo = tradeRepository } = {}) {
  if (halted()) {
    return { checked: 0, exited: [], skipped: 'TRADING_HALTED file present — kill switch engaged' };
  }

  const lots = repo.getOpenAiLots().filter(l => typeof l.stopLoss === 'number');
  if (lots.length === 0) return { checked: 0, exited: [], skipped: null };

  const q = await quotesProvider.getQuotes(lots.map(l => l.symbol), { kiteBroker: broker, fetchFn });

  const exited = [];
  for (const lot of lots) {
    const ltp = q[lot.symbol]?.ltp;
    if (typeof ltp !== 'number' || ltp > lot.stopLoss) continue;

    const result = await broker.placeOrder({
      id: `AI-STOP-${Date.now()}-${lot.symbol}`,
      symbol: lot.symbol,
      side: 'SELL',
      quantity: lot.quantity,
      entryPrice: ltp,
      strategy: config.get('ai.tag'),
      product: lot.product || 'MIS',
      orderType: 'MARKET',
    });
    if (!result || !result.success) {
      journal.append(todayStr(), { type: 'ORDER-FAILED', data: { symbol: lot.symbol, side: 'SELL', reason: result?.reason } });
      continue;
    }
    const soldQty = result.quantity ?? lot.quantity;
    const sellPrice = result.fillPrice ?? ltp;
    repo.recordAiFill({
      symbol: lot.symbol,
      side: 'SELL',
      quantity: soldQty,
      price: sellPrice,
      product: lot.product || 'MIS',
      kiteOrderId: result.orderId,
      reason: 'stop',
    });
    journal.append(todayStr(), { type: 'EXIT', data: { symbol: lot.symbol, reason: 'stop', quantity: soldQty, price: sellPrice, stopLoss: lot.stopLoss, ltp } });
    exited.push({ symbol: lot.symbol, quantity: soldQty, price: sellPrice });
  }

  return { checked: lots.length, exited, skipped: null };
}

export { runDecide, checkStops, HALT_FILE };
export default { runDecide, checkStops, HALT_FILE };
