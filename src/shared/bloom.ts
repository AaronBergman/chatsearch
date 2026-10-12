/**
 * Per-document trigram Bloom filters.
 *
 * A classic positional trigram index over every chat would cost more memory than the text itself,
 * so instead each conversation gets a small Bloom filter of the trigrams it contains (about 8 bits
 * per distinct trigram, two hash functions, ~5% false positives per trigram). A query of n
 * trigrams prunes a document unless all 2n bits are set, so a 5-letter query (3 trigrams) rejects
 * ~99.99% of non-matching documents in well under a millisecond for 10k chats. Survivors are
 * verified with a real substring scan, so results are always exact.
 */

const SEP = 0;

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function trigramHash(a: number, b: number, c: number): number {
  return mix(Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x632be5ab, 0x85ebca77) ^ Math.imul(c + 0x2c1b3c6d, 0xc2b2ae3d));
}

let scratch = new Uint32Array(1 << 10);

/** Estimate distinct trigrams via linear counting. */
function estimateDistinct(s: string): number {
  const n = s.length;
  if (n < 3) return 0;
  let bits = 1024;
  while (bits < n * 2 && bits < 1 << 21) bits <<= 1;
  const words = bits >>> 5;
  if (scratch.length < words) scratch = new Uint32Array(words);
  else scratch.fill(0, 0, words);
  const mask = bits - 1;
  let a = s.charCodeAt(0), b = s.charCodeAt(1);
  for (let i = 2; i < n; i++) {
    const c = s.charCodeAt(i);
    if (a !== SEP && b !== SEP && c !== SEP) {
      const h = trigramHash(a, b, c) & mask;
      scratch[h >>> 5] |= 1 << (h & 31);
    }
    a = b;
    b = c;
  }
  let set = 0;
  for (let i = 0; i < words; i++) {
    let v = scratch[i];
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    set += (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
  }
  const zero = bits - set;
  if (zero === 0) return bits * 4;
  return Math.ceil(-bits * Math.log(zero / bits));
}

const BITS_PER_ITEM = 8;

/** Build a Bloom filter for the trigrams of normalized text (title + body). */
export function buildBloom(texts: string[]): Uint32Array {
  let distinct = 0;
  for (const t of texts) distinct += estimateDistinct(t);
  let m = Math.max(256, Math.min(1 << 24, distinct * BITS_PER_ITEM));
  m = (m + 31) & ~31;
  const bloom = new Uint32Array(m >>> 5);
  for (const s of texts) {
    const n = s.length;
    if (n < 3) continue;
    let a = s.charCodeAt(0), b = s.charCodeAt(1);
    for (let i = 2; i < n; i++) {
      const c = s.charCodeAt(i);
      if (a !== SEP && b !== SEP && c !== SEP) {
        const h1 = trigramHash(a, b, c);
        const x = h1 % m;
        bloom[x >>> 5] |= 1 << (x & 31);
        const y = mix(h1 ^ 0x5bd1e995) % m;
        bloom[y >>> 5] |= 1 << (y & 31);
      }
      a = b;
      b = c;
    }
  }
  return bloom;
}

/** Precomputed hash pairs for the distinct trigrams of a (normalized) query term. */
export function queryTrigrams(term: string): Uint32Array {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 2; i < term.length; i++) {
    const h1 = trigramHash(term.charCodeAt(i - 2), term.charCodeAt(i - 1), term.charCodeAt(i));
    if (seen.has(h1)) continue;
    seen.add(h1);
    out.push(h1, mix(h1 ^ 0x5bd1e995));
  }
  return Uint32Array.from(out);
}

export function bloomHasAll(bloom: Uint32Array, hashes: Uint32Array): boolean {
  const m = bloom.length << 5;
  if (m === 0) return hashes.length === 0;
  for (let i = 0; i < hashes.length; i++) {
    const x = hashes[i] % m;
    if ((bloom[x >>> 5] & (1 << (x & 31))) === 0) return false;
  }
  return true;
}
