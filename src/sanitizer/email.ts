import type { Span } from './types.js';

// Single-class greedy runs: linear, and never backtrack into each other.
const DOMAIN_RUN = /[\p{L}\p{N}\p{M}.-]+/uy;
const HAS_ALNUM = /[\p{L}\p{N}]/u;
const LOCAL_CHAR = /^[\p{L}\p{N}\p{M}._%+-]$/u;
// Final label: >= 2 letters first (xn--... punycode included), then letters/digits/hyphens.
const TLD = /^\p{L}[\p{L}\p{M}][\p{L}\p{M}\p{N}-]*$/u;

const DOT = 46;
const HYPHEN = 45;

function isLocalAscii(c: number): boolean {
  return (
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === DOT ||
    c === 95 || // _
    c === 37 || // %
    c === 43 || // +
    c === HYPHEN
  );
}

/** Length (1 or 2 UTF-16 units) of the local-part character that ends at `i`, or 0. */
function localCharBefore(text: string, i: number): number {
  const c = text.charCodeAt(i - 1);
  if (c < 0x80) return isLocalAscii(c) ? 1 : 0;
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return LOCAL_CHAR.test(text.slice(i - 2, i)) ? 2 : 0;
  }
  return LOCAL_CHAR.test(text[i - 1] as string) ? 1 : 0;
}

/**
 * End (exclusive) of the longest prefix of the domain run `[start, runEnd)` that is a valid
 * domain (a non-empty first label, at least one dot, a TLD of >= 2 letters), or -1. Trailing
 * dots/hyphens (sentence punctuation) and trailing non-TLD labels (`a@b.com.123`) are left out.
 * Each iteration moves `end` strictly left over disjoint stretches: linear overall.
 */
function validDomainEnd(text: string, start: number, runEnd: number): number {
  let end = runEnd;
  for (;;) {
    let d = end - 1;
    while (d >= start && text.charCodeAt(d) !== DOT) d--;
    if (d <= start) return -1;
    let labelEnd = end;
    while (labelEnd > d + 1 && text.charCodeAt(labelEnd - 1) === HYPHEN) labelEnd--;
    if (TLD.test(text.slice(d + 1, labelEnd))) return labelEnd;
    end = d;
  }
}

export function findEmails(text: string): Span[] {
  const spans: Span[] = [];
  let lastEnd = -1;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    DOMAIN_RUN.lastIndex = at + 1;
    const run = DOMAIN_RUN.exec(text);
    if (run === null) continue;
    const end = validDomainEnd(text, at + 1, at + 1 + run[0].length);
    if (end === -1) continue;

    // Walk left over the local part; stops at the previous '@' (not a local character),
    // so the total work over all '@' is linear.
    let start = at;
    for (let step = localCharBefore(text, start); step !== 0; step = localCharBefore(text, start)) {
      start -= step;
    }
    if (start === at || !HAS_ALNUM.test(text.slice(start, at))) continue;

    if (start < lastEnd) {
      // `a@b.com.c@d.com`: the local part of this address overlaps the previous domain.
      // Merge into one span rather than leave "@d.com" behind (over-redaction).
      const prev = spans.pop() as Span;
      start = prev.start;
    }
    spans.push({ start, end, type: 'EMAIL' });
    lastEnd = end;
  }
  return spans;
}

