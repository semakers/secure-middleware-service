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
 * Indexes of the last run of every Luhn-valid 13-19 digit window starting at run `i`, ascending.
 * The Luhn sum is kept incrementally for both parities (which digits are doubled depends on the
 * final length, counted from the right), so a window costs O(digits), not O(digits^2).
 */
function cardEnds(text: string, chain: Chain, i: number): number[] {
  let total = 0;
  let evenDoubled = 0; // sum when digits at even offsets from the left are doubled
  let oddDoubled = 0; // sum when digits at odd offsets from the left are doubled
  const ends: number[] = [];
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
    if (total >= MIN_CARD && (total % 2 === 0 ? evenDoubled : oddDoubled) % 10 === 0) ends.push(j);
  }
  return ends;
}

/** Last run of the longest Luhn-valid window starting at run `i`, or -1. */
function bestCardEnd(text: string, chain: Chain, i: number): number {
  const ends = cardEnds(text, chain, i);
  return ends.length === 0 ? -1 : (ends[ends.length - 1] as number);
}

/** Last run of an SSN-shaped group (AAA-GG-SSSS or one 9-digit run) starting at run `k`, or -1. */
function ssnShapeAt(chain: Chain, k: number): number {
  if (k >= chain.starts.length) return -1;
  if (k + 2 < chain.starts.length && isSsnShape(chain, k, k + 2)) return k + 2;
  return runLength(chain, k) === 9 ? k : -1;
}

/**
 * The longest card window, unless a shorter valid one is directly followed by an SSN-shaped group:
 * "4111 1111 1111 1111 102-45-6789" is also Luhn-valid as 19 digits ("...1111102"), and taking that
 * window would leave "-45-6789" (6 SSN digits) in clear. A card + an SSN can never both fit in one
 * 19-digit window, so the longer window always cuts the SSN and the shorter card wins.
 */
function chooseCardEnd(chain: Chain, ends: readonly number[]): number {
  for (let k = ends.length - 2; k >= 0; k--) {
    const end = ends[k] as number;
    if (ssnShapeAt(chain, end + 1) !== -1) return end;
  }
  return ends[ends.length - 1] as number;
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

  // 1. Cards first (leftmost start, longest Luhn-valid window of 13-19 digits that does not cut a
  //    following SSN, see chooseCardEnd). One exception: an SSN-shaped group that is immediately
  //    followed by a valid card is an SSN, not the first digits of a card
  //    ("123-45-6789 4111 1111 1111 1111").
  for (let i = 0; i < runs; ) {
    let ssnLast = -1;
    if (isSsnShape(chain, i, i + 2)) ssnLast = i + 2;
    else if (runLength(chain, i) === 9) ssnLast = i;
    if (ssnLast !== -1 && !ssnInsideWord(text, chain, i, ssnLast) && bestCardEnd(text, chain, ssnLast + 1) !== -1) {
      claim(i, ssnLast, 'SSN');
      i = ssnLast + 1;
      continue;
    }
    const ends = cardEnds(text, chain, i);
    if (ends.length === 0) {
      i++;
    } else {
      const best = chooseCardEnd(chain, ends);
      claim(i, best, 'CREDIT_CARD');
      i = best + 1;
    }
  }

  // 2. SSN: a maximal group of unclaimed runs that is, as a whole, exactly 9 digits; or, inside a
  //    longer group, an AAA-GG-SSSS window whose neighbours are joined by a DIFFERENT separator.
  for (let i = 0; i < runs; ) {
    if (claimed[i] === true) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < runs && claimed[j + 1] !== true) j++;
    if (isSsnShape(chain, i, j)) {
      if (!ssnInsideWord(text, chain, i, j)) claim(i, j, 'SSN');
    } else {
      claimSeparatedSsns(text, chain, i, j, claim);
    }
    i = j + 1;
  }
}

/**
 * A change of separator ends a number: in "4111-1111-1111-1112 123-45-6789" the space separates a
 * (Luhn-invalid) 16-digit number from a dashed SSN, which must not leak. A neighbour joined by the
 * SAME separator keeps the window part of a longer number ("123-45-6789-12", "1 123 45 6789").
 */
function claimSeparatedSsns(
  text: string,
  chain: Chain,
  first: number,
  last: number,
  claim: (first: number, last: number, type: Span['type']) => void,
): void {
  for (let k = first; k + 2 <= last; ) {
    const sep = chain.seps[k];
    const joinedBefore = k > first && chain.seps[k - 1] === sep;
    const joinedAfter = k + 2 < last && chain.seps[k + 2] === sep;
    if (!joinedBefore && !joinedAfter && isSsnShape(chain, k, k + 2) && !ssnInsideWord(text, chain, k, k + 2)) {
      claim(k, k + 2, 'SSN');
      k += 3;
    } else {
      k++;
    }
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
