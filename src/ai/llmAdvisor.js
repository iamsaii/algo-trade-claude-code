/**
 * LLM Advisor
 * One Gemini REST call per trading day (free tier, native fetch — no
 * SDK). Returns normalized decision data or an empty array; it never
 * throws and never retries more than once, so a quota wall just means
 * "no trades today".
 */

import logger from '../utils/logger.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

function normalizeDecision(raw) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));
  return {
    action: String(raw.action ?? '').toUpperCase(),
    symbol: String(raw.symbol ?? '').toUpperCase(),
    product: String(raw.product ?? '').toUpperCase(),
    entry: num(raw.entry),
    stopLoss: num(raw.stopLoss ?? raw.stop_loss),
    target: num(raw.target),
    confidence: num(raw.confidence),
    rationale: String(raw.rationale ?? ''),
  };
}

function userMessage(brief) {
  const data = {
    date: brief.date,
    budget: brief.budget,
    spentToday: brief.spentToday,
    openLots: brief.openLots,
    market: brief.market,
    recentTrades: brief.recentTrades,
  };
  return [
    'You are a cautious Indian equity delivery trader. Long only. Prefer no trade over a bad trade.',
    brief.instructions,
    "Today's market brief (JSON):",
    JSON.stringify(data),
    'Respond with JSON only: {"decisions":[{"action":"BUY","symbol":"RELIANCE","product":"MIS","entry":0,"stopLoss":0,"target":0,"confidence":0,"rationale":"why"}]} — or {"decisions":[]} to stand down.',
  ].join('\n\n');
}

/**
 * @param {object} brief   From marketBrief.buildBrief()
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Function} opts.fetchFn  Injectable fetch for tests
 * @returns {Promise<Array>} normalized decisions; [] on any failure
 */
async function askAdvisor(brief, { apiKey, model, fetchFn = fetch } = {}) {
  if (!apiKey) {
    logger.warn('LLM advisor: no API key set, standing down (no trades)');
    return [];
  }

  const url = `${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: userMessage(brief) }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };

  // One retry on quota/503/bad JSON, then stand down.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        logger.warn('LLM advisor request failed', { status: res.status, attempt });
        continue;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        logger.warn('LLM advisor response missing text', { attempt });
        continue;
      }
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed?.decisions;
      if (!Array.isArray(list)) {
        logger.warn('LLM advisor JSON missing decisions array', { attempt });
        continue;
      }
      return list.map(normalizeDecision);
    } catch (error) {
      logger.warn('LLM advisor call failed', { error: error.message, attempt });
    }
  }

  logger.warn('LLM advisor standing down after retries — no trades this run');
  return [];
}

export { askAdvisor, normalizeDecision };
export default { askAdvisor, normalizeDecision };
