import { describe, expect, it } from 'vitest';
import { containsPii, sanitize } from '../../../src/sanitizer/index.js';

const BUDGET_MS = 250;

function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

const N = 100_000;
const adversarial: Array<[string, string]> = [
  ['a x 1e5', 'a'.repeat(N)],
  ['"a@" x 5e4', 'a@'.repeat(N / 2)],
  ['"a." x 5e4 + "@"', 'a.'.repeat(N / 2) + '@'],
  ['"@a." x 5e4', '@a.'.repeat(N / 3)],
  ['"1-" x 5e4', '1-'.repeat(N / 2)],
  ['"1 " x 5e4', '1 '.repeat(N / 2)],
  ['"1." x 5e4', '1.'.repeat(N / 2)],
  ['9 x 1e5', '9'.repeat(N)],
  ['"12-" x 3.3e4 + "@"', '12-'.repeat(N / 3) + '@'],
  ['long local part, no @', 'x.'.repeat(N / 2) + 'y'],
  ['long local part + "@" + no TLD', 'a'.repeat(N) + '@b'],
  ['long dotted domain without TLD', 'a@' + 'b.'.repeat(N / 2)],
  ['long dotted domain with digit TLD', 'a@' + 'b.'.repeat(N / 2) + '1'],
  ['("x+" + y x 60 + "@") x n', ('x+' + 'y'.repeat(60) + '@').repeat(N / 63)],
  ['"a@b.com." x n (chained merges)', 'a@b.c'.repeat(N / 5)],
  ['"4111 " x 2e4', '4111 '.repeat(N / 5)],
  ['"1111 1111 1111 111 " x n', '1111 1111 1111 111 '.repeat(N / 19)],
  ['valid card repeated with single separators', '4111 1111 1111 1111 '.repeat(N / 20)],
  ['"123-45-6789 " x n', '123-45-6789 '.repeat(N / 12)],
  ['zero-width soup', '1​'.repeat(N / 2)],
  ['combining marks after digits', '1́'.repeat(N / 2)],
  ['NBSP-separated digits', '1 '.repeat(N / 2)],
  ['Arabic-Indic digits', '٣'.repeat(N)],
  ['fullwidth digits', '９'.repeat(N)],
  ['emoji', '😀'.repeat(N / 2)],
  ['astral local chars + @', '𠀀'.repeat(N / 2) + '@x.com'],
  ['mixed digits and @', '1@'.repeat(N / 2)],
  ['dots and hyphens', '-.'.repeat(N / 2) + '@a.-'],
];

describe('ReDoS / performance: 100 KB adversarial inputs', () => {
  it.each(adversarial)('%s finishes under 250 ms', (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(N - 100);
    const { ms } = timed(() => sanitize(input));
    expect(ms).toBeLessThan(BUDGET_MS);
    const c = timed(() => containsPii(input));
    expect(c.ms).toBeLessThan(BUDGET_MS);
  });

  it('scales linearly: 10x input takes well under 30x time', () => {
    const small = '4111 1111 1111 1111 a@b.com 123-45-6789 x '.repeat(500);
    const big = small.repeat(10);
    sanitize(small); // warm-up
    const a = timed(() => sanitize(small)).ms + 0.05;
    const b = timed(() => sanitize(big)).ms;
    expect(b).toBeLessThan(a * 30 + 20);
  });

  it('handles ~1 MB of mixed input and redacts all of it', () => {
    const unit = 'Mail bob+x@mail.example.com card 4111-1111-1111-1111 ssn 123-45-6789 ünï 😀 ';
    const input = unit.repeat(Math.ceil(1_000_000 / unit.length));
    expect(input.length).toBeGreaterThan(1_000_000);
    const { ms, value } = timed(() => sanitize(input));
    const reps = Math.ceil(1_000_000 / unit.length);
    expect(value.redactions).toEqual({ EMAIL: reps, CREDIT_CARD: reps, SSN: reps });
    expect(ms).toBeLessThan(2000);
  });
});
