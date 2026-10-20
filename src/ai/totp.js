/**
 * TOTP (RFC 6238) — SHA-1, 30s step — for Zerodha's login 2FA.
 * Default 8 digits pins the RFC 6238 test vectors; Zerodha's login
 * wants the 6-digit variant (same truncated value, mod 10^6).
 */

import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=]+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`invalid base32 character: ${c}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * @param {string} secretBase32 Base32-encoded shared secret
 * @param {number} [timeSec]    Unix seconds (default: now)
 * @param {number} [digits]     8 = RFC vector / 6 = kite login code
 * @returns {string} zero-padded OTP
 */
function totp(secretBase32, timeSec = Date.now() / 1000, digits = 8) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeSec / 30)));
  const hmac = crypto
    .createHmac('sha1', base32Decode(secretBase32))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 10 ** digits).padStart(digits, '0');
}

export { totp, base32Decode };
export default totp;
