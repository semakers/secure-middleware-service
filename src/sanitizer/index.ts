// OWNER: sanitizer agent. Public API is fixed by the contract (CONTRACT.md §5).
// Design and rationale: docs/AI_SANITIZER.md
import { findNumberSpans } from './digits.js';
import { findEmails } from './email.js';
import { buildWorkingCopy, toNormalizedRange } from './normalize.js';
import type { PiiType, Span } from './types.js';

export type { PiiType } from './types.js';

export const PII_TYPES: readonly PiiType[] = ['EMAIL', 'CREDIT_CARD', 'SSN'] as const;

export interface SanitizeResult {
  /**
   * The redacted text. Every match is replaced by `<REDACTED: TYPE>`. When at least one match was
   * found the text is the NFKC-normalised form of the input (plus tokens); when nothing matched the
   * input is returned unchanged.
   */
  sanitized: string;
  /** How many matches of each type were replaced (all three keys always present). */
  redactions: Record<PiiType, number>;
}

export function redactionToken(type: PiiType): string {
  return `<REDACTED: ${type}>`;
}

const MIGHT_CONTAIN_PII = /[0-9@]/;

/** Detection order: emails first (they claim digits in the local part), then numbers in the gaps. */
function findSpans(text: string): Span[] {
  if (!MIGHT_CONTAIN_PII.test(text)) return [];
  const emails = findEmails(text);
  const spans: Span[] = [];
  let cursor = 0;
  for (const email of emails) {
    spans.push(...findNumberSpans(text, cursor, email.start), email);
    cursor = email.end;
  }
  spans.push(...findNumberSpans(text, cursor, text.length));
  return spans;
}

export function sanitize(input: string): SanitizeResult {
  const redactions: Record<PiiType, number> = { EMAIL: 0, CREDIT_CARD: 0, SSN: 0 };
  const wc = buildWorkingCopy(input);
  const spans = findSpans(wc.text);
  if (spans.length === 0) return { sanitized: input, redactions };

  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    const [start, end] = toNormalizedRange(wc, span.start, span.end, span.type !== 'EMAIL');
    parts.push(wc.normalized.slice(cursor, start), redactionToken(span.type));
    redactions[span.type]++;
    cursor = end;
  }
  parts.push(wc.normalized.slice(cursor));
  return { sanitized: parts.join(''), redactions };
}

/** True when sanitize() would redact anything in `input`. */
export function containsPii(input: string): boolean {
  return findSpans(buildWorkingCopy(input).text).length > 0;
}
