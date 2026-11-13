import type { Span } from './types.js';

const SPACE = 1;
const DASH = 2;
const DOT = 3;

const UNICODE_SPACE = /^\p{Zs}$/u;
const UNICODE_DASH = /^[\p{Pd}\u2212]$/u;
const WORD_BEFORE = /[\p{L}\p{M}_]$/u;
const WORD_AFTER = /^[\p{L}\p{M}_]/u;

const MIN_CARD = 13;
const MAX_CARD = 19;

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** Separator class of the single character at `i` (0 = not a separator). */
function sepClass(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === 32) return SPACE;
  if (c === 45) return DASH;
  if (c === 46) return DOT;
  if (c < 0x80) return 0;
  const ch = text[i] as string;
  if (UNICODE_SPACE.test(ch)) return SPACE;
  return UNICODE_DASH.test(ch) ? DASH : 0;
}

/** A maximal sequence of digit runs joined by exactly one separator character each. */
interface Chain {
  starts: number[];
  ends: number[];
  /** seps[k] = class of the separator between run k and run k+1. */
  seps: number[];
}

function runLength(chain: Chain, r: number): number {
  return (chain.ends[r] as number) - (chain.starts[r] as number);
}

/** Exactly 9 digits: one run of 9, or AAA-GG-SSSS with one consistent separator. */
function isSsnShape(chain: Chain, first: number, last: number): boolean {
  const count = last - first + 1;
  if (count === 1) return runLength(chain, first) === 9;
  return (
    count === 3 &&
    runLength(chain, first) === 3 &&
    runLength(chain, first + 1) === 2 &&
    runLength(chain, first + 2) === 4 &&
    chain.seps[first] === chain.seps[first + 1]
  );
}

const DOUBLED = [0, 2, 4, 6, 8, 1, 3, 5, 7, 9];

/**
 * Index of the last run of the longest Luhn-valid 13-19 digit window starting at run `i`, or -1.
 * The Luhn sum is kept incrementally for both parities (which digits are doubled depends on the
 * final length, counted from the right), so a window costs O(digits), not O(digits^2).
 */
function bestCardEnd(text: string, chain: Chain, i: number): number {
  let total = 0;
  let evenDoubled = 0; // sum when digits at even offsets from the left are doubled
  let oddDoubled = 0; // sum when digits at odd offsets from the left are doubled
  let best = -1;
  for (let j = i; j < chain.starts.length; j++) {
    const len = runLength(chain, j);
    if (total + len > MAX_CARD) break;
    for (let p = chain.starts[j] as number; p < (chain.ends[j] as number); p++) {
      const d = text.charCodeAt(p) - 48;
      if (total % 2 === 0) {
        evenDoubled += DOUBLED[d] as number;
        oddDoubled += d;
      } else {
        evenDoubled += d;
        oddDoubled += DOUBLED[d] as number;
      }
      total++;
    }
    // From the right the last digit is not doubled: with an even length the doubled ones sit at
    // even offsets from the left, with an odd length at odd offsets.
    if (total >= MIN_CARD && (total % 2 === 0 ? evenDoubled : oddDoubled) % 10 === 0) best = j;
  }
  return best;
}

/** Inside an alphanumeric token (`ab123456789`, `123456789x`) a 9-digit run is not an SSN. */
function ssnInsideWord(text: string, chain: Chain, first: number, last: number): boolean {
  const start = chain.starts[first] as number;
  const end = chain.ends[last] as number;
  const leftWord = first === 0 && WORD_BEFORE.test(text.slice(Math.max(0, start - 2), start));
  const rightWord = last === chain.starts.length - 1 && WORD_AFTER.test(text.slice(end, end + 2));
  return leftWord || rightWord;
}

function processChain(text: string, chain: Chain, spans: Span[]): void {
  const runs = chain.starts.length;
  const claimed: boolean[] = new Array<boolean>(runs).fill(false);
  const claim = (first: number, last: number, type: Span['type']): void => {
    spans.push({ start: chain.starts[first] as number, end: chain.ends[last] as number, type });
    for (let r = first; r <= last; r++) claimed[r] = true;
  };

  // 1. Cards first (leftmost start, longest Luhn-valid window of 13-19 digits). One exception:
  //    an SSN-shaped group that is immediately followed by a valid card is an SSN, not the
  //    first digits of a card ("123-45-6789 4111 1111 1111 1111").
  for (let i = 0; i < runs; ) {
    let ssnLast = -1;
    if (isSsnShape(chain, i, i + 2)) ssnLast = i + 2;
    else if (runLength(chain, i) === 9) ssnLast = i;
    if (ssnLast !== -1 && !ssnInsideWord(text, chain, i, ssnLast) && bestCardEnd(text, chain, ssnLast + 1) !== -1) {
      claim(i, ssnLast, 'SSN');
      i = ssnLast + 1;
      continue;
    }
    const best = bestCardEnd(text, chain, i);
    if (best === -1) {
      i++;
    } else {
      claim(i, best, 'CREDIT_CARD');
      i = best + 1;
    }
  }

  // 2. SSN: every maximal group of unclaimed runs must be, as a whole, exactly 9 digits.
  for (let i = 0; i < runs; ) {
    if (claimed[i] === true) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < runs && claimed[j + 1] !== true) j++;
    if (isSsnShape(chain, i, j) && !ssnInsideWord(text, chain, i, j)) claim(i, j, 'SSN');
    i = j + 1;
  }
}

/** Finds card and SSN spans in `text[from, to)` (spans come out ordered by start). */
export function findNumberSpans(text: string, from: number, to: number): Span[] {
  const spans: Span[] = [];
  let i = from;
  while (i < to) {
    if (!isDigit(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const chain: Chain = { starts: [], ends: [], seps: [] };
    let p = i;
    for (;;) {
      let e = p;
      while (e < to && isDigit(text.charCodeAt(e))) e++;
      chain.starts.push(p);
      chain.ends.push(e);
      const sc = e + 1 < to ? sepClass(text, e) : 0;
      if (sc !== 0 && isDigit(text.charCodeAt(e + 1))) {
        chain.seps.push(sc);
        p = e + 1;
      } else {
        break;
      }
    }
    const before = spans.length;
    processChain(text, chain, spans);
    // cards were pushed first, then SSNs: restore start order for this chain
    if (spans.length - before > 1) {
      const added = spans.splice(before).sort((a, b) => a.start - b.start);
      spans.push(...added);
    }
    i = chain.ends[chain.ends.length - 1] as number;
  }
  return spans;
}
