/**
 * AI Journal
 * Append-only markdown audit trail: one file per day under
 * logs/journal/YYYY-MM-DD.md, one line per event so every AI decision,
 * rejection, and exit can be read in order.
 */

import fs from 'fs';
import path from 'path';
import config from '../core/config.js';

function journalPath(dateStr) {
  return path.join(config.get('logging.directory'), 'journal', `${dateStr}.md`);
}

/**
 * @param {string} dateStr  YYYY-MM-DD
 * @param {{type: string, data: object}} entry
 */
function append(dateStr, entry) {
  const file = journalPath(dateStr);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const time = new Date().toTimeString().slice(0, 5); // HH:MM local
  fs.appendFileSync(file, `- ${time} [${entry.type}] ${JSON.stringify(entry.data)}\n`);
}

function read(dateStr) {
  const file = journalPath(dateStr);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

export { append, read };
export default { append, read };
