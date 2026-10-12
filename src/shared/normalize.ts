/**
 * Length-preserving text normalization used for every searchable string and every query.
 *
 * Each UTF-16 code unit maps to exactly one code unit, so an offset in the normalized text is
 * also the offset in the original text (snippets and highlights need no position mapping).
 * The mapping lowercases, folds Latin diacritics (é -> e), maps typographic punctuation to ASCII
 * (curly quotes, en/em dashes, ellipsis, exotic spaces) and turns control characters into spaces.
 * Remaining non-alphanumeric symbols outside Latin-1 (emoji, box drawing...) become \u0001.
 * Result: almost every English document normalizes to a pure Latin-1 string, which V8 stores at
 * one byte per character (half the memory of the two-byte strings that em dashes would force).
 */

let TABLE: Uint16Array | null = null;
/** 1 for code units that count as word characters after normalization */
let WORD: Uint8Array | null = null;

const SYMBOL = 0x0001;

function buildTables() {
  const t = new Uint16Array(65536);
  const w = new Uint8Array(65536);
  const letterOrDigit = /[\p{L}\p{N}]/u;
  for (let c = 0; c < 65536; c++) {
    let out = c;
    if (c < 0x80) {
      if (c >= 65 && c <= 90) out = c + 32;
      else if (c < 32 || c === 127) out = 32;
    } else if (c < 0xa0) {
      out = 32; // C1 controls (also keeps windows-1252 decoding exact)
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out = SYMBOL; // astral chars (emoji etc.)
    } else {
      const ch = String.fromCharCode(c);
      const lower = ch.toLowerCase();
      let base = lower.length === 1 ? lower : ch;
      const nfd = base.normalize('NFD');
      const b0 = nfd.charCodeAt(0);
      if (nfd.length > 1 && b0 < 0x80 && ((b0 >= 97 && b0 <= 122) || (b0 >= 65 && b0 <= 90))) {
        base = String.fromCharCode(b0 | 32);
      }
      out = base.charCodeAt(0);
      if (out > 0xff && !letterOrDigit.test(base)) out = SYMBOL;
    }
    t[c] = out;
  }
  const map = (chars: string, to: string) => {
    for (const ch of chars) t[ch.charCodeAt(0)] = to.charCodeAt(0);
  };
  map('‘’‚‛′ʼ´`', "'");
  map('“”„‟″«»', '"');
  map('‐‑‒–—―−⸺⸻', '-');
  map('…·•‣◦⁃∙', '.');
  map('              　​‌‍⁠﻿', ' ');
  map('→⇒⟶➜➔➡↦', '>');
  map('←⇐⟵', '<');
  map('×', 'x');
  map('øØ', 'o');
  map('łŁ', 'l');
  map('đĐðÐ', 'd');
  map('ß', 's');
  map('ı', 'i');
  // fullwidth ASCII
  for (let c = 0xff01; c <= 0xff5e; c++) {
    let a = c - 0xfee0;
    if (a >= 65 && a <= 90) a += 32;
    t[c] = a;
  }
  for (let c = 0; c < 65536; c++) {
    const o = t[c];
    w[c] = (o >= 48 && o <= 57) || (o >= 97 && o <= 122) || o === 95 || (o >= 0xc0 && o !== 0xd7 && o !== 0xf7 && o !== SYMBOL && o !== 32) ? 1 : 0;
  }
  // the table maps to itself for word-ness checks on normalized text
  TABLE = t;
  WORD = w;
}

export function tables() {
  if (!TABLE) buildTables();
  return { T: TABLE!, W: WORD! };
}

const NON_ASCII = /[^\x00-\x7f]/;
const ASCII_CTRL = /[\x00-\x1f\x7f]/g;
let dec1252: TextDecoder | null = null;
let dec16: TextDecoder | null = null;

/** Normalize one string (length-preserving). */
export function normalize(s: string): string {
  if (!s) return '';
  if (!NON_ASCII.test(s)) return s.toLowerCase().replace(ASCII_CTRL, ' ');
  const { T } = tables();
  const n = s.length;
  let latin1 = true;
  const u16 = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const c = T[s.charCodeAt(i)];
    u16[i] = c;
    if (c > 0xff) latin1 = false;
  }
  if (latin1) {
    const u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = u16[i];
    dec1252 ??= new TextDecoder('windows-1252');
    return dec1252.decode(u8);
  }
  dec16 ??= new TextDecoder('utf-16le');
  return dec16.decode(u16);
}

/** Normalize a user query: same mapping, then collapse whitespace. */
export function normalizeQuery(s: string): string {
  return normalize(s.replace(ASCII_CTRL, ' ')).replace(/\s+/g, ' ').trim();
}

export function isWordCode(c: number): boolean {
  return tables().W[c] === 1;
}
