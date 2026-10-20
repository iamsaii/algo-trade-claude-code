/**
 * Kite Connect Broker Adapter (Zerodha)
 * Placeholder implementation for future live trading integration
 *
 * To use:
 * 1. Install kiteconnect npm package
 * 2. Add API key and token to config
 * 3. Implement authentication flow
 * 4. Map Kite Connect API calls to broker interface
 *
 * Documentation: https://kite.trade/docs/connect/v3/
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import BaseBroker from './baseBroker.js';
import logger from '../utils/logger.js';
import config from '../core/config.js';
import totp from '../ai/totp.js';

// Access tokens die at ~6 AM the next day; persist same-day logins only.
const TOKEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/.kite_token.json');

class KiteBroker extends BaseBroker {
  constructor(apiConfig = {}) {
    super('KiteBroker', {
      apiKey: apiConfig.apiKey || process.env.KITE_API_KEY,
      apiSecret: apiConfig.apiSecret || process.env.KITE_API_SECRET,
      accessToken: apiConfig.accessToken || process.env.KITE_ACCESS_TOKEN,
      userId: apiConfig.userId || process.env.KITE_USER_ID,
      password: apiConfig.password || process.env.KITE_PASSWORD,
      environment: apiConfig.environment || 'live', // 'live' or 'kiteconnect'
      ...apiConfig,
    });

    this.kite = null; // Kite Connect instance
    this.connected = false;
    this.orders = new Map();
    this.positions = [];
    this.holdings = [];
    this._cookies = new Map(); // manual cookie jar for the web login steps

    // Order type mappings
    this.ORDER_TYPES = {
      MARKET: 'MARKET',
      LIMIT: 'LIMIT',
      SL: 'SL',
      SLM: 'SL-M',
    };

    // Product types
    this.PRODUCTS = {
      MIS: 'MIS',       // Intraday
      CNC: 'CNC',       // Delivery
      NRML: 'NRML',     // Carryforward
      CO: 'CO',         // Cover Order
      BO: 'BO',         // Bracket Order
    };

    logger.info('Kite Broker initialized', {
      environment: this.config.environment,
      apiKeyConfigured: !!this.config.apiKey,
    });
  }

  /**
   * Connect to Kite Connect API
   */
  async connect() {
    try {
      // Check if kiteconnect package is available
      let KiteConnect;
      try {
        const kiteconnect = await import('kiteconnect');
        KiteConnect = kiteconnect.KiteConnect;
      } catch (e) {
        logger.error('KiteConnect package not installed. Please install: npm install kiteconnect');
        return {
          success: false,
          reason: 'KiteConnect package not installed',
        };
      }

      // Initialize Kite Connect
      this.kite = new KiteConnect({
        api_key: this.config.apiKey,
      });

      // Token candidates: explicit env/manual token first, then a token
      // persisted by an earlier same-day TOTP login.
      const candidates = [];
      if (this.config.accessToken) candidates.push(this.config.accessToken);
      const persisted = this._readTokenFile();
      if (persisted && !candidates.includes(persisted)) candidates.push(persisted);

      for (const token of candidates) {
        this.kite.setAccessToken(token);
        try {
          const profile = await this.kite.getProfile();
          this.connected = true;
          this.config.accessToken = token;
          logger.info('Kite Broker connected', {
            userId: profile.user_id,
            userName: profile.user_name,
          });
          return { success: true, profile };
        } catch (error) {
          logger.warn('Kite access token rejected', { error: error.message });
        }
      }

      // No working token yet: automated TOTP login when configured.
      if (process.env.KITE_TOTP_SECRET) {
        const login = await this.loginWithTOTP();
        if (login.success) {
          this.kite.setAccessToken(login.accessToken);
          try {
            const profile = await this.kite.getProfile();
            this.connected = true;
            this.config.accessToken = login.accessToken;
            logger.info('Kite Broker connected via TOTP login', { userId: profile.user_id });
            return { success: true, profile };
          } catch (error) {
            logger.error('Kite profile check after TOTP login failed', { error: error.message });
          }
        }
      }

      if (!this.config.accessToken && !persisted) {
        // Return login URL for manual authentication
        const loginUrl = this.kite.getLoginURL(this.config.apiKey);
        logger.warn('Access token not set. Please authenticate manually', { loginUrl });

        return {
          success: false,
          requiresAuth: true,
          loginUrl,
        };
      }

      return {
        success: false,
        requiresAuth: true,
        reason: 'Authentication failed. Check access token / TOTP credentials.',
      };
    } catch (error) {
      logger.error('Kite connection error', { error: error.message });
      return {
        success: false,
        reason: error.message,
      };
    }
  }

  /**
   * Automated login: web password login -> 2FA with TOTP -> harvest the
   * one-time request_token from the redirect -> standard session/token
   * exchange (checksum = sha256(api_key + request_token + api_secret)).
   * Any failure returns {success:false, reason} and never throws.
   */
  async loginWithTOTP() {
    const { apiKey, apiSecret, userId, password } = this.config;
    const totpSecret = process.env.KITE_TOTP_SECRET;
    if (!apiKey || !apiSecret || !userId || !password || !totpSecret) {
      return {
        success: false,
        reason: 'missing KITE_API_KEY / KITE_API_SECRET / KITE_USER_ID / KITE_PASSWORD / KITE_TOTP_SECRET',
      };
    }

    try {
      // 1. Pre-login establishes the kite web session.
      const pre = await this._fetchWithCookies(
        `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}`
      );
      const refUrl = pre.url;

      // 2. User id + password login -> request_id for the 2FA step.
      const loginRes = await this._fetchWithCookies('https://kite.zerodha.com/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user_id: userId, password }),
      });
      const loginData = await loginRes.json().catch(() => null);
      if (!loginRes.ok) throw new Error(`password login rejected: ${loginData?.message || loginRes.status}`);
      const requestId = loginData?.data?.request_id;
      if (!requestId) throw new Error('password login returned no request_id');

      // 3. 2FA step — TOTP replaces the old PIN here.
      const faRes = await this._fetchWithCookies('https://kite.zerodha.com/api/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_id: userId,
          request_id: requestId,
          twofa_value: totp(totpSecret, Date.now() / 1000, 6),
        }),
      });
      const faData = await faRes.json().catch(() => null);
      if (!faRes.ok) throw new Error(`2FA rejected: ${faData?.message || faRes.status}`);

      // 4. The login URL now redirects to the registered redirect URL
      //    carrying the one-time request_token.
      const sep = refUrl.includes('?') ? '&' : '?';
      const redirectRes = await this._fetchWithCookies(`${refUrl}${sep}skip_session=true`, { redirect: 'manual' });
      const location = redirectRes.headers.get('location') || '';
      const match = location.match(/request_token=([^&]+)/);
      if (!match) throw new Error('no request_token in login redirect');
      const requestToken = decodeURIComponent(match[1]);

      // 5. Standard token exchange per Kite docs.
      const checksum = crypto.createHash('sha256').update(`${apiKey}${requestToken}${apiSecret}`).digest('hex');
      const tokenRes = await fetch('https://api.kite.trade/session/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
        body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
      });
      const tokenData = await tokenRes.json().catch(() => null);
      const accessToken = tokenData?.data?.access_token;
      if (!tokenRes.ok || !accessToken) throw new Error(`token exchange failed: ${tokenData?.message || tokenRes.status}`);

      // 6. Persist for the rest of the trading day.
      fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken, loginTime: new Date().toISOString() }, null, 2), { mode: 0o600 });
      fs.chmodSync(TOKEN_FILE, 0o600);

      this.config.accessToken = accessToken;
      this._cookies.clear();
      logger.info('Kite TOTP login succeeded, access token persisted');
      return { success: true, accessToken };
    } catch (error) {
      logger.error('Kite TOTP login failed', { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Read the access token persisted by a same-day TOTP login.
   */
  _readTokenFile() {
    try {
      if (!fs.existsSync(TOKEN_FILE)) return null;
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      return data?.accessToken || null;
    } catch (error) {
      logger.warn('Could not read persisted kite token', { error: error.message });
      return null;
    }
  }

  /**
   * fetch that carries kite's session cookies between the web login
   * steps — node's fetch is cookie-less by design.
   */
  async _fetchWithCookies(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this._cookies.size > 0) {
      headers.Cookie = [...this._cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(url, { ...opts, headers });
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this._cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  }

  /**
   * Disconnect from Kite API
   */
  async disconnect() {
    try {
      this.kite = null;
      this.connected = false;
      logger.info('Kite Broker disconnected');
      return { success: true };
    } catch (error) {
      logger.error('Kite disconnect error', { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Place order through Kite Connect
   */
  async placeOrder(order) {
    if (!this.connected) {
      return {
        success: false,
        reason: 'Not connected to Kite',
      };
    }

    try {
      // Validate order
      const validation = this.validateOrder(order);
      if (!validation.valid) {
        return { success: false, reason: validation.errors.join(', ') };
      }

      // Map order to Kite format. Kite rejects a price on MARKET orders
      // and trigger_price outside SL/SL-M, so both are conditional.
      const orderType = this.ORDER_TYPES[order.orderType] || order.orderType || 'MARKET';
      const params = {
        exchange: this._getExchange(order.symbol),
        tradingsymbol: this._getKiteSymbol(order.symbol),
        transaction_type: order.side === 'BUY' ? 'BUY' : 'SELL',
        order_type: orderType,
        product: this.PRODUCTS[order.product] || this.PRODUCTS.MIS,
        quantity: order.quantity,
        tag: order.strategy || 'algo',
      };
      if (orderType === 'LIMIT' || orderType === 'SL') {
        params.price = order.entryPrice || 0;
      }
      if (orderType === 'SL' || orderType === 'SL-M') {
        params.trigger_price = order.triggerPrice ?? order.stopLoss ?? 0;
      }

      // Place order
      const response = await this.kite.placeOrder('regular', params);

      // Store order
      this.orders.set(response.order_id, {
        ...order,
        kiteOrderId: response.order_id,
        status: 'PENDING',
      });

      logger.info('Kite order placed', {
        orderId: response.order_id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
      });

      return {
        success: true,
        orderId: response.order_id,
        ...response,
      };
    } catch (error) {
      logger.error('Kite order placement failed', {
        error: error.message,
        symbol: order.symbol,
      });

      return {
        success: false,
        reason: error.message,
        kiteError: true,
      };
    }
  }

  /**
   * Broker-side stop-loss (SL-M) placed right after a fill so it
   * survives process death. entryPrice carries the trigger so the
   * standard positive-price validation still applies.
   */
  async placeStopLoss(symbol, { quantity, triggerPrice, product = 'MIS', side = 'SELL' } = {}) {
    return this.placeOrder({
      symbol,
      side,
      quantity,
      entryPrice: triggerPrice,
      orderType: 'SLM',
      triggerPrice,
      product,
      strategy: config.get('ai.tag') || 'ai-agent',
    });
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId, variety = 'regular') {
    try {
      const response = await this.kite.cancelOrder(variety, orderId);
      logger.info('Kite order cancelled', { orderId });
      return { success: true, ...response };
    } catch (error) {
      logger.error('Kite order cancellation failed', { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Get current position for a symbol
   */
  async getPosition(symbol) {
    try {
      const positions = await this.kite.getPositions();
      const netPositions = positions.net || [];

      const kiteSymbol = this._getKiteSymbol(symbol);
      const position = netPositions.find(
        p => p.tradingsymbol === kiteSymbol
      );

      return position || null;
    } catch (error) {
      logger.error('Error fetching position', { symbol, error: error.message });
      return null;
    }
  }

  /**
   * Get account balance/margin
   */
  async getAccountBalance() {
    try {
      const margins = await this.kite.getMargins();
      return {
        success: true,
        available: margins.available,
        utilised: margins.utilised,
        total: margins.available.cash + margins.available.intraday_payin,
      };
    } catch (error) {
      logger.error('Error fetching balance', { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Get all holdings
   */
  async getHoldings() {
    try {
      const holdings = await this.kite.getHoldings();
      this.holdings = holdings;
      return holdings;
    } catch (error) {
      logger.error('Error fetching holdings', { error: error.message });
      return [];
    }
  }

  /**
   * Get all orders
   */
  async getOrders() {
    try {
      const orders = await this.kite.getOrders();
      return orders;
    } catch (error) {
      logger.error('Error fetching orders', { error: error.message });
      return [];
    }
  }

  /**
   * Get all positions, normalized to the framework contract
   * (flat/zero-quantity rows omitted). Transient failures return [].
   */
  async getPositions() {
    try {
      const positions = await this.kite.getPositions();
      this.positions = positions;
      const net = positions?.net || [];
      return net
        .filter(p => p.quantity !== 0)
        .map(p => {
          const currentPrice = typeof p.ltp === 'number' && p.ltp > 0 ? p.ltp : p.avg_price;
          return {
            symbol: p.tradingsymbol,
            side: p.quantity > 0 ? 'BUY' : 'SELL',
            quantity: Math.abs(p.quantity),
            avgPrice: p.avg_price,
            currentPrice,
            unrealizedPnL: (currentPrice - p.avg_price) * p.quantity,
          };
        });
    } catch (error) {
      logger.error('Error fetching positions', { error: error.message });
      return [];
    }
  }

  /**
   * Live NSE quotes. Throws on failure — quotes.js falls back to
   * yfinance (free-tier Kite may deny quote access; that's expected).
   */
  async getQuote(symbols) {
    if (!this.connected || !this.kite) throw new Error('Kite not connected');
    const keys = symbols.map(s => `NSE:${s}`);
    const quotes = await this.kite.getQuote(keys);
    const out = {};
    for (const s of symbols) {
      const q = quotes?.[`NSE:${s}`];
      if (q) out[s] = { ltp: q.last_price, prevClose: q.ohlc?.close };
    }
    return out;
  }

  /**
   * Get exchange for symbol
   */
  _getExchange(symbol) {
    // NSE for equity stocks
    return 'NSE';
  }

  /**
   * Convert symbol to Kite format
   */
  _getKiteSymbol(symbol) {
    // For NSE equities: SYMBOL -> SYMBOL-EQ or just SYMBOL
    // This is simplified - you may need to adjust based on your symbols
    return symbol;
  }

  /**
   * Get instrument token for a symbol
   */
  async getInstrumentToken(symbol) {
    try {
      const instruments = await this.kite.getInstruments('NSE');
      const instrument = instruments.find(i => i.tradingsymbol === symbol);
      return instrument ? instrument.instrument_token : null;
    } catch (error) {
      logger.error('Error fetching instrument token', { symbol, error: error.message });
      return null;
    }
  }

  /**
   * Get historical data
   */
  async getHistoricalData(instrumentToken, from, to, interval = '5minute') {
    try {
      const candles = await this.kite.getHistoricalData(
        instrumentToken,
        interval,
        from,
        to
      );
      return candles;
    } catch (error) {
      logger.error('Error fetching historical data', { error: error.message });
      return [];
    }
  }

  /**
   * Place GTT order (Good Till Triggered)
   */
  async placeGTTOrder(order) {
    try {
      const gttParams = {
        trigger_type: 'single',
        symbol: this._getKiteSymbol(order.symbol),
        exchange: 'NSE',
        trigger_values: [order.triggerPrice],
        last_price: order.currentPrice,
        orders: [{
          transaction_type: order.side === 'BUY' ? 'BUY' : 'SELL',
          order_type: 'LIMIT',
          product: this.PRODUCTS.CNC,
          quantity: order.quantity,
          price: order.limitPrice,
        }],
      };

      const response = await this.kite.placeGTT(gttParams);
      logger.info('Kite GTT order placed', { gttId: response });
      return { success: true, gttId: response };
    } catch (error) {
      logger.error('Kite GTT order failed', { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      ...super.getStatus(),
      environment: this.config.environment,
      apiKeyConfigured: !!this.config.apiKey,
      accessTokenSet: !!this.config.accessToken,
    };
  }
}

// Export with factory function for easier initialization
export function createKiteBroker(config) {
  return new KiteBroker(config);
}

export default KiteBroker;
