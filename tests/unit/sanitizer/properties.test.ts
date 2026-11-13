import { describe, expect, it } from 'vitest';
import { containsPii, PII_TYPES, redactionToken, sanitize } from '../../../src/sanitizer/index.js';
import { group, luhnOk, randomDigits, rng, withLuhn } from './helpers.js';

const C = redactionToken('CREDIT_CARD');
const SEPS = ['', ' ', '-', '.', ' ', ' '];

describe('Luhn-generated cards', () => {
  const rand = rng(42);
  for (let len = 13; len <= 19; len++) {
    for (const sep of SEPS) {
      it(`${len} digits, separator ${JSON.stringify(sep)}`, () => {
        for (let k = 0; k < 20; k++) {
          // first digit 1-9 so it is a realistic number; body of len-1 digits + check digit
          const digits = withLuhn(String(1 + Math.floor(rand() * 9)) + randomDigits(rand, len - 2));
          expect(digits).toHaveLength(len);
          const sizes = len === 15 ? [4, 6, 5] : [4, 4, 4, 4, 3];
          const text = `pay ${sep === '' ? digits : group(digits, sizes, sep)} thanks`;
          const r = sanitize(text);
          expect(r.sanitized, text).toBe(`pay ${C} thanks`);
          expect(r.redactions).toEqual({ EMAIL: 0, CREDIT_CARD: 1, SSN: 0 });
        }
      });
    }
  }

  it('Luhn-invalid contiguous runs of 13-19 digits are never cards (and never an SSN)', () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const len = 13 + Math.floor(r() * 7);
      let digits = randomDigits(r, len);
      if (luhnOk(digits)) digits = digits.slice(0, -1) + String((Number(digits.at(-1)) + 1) % 10);
      expect(luhnOk(digits)).toBe(false);
      // contiguous: a grouped run may legitimately contain a Luhn-valid sub-window
      const text = `n=${digits}`;
      const out = sanitize(text);
      expect(out.sanitized, text).toBe(text);
    }
  });
});

describe('properties on a corpus of tricky inputs', () => {
  const r = rng(2026);
  const pieces = [
    '4111 1111 1111 1111', '123-45-6789', '123456789', 'a@b.com', 'bob+t@mail.example.org', '4111111111111112',
    ' ', '  ', '-', '.', ',', '​', '́', ' ', '😀', 'ﬁ', '٤١١', '１２３', '@', 'x', '9', '0', '12', '345',
    'josé@ejemplo.es', '<REDACTED: EMAIL>', '‮', '️⃣', '.com', 'a@b.c', '1-', '1 ',
  ];
  const corpus: string[] = [];
  for (let i = 0; i < 3000; i++) {
    let s = '';
    const n = 1 + Math.floor(r() * 10);
    for (let k = 0; k < n; k++) s += pieces[Math.floor(r() * pieces.length)];
    corpus.push(s);
  }

  it('is idempotent', () => {
    for (const s of corpus) {
      const once = sanitize(s).sanitized;
      expect(sanitize(once).sanitized, JSON.stringify(s)).toBe(once);
      expect(containsPii(once), JSON.stringify(s)).toBe(false);
    }
  });

  it('always reports all three keys, with non-negative integer counts', () => {
    for (const s of corpus) {
      const { redactions } = sanitize(s);
      expect(Object.keys(redactions).sort()).toEqual([...PII_TYPES].sort());
      for (const t of PII_TYPES) expect(Number.isInteger(redactions[t]) && redactions[t] >= 0).toBe(true);
    }
  });

  it('containsPii agrees with sanitize', () => {
    for (const s of corpus) {
      const { redactions } = sanitize(s);
      expect(containsPii(s), JSON.stringify(s)).toBe(redactions.EMAIL + redactions.CREDIT_CARD + redactions.SSN > 0);
    }
  });

  it('the token count in the output equals the redaction counts', () => {
    for (const s of corpus) {
      const { sanitized, redactions } = sanitize(s);
      for (const t of PII_TYPES) {
        const tokens = sanitized.split(redactionToken(t)).length - 1;
        // pieces may contain a literal token; the output then has at least the redacted ones
        expect(tokens).toBeGreaterThanOrEqual(redactions[t]);
      }
    }
  });

  it('the token text is never re-detected', () => {
    for (const t of PII_TYPES) {
      const tok = redactionToken(t);
      expect(sanitize(tok).sanitized).toBe(tok);
      expect(sanitize(`${tok}${tok} ${tok}`).redactions).toEqual({ EMAIL: 0, CREDIT_CARD: 0, SSN: 0 });
    }
  });
});

describe('card followed by an SSN (property: nothing of either leaks)', () => {
  it('a random valid 16-digit card then a random SSN, every separator pairing', () => {
    // Review finding: when card + the SSN's first group is ALSO Luhn-valid as 19 digits (about 1 in
    // 10), a longest-window rule swallowed "123" and left "-45-6789" in clear.
    const r = rng(2026);
    const S = redactionToken('SSN');
    for (let k = 0; k < 600; k++) {
      const card = withLuhn(String(1 + Math.floor(r() * 9)) + randomDigits(r, 14));
      const ssn = `${String(100 + Math.floor(r() * 900))}${randomDigits(r, 6)}`;
      const cs = [' ', '-', '.', ''][k % 4] as string;
      const ss = [' ', '-', '.', ''][Math.floor(k / 4) % 4] as string;
      const ssnText = ss === '' ? ssn : `${ssn.slice(0, 3)}${ss}${ssn.slice(3, 5)}${ss}${ssn.slice(5)}`;
      const text = `pay ${group(card, [4, 4, 4, 4], cs)} ${ssnText} ok`;
      const out = sanitize(text);
      expect(out.sanitized, text).toBe(`pay ${C} ${S} ok`);
      expect(/\d/.test(out.sanitized), text).toBe(false);
    }
  });
});
