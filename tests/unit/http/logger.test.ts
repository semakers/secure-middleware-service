import { describe, expect, it } from 'vitest';
import { createLogger, sanitizeValue } from '../../../src/logger.js';

function capture(level = 'info') {
  const lines: string[] = [];
  const logger = createLogger({ level, destination: { write: (s: string) => void lines.push(s) } });
  return { logger, text: () => lines.join(''), lines };
}

describe('logger', () => {
  it('sanitises every string it emits: message, fields, nested values, keys', () => {
    const { logger, text } = capture();
    logger.info(
      { who: 'jo@example.com', nested: { card: ['4111 1111 1111 1111'] }, 'ssn 123-45-6789': 1, n: 5 },
      'mail ana@example.org ssn 123-45-6789',
    );
    logger.info('printf %s', 'bob@example.net');
    const out = text();
    for (const raw of ['jo@example.com', '4111 1111 1111 1111', '123-45-6789', 'ana@example.org', 'bob@example.net']) {
      expect(out).not.toContain(raw);
    }
    expect(out).toContain('<REDACTED: EMAIL>');
    expect(JSON.parse(out.split('\n')[0]!)).toMatchObject({ level: 'info', service: 'secure-middleware', n: 5 });
  });

  it('logs errors as name + sanitised frames, never the message', () => {
    const { logger, text } = capture();
    logger.error(new Error('body was jo@example.com'));
    logger.error({ err: new TypeError('4111111111111111') }, 'x');
    expect(text()).not.toContain('jo@example.com');
    expect(text()).not.toContain('4111111111111111');
    expect(text()).toContain('TypeError');
  });

  it('honours the level and bounds recursion', () => {
    const { logger, lines } = capture('warn');
    logger.info('hidden');
    expect(lines).toHaveLength(0);
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 20; i++) cur = (cur.n = {}) as Record<string, unknown>;
    expect(() => sanitizeValue(deep)).not.toThrow();
    expect(JSON.stringify(sanitizeValue(deep))).toContain('[Truncated]');
    expect(sanitizeValue(7)).toBe(7);
    expect(sanitizeValue(null)).toBeNull();
  });

  it('does not let a deeply nested email through, nor child bindings', () => {
    const { logger, text } = capture();
    let nested: unknown = { mail: 'deep@example.com' };
    for (let i = 0; i < 10; i++) nested = { a: nested };
    logger.info({ nested }, 'x');
    logger.child({ owner: 'bind@example.com' }).info('y');
    expect(text()).not.toContain('example.com');
  });

  it('logs to stdout when no destination is given', () => {
    expect(() => createLogger({ level: 'silent' }).info('x')).not.toThrow();
  });
});
