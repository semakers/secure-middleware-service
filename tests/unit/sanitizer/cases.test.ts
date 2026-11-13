import { describe, expect, it } from 'vitest';
import { group, withLuhn } from './helpers.js';
import { containsPii, PII_TYPES, redactionToken, sanitize } from '../../../src/sanitizer/index.js';

const E = '<REDACTED: EMAIL>';
const C = '<REDACTED: CREDIT_CARD>';
const S = '<REDACTED: SSN>';
const ZW = '​';

interface Case {
  name: string;
  input: string;
  expected: string;
  counts?: Partial<Record<'EMAIL' | 'CREDIT_CARD' | 'SSN', number>>;
}

const cases: Case[] = [
  // --- e-mail ---------------------------------------------------------------------------
  { name: 'plain email', input: 'mail bob@example.com now', expected: `mail ${E} now` },
  { name: 'plus tag', input: 'a+tag@x.io', expected: E },
  { name: 'dots, underscore, percent, hyphen in local', input: 'first.last_x%y-z@x.io', expected: E },
  { name: 'subdomains', input: 'a@mail.eu.example.co.uk!', expected: `${E}!` },
  { name: 'trailing sentence period', input: 'Write to a@b.com.', expected: `Write to ${E}.` },
  { name: 'trailing comma and paren', input: '(a@b.com), c@d.org;', expected: `(${E}), ${E};`, counts: { EMAIL: 2 } },
  { name: 'accented local part and domain', input: 'josé@ejemplo.es', expected: E },
  { name: 'CJK IDN', input: '用户@例子.中国', expected: E },
  { name: 'punycode TLD', input: 'a@b.xn--p1ai', expected: E },
  { name: 'digits-only local part is one EMAIL, not an SSN', input: '123456789@x.com', expected: E, counts: { SSN: 0 } },
  { name: 'card-like local part is one EMAIL', input: '4111111111111111@x.com', expected: E, counts: { CREDIT_CARD: 0 } },
  { name: 'trailing non-TLD label is left out', input: 'a@b.com.123', expected: `${E}.123` },
  { name: 'chained addresses merge into one', input: 'a@b.com.c@d.com', expected: E },
  { name: 'a@b is not an email', input: 'a@b', expected: 'a@b' },
  { name: '@x.com is not an email', input: '@x.com', expected: '@x.com' },
  { name: 'user@ is not an email', input: 'user@ here', expected: 'user@ here' },
  { name: 'one-letter TLD is not an email', input: 'a@b.c', expected: 'a@b.c' },
  { name: 'dot right after @ is not an email', input: 'a@.com', expected: 'a@.com' },
  { name: 'punctuation-only local part is not an email', input: '...@x.com', expected: '...@x.com' },
  { name: 'astral letters in the local part', input: '𠀀𠀁@x.com', expected: E },
  { name: 'astral non-local char stops the local part', input: '😀a@x.com', expected: `😀${E}` },
  { name: 'mark after the TLD stays inside the match', input: 'a@b.coḿ x', expected: `${E} x` },
  { name: 'TLD with trailing hyphen', input: 'a@b.com-', expected: `${E}-` },

  // --- credit cards ---------------------------------------------------------------------
  { name: 'Visa contiguous', input: '4111111111111111', expected: C },
  { name: 'Visa spaces', input: 'card 4111 1111 1111 1111 ok', expected: `card ${C} ok` },
  { name: 'Visa dashes', input: '4111-1111-1111-1111', expected: C },
  { name: 'Visa dots', input: '4111.1111.1111.1111', expected: C },
  { name: 'Mastercard', input: '5555 5555 5555 4444', expected: C },
  { name: 'Amex 4-6-5', input: '3782 822463 10005', expected: C },
  { name: 'Amex contiguous', input: '378282246310005', expected: C },
  { name: 'Discover', input: '6011 1111 1111 1117', expected: C },
  { name: 'Visa 13 digits', input: '4222222222222', expected: C },
  { name: '19 digits', input: withLuhn('620000000000000000'), expected: C },
  { name: 'odd grouping 2-3-5-6', input: '41-111-11111-111111', expected: C },
  { name: 'mixed separators', input: '4111 1111-1111.1111', expected: C },
  { name: 'Luhn-invalid 16 digits untouched, and not an SSN', input: '4111 1111 1111 1112', expected: '4111 1111 1111 1112' },
  { name: 'Luhn-invalid contiguous 16 digits', input: '1234567812345678', expected: '1234567812345678' },
  { name: '12 Luhn-valid digits is too short for a card', input: withLuhn('41111111111'), expected: withLuhn('41111111111') },
  { name: '12 Luhn-valid digits, grouped', input: group(withLuhn('41111111111'), [4, 4, 4], ' '), expected: group(withLuhn('41111111111'), [4, 4, 4], ' ') },
  { name: '20 Luhn-valid contiguous digits is not a card', input: withLuhn('4111111111111111111'), expected: withLuhn('4111111111111111111') },
  { name: 'double separator breaks the card', input: '4111  1111  1111  1111', expected: '4111  1111  1111  1111' },
  { name: 'card glued to letters is still redacted', input: 'id4111111111111111x', expected: `id${C}x` },
  { name: 'two cards', input: '4111111111111111, 5555555555554444', expected: `${C}, ${C}`, counts: { CREDIT_CARD: 2 } },

  // --- SSN ------------------------------------------------------------------------------
  { name: 'SSN dashes', input: 'ssn 123-45-6789.', expected: `ssn ${S}.` },
  { name: 'SSN spaces', input: '123 45 6789', expected: S },
  { name: 'SSN dots', input: '123.45.6789', expected: S },
  { name: 'SSN contiguous', input: 'SSN:123456789', expected: `SSN:${S}` },
  { name: 'mixed separators are not an SSN', input: '123-45 6789', expected: '123-45 6789' },
  { name: '10 digits is not an SSN', input: '1234567890', expected: '1234567890' },
  { name: '8 digits is not an SSN', input: '12345678', expected: '12345678' },
  { name: 'decimal is not an SSN', input: '123456789.5', expected: '123456789.5' },
  { name: 'SSN followed by sentence period', input: 'It is 123456789.', expected: `It is ${S}.` },
  { name: 'longer separated sequence is not an SSN', input: '123-45-6789-12', expected: '123-45-6789-12' },
  { name: 'inside an alphanumeric token', input: 'ab123456789 | 123456789x | _123456789', expected: 'ab123456789 | 123456789x | _123456789' },
  { name: 'wrong grouping 3-3-3 is not an SSN', input: '123-456-789', expected: '123-456-789' },
  { name: 'two SSNs', input: '123-45-6789 and 987-65-4321', expected: `${S} and ${S}`, counts: { SSN: 2 } },
  { name: 'SSN next to a comma', input: '123456789,987654321', expected: `${S},${S}` },

  // --- overlaps -------------------------------------------------------------------------
  {
    name: 'card then SSN in one sentence',
    input: '4111 1111 1111 1111 123-45-6789',
    expected: `${C} ${S}`,
    counts: { CREDIT_CARD: 1, SSN: 1 },
  },
  { name: 'SSN then card', input: '123-45-6789 4111 1111 1111 1111', expected: `${S} ${C}` },
  { name: 'card inside a longer digit sequence keeps nothing as SSN', input: '4111-1111-1111-1112 5', expected: '4111-1111-1111-1112 5' },
  { name: 'email, card and SSN', input: 'a@b.com 4111111111111111 123-45-6789', expected: `${E} ${C} ${S}`, counts: { EMAIL: 1, CREDIT_CARD: 1, SSN: 1 } },

  // --- Unicode --------------------------------------------------------------------------
  { name: 'fullwidth digits', input: '４１１１　１１１１　１１１１　１１１１', expected: C },
  { name: 'fullwidth @ and dot', input: 'a＠b．com', expected: E },
  { name: 'zero-width space inside a card', input: `4111${ZW}1111${ZW}1111${ZW}1111`, expected: C },
  { name: 'zero-width joiner / BOM / soft hyphen inside an SSN', input: '123‍-45﻿-67­89', expected: S },
  { name: 'zero-width chars inside an email', input: `bob${ZW}@exa⁠mple.com`, expected: E },
  { name: 'NBSP separators', input: '4111 1111 1111 1111', expected: C },
  { name: 'other Unicode spaces', input: '123 45 6789', expected: S },
  { name: 'Unicode dashes as separators', input: '123\u201045\u20116789', expected: S },
  { name: 'combining marks after digits', input: '4́111 1111 1111 1111', expected: C },
  { name: 'keycap digits', input: '1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣', expected: S },
  { name: 'Arabic-Indic digits', input: '٤١١١ ١١١١ ١١١١ ١١١١', expected: C },
  { name: 'circled digits', input: '①②③-④⑤-⑥⑦⑧⑨', expected: S },
  { name: 'emoji and RTL text around a card', input: '👍 مرحبا 4111 1111 1111 1111 😀', expected: `👍 مرحبا ${C} 😀` },
  { name: 'ZWJ emoji far from any PII is untouched when something else matches', input: '👩‍💻 a@b.com', expected: `👩‍💻 ${E}` },
  { name: 'RTL override around digits', input: '‮123-45-6789‬', expected: `‮${S}‬` },
  { name: 'lone surrogate survives', input: '\ud800 a@b.com', expected: `\ud800 ${E}` },
  { name: 'NFKC ligature normalised when something matched', input: 'ﬁle a@b.com', expected: `file ${E}` },
  { name: 'clean non-ASCII text is returned unchanged', input: 'ﬁle ² ½ 😀', expected: 'ﬁle ² ½ 😀' },
  { name: 'combining mark right after a redacted number is swallowed', input: '123456789́ x', expected: `${S} x` },

  // --- nothing to redact ----------------------------------------------------------------
  { name: 'empty', input: '', expected: '' },
  { name: 'plain text', input: 'Hello, how do I reset my password?', expected: 'Hello, how do I reset my password?' },
  { name: 'the token itself', input: '<REDACTED: EMAIL> <REDACTED: SSN> <REDACTED: CREDIT_CARD>', expected: '<REDACTED: EMAIL> <REDACTED: SSN> <REDACTED: CREDIT_CARD>' },
];

describe('sanitize: case table', () => {
  it.each(cases)('$name', ({ input, expected, counts }) => {
    const result = sanitize(input);
    expect(result.sanitized).toBe(expected);
    expect(Object.keys(result.redactions).sort()).toEqual([...PII_TYPES].sort());
    if (counts) for (const [k, v] of Object.entries(counts)) expect(result.redactions[k as 'EMAIL'], k).toBe(v);
    expect(containsPii(input)).toBe(expected !== input);
  });

  it('counts exactly one redaction for the card+SSN example', () => {
    expect(sanitize('4111 1111 1111 1111 123-45-6789').redactions).toEqual({ EMAIL: 0, CREDIT_CARD: 1, SSN: 1 });
  });

  it('redactionToken formats the token', () => {
    expect(redactionToken('EMAIL')).toBe('<REDACTED: EMAIL>');
    expect(redactionToken('CREDIT_CARD')).toBe('<REDACTED: CREDIT_CARD>');
    expect(redactionToken('SSN')).toBe('<REDACTED: SSN>');
  });
});
