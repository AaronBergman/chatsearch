/**
 * Query syntax (all optional, Google-ish):
 *   plane wifi          every word must appear (as a substring, case/accents ignored)
 *   "fleet week"        exact phrase
 *   -boeing             exclude chats containing a word
 *   from:me / from:ai   only match your messages / the assistant's
 *   in:title            only match titles
 *   claude: / chatgpt:  (or source:claude) restrict to one service
 *   is:starred          starred chats
 *   after:2026-09-01  before:2026-10  after:7d  (d, w, m, y relative)
 */
import { normalizeQuery } from './normalize';
import type { Source } from './types';

export interface Term {
  raw: string;
  norm: string;
  phrase: boolean;
}

export interface ParsedQuery {
  terms: Term[];
  neg: Term[];
  titleOnly: boolean;
  role?: 'user' | 'assistant';
  sources?: Source[];
  starred?: boolean;
  since?: number;
  until?: number;
  /** the free-text part (no operators), normalized */
  text: string;
  /** free text as typed (no operators) */
  rawText: string;
  hasOperators: boolean;
}

const DAY = 86400000;

function parseDate(v: string, end: boolean, now: number): number | undefined {
  const rel = /^(\d+)([dwmy])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = unit === 'd' ? DAY : unit === 'w' ? 7 * DAY : unit === 'm' ? 30 * DAY : 365 * DAY;
    return now - n * mult;
  }
  if (/^\d{4}$/.test(v)) return end ? Date.UTC(Number(v) + 1, 0, 1) : Date.UTC(Number(v), 0, 1);
  const ym = /^(\d{4})-(\d{1,2})$/.exec(v);
  if (ym) {
    const y = Number(ym[1]),
      m = Number(ym[2]) - 1;
    return end ? Date.UTC(y, m + 1, 1) : Date.UTC(y, m, 1);
  }
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return end ? t + DAY : t;
  return undefined;
}

export function parseQuery(input: string, now = Date.now()): ParsedQuery {
  const q: ParsedQuery = { terms: [], neg: [], titleOnly: false, text: '', rawText: '', hasOperators: false };
  const free: string[] = [];
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m[2] !== undefined) {
      const raw = m[2];
      const norm = normalizeQuery(raw);
      if (!norm) continue;
      const t = { raw, norm, phrase: true };
      if (m[1]) q.neg.push(t);
      else {
        q.terms.push(t);
        free.push(raw);
      }
      continue;
    }
    const tok = m[3];
    const op = /^([a-z]+):(.*)$/i.exec(tok);
    if (op) {
      const key = op[1].toLowerCase();
      const val = op[2].toLowerCase();
      let handled = true;
      if (key === 'from' && ['me', 'user', 'you', 'mine', 'i'].includes(val)) q.role = 'user';
      else if (key === 'from' && ['ai', 'assistant', 'claude', 'gpt', 'chatgpt', 'bot', 'model'].includes(val)) q.role = 'assistant';
      else if (key === 'in' && val === 'title') q.titleOnly = true;
      else if ((key === 'source' || key === 'is' || key === 'site') && ['claude', 'anthropic'].includes(val)) q.sources = ['claude'];
      else if ((key === 'source' || key === 'is' || key === 'site') && ['chatgpt', 'gpt', 'openai'].includes(val)) q.sources = ['chatgpt'];
      else if (key === 'claude' && val === '') q.sources = ['claude'];
      else if ((key === 'chatgpt' || key === 'gpt') && val === '') q.sources = ['chatgpt'];
      else if (key === 'is' && (val === 'starred' || val === 'star' || val === 'pinned')) q.starred = true;
      else if ((key === 'after' || key === 'since') && val) {
        const d = parseDate(val, false, now);
        if (d === undefined) handled = false;
        else q.since = d;
      } else if (key === 'before' && val) {
        const d = parseDate(val, false, now);
        if (d === undefined) handled = false;
        else q.until = d;
      } else handled = false;
      if (handled) {
        q.hasOperators = true;
        continue;
      }
    }
    const neg = tok.length > 1 && tok.startsWith('-');
    const raw = neg ? tok.slice(1) : tok;
    const norm = normalizeQuery(raw);
    if (!norm) continue;
    const t = { raw, norm, phrase: false };
    if (neg) q.neg.push(t);
    else {
      q.terms.push(t);
      free.push(raw);
    }
  }
  q.rawText = free.join(' ');
  q.text = normalizeQuery(q.rawText);
  return q;
}
