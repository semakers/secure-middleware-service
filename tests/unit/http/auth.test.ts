import { describe, expect, it } from 'vitest';
import { bearerMatches, digestOf } from '../../../src/http/auth.js';

const digest = digestOf('the-right-token-0123456789');
describe('bearerMatches', () => {
  it('accepts the right token (scheme case-insensitive)', () => {
    expect(bearerMatches('Bearer the-right-token-0123456789', digest)).toBe(true);
    expect(bearerMatches('bearer the-right-token-0123456789', digest)).toBe(true);
  });
  it.each([undefined, '', 'Bearer', 'Bearer ', 'Bearer wrong', 'Basic the-right-token-0123456789', 'the-right-token-0123456789', 'Bearer the-right-token-0123456789 extra'])(
    'rejects %j',
    (h) => expect(bearerMatches(h, digest)).toBe(false),
  );
});
