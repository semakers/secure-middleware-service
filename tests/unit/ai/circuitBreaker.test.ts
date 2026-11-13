import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError, type CircuitState } from '../../../src/ai/circuitBreaker.js';

function setup(opts: { failureThreshold?: number; cooldownMs?: number } = {}) {
  let t = 1_000_000;
  const changes: string[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold: opts.failureThreshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 10_000,
    now: () => t,
    onStateChange: (from: CircuitState, to: CircuitState) => changes.push(`${from}->${to}`),
  });
  return { breaker, changes, advance: (ms: number) => (t += ms) };
}
const ok = () => Promise.resolve('ok');
const bad = () => Promise.reject(new Error('x'));
const fail = async (b: CircuitBreaker) => {
  await expect(b.execute(bad)).rejects.toThrow('x');
};
const open = async (b: CircuitBreaker, n = 3) => {
  for (let i = 0; i < n; i++) await fail(b);
};

describe('CircuitBreaker', () => {
  it('starts closed and passes results through', async () => {
    const { breaker } = setup();
    expect(breaker.state).toBe('closed');
    await expect(breaker.execute(ok)).resolves.toBe('ok');
    expect(breaker.snapshot()).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      failureThreshold: 3,
      cooldownMs: 10_000,
      retryAfterMs: 0,
    });
  });

  it('rethrows the original error', async () => {
    const { breaker } = setup();
    const e = new Error('orig');
    await expect(breaker.execute(() => Promise.reject(e))).rejects.toBe(e);
  });

  it('closed -> open after exactly 3 consecutive failures', async () => {
    const { breaker, changes } = setup();
    await fail(breaker);
    await fail(breaker);
    expect(breaker.state).toBe('closed');
    expect(breaker.snapshot().consecutiveFailures).toBe(2);
    await fail(breaker);
    expect(breaker.state).toBe('open');
    expect(changes).toEqual(['closed->open']);
  });

  it('an interleaved success resets the counter (F,F,S,F,F stays closed)', async () => {
    const { breaker } = setup();
    await fail(breaker);
    await fail(breaker);
    await breaker.execute(ok);
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    await fail(breaker);
    await fail(breaker);
    expect(breaker.state).toBe('closed');
  });

  it('honours other thresholds', async () => {
    const one = setup({ failureThreshold: 1 });
    await fail(one.breaker);
    expect(one.breaker.state).toBe('open');
    const five = setup({ failureThreshold: 5 });
    await open(five.breaker, 4);
    expect(five.breaker.state).toBe('closed');
    await fail(five.breaker);
    expect(five.breaker.state).toBe('open');
  });

  it('rejects invalid options', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0, cooldownMs: 1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureThreshold: 1.5, cooldownMs: 1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureThreshold: 1, cooldownMs: -1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureThreshold: 1, cooldownMs: Number.NaN })).toThrow(RangeError);
  });

  it('defaults the clock to Date.now', async () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    await fail(b);
    expect(b.snapshot().retryAfterMs).toBeGreaterThan(59_000);
  });

  it('open rejects without calling fn, fast, with a counting-down retryAfterMs', async () => {
    const { breaker, advance } = setup();
    await open(breaker);
    const fn = vi.fn(ok);
    const err = await breaker.execute(fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).retryAfterMs).toBe(10_000);
    advance(4_000);
    const err2 = (await breaker.execute(fn).catch((e: unknown) => e)) as CircuitOpenError;
    expect(err2.retryAfterMs).toBe(6_000);
    expect(breaker.snapshot().retryAfterMs).toBe(6_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('open -> half_open after the cooldown (state getter, no call needed)', async () => {
    const { breaker, advance, changes } = setup();
    await open(breaker);
    advance(9_999);
    expect(breaker.state).toBe('open');
    advance(1);
    expect(breaker.state).toBe('half_open');
    expect(breaker.snapshot().retryAfterMs).toBe(0);
    expect(changes).toEqual(['closed->open']);
  });

  it('half_open + success -> closed with counter 0', async () => {
    const { breaker, advance, changes } = setup();
    await open(breaker);
    advance(10_000);
    await expect(breaker.execute(ok)).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    expect(changes).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
    // counter really restarted: two failures keep it closed
    await fail(breaker);
    await fail(breaker);
    expect(breaker.state).toBe('closed');
  });

  it('half_open + failure -> open with a FRESH cooldown', async () => {
    const { breaker, advance, changes } = setup();
    await open(breaker);
    advance(10_000);
    await fail(breaker);
    expect(breaker.state).toBe('open');
    expect(breaker.snapshot().retryAfterMs).toBe(10_000);
    advance(9_999);
    expect(breaker.state).toBe('open');
    advance(1);
    expect(breaker.state).toBe('half_open');
    expect(changes).toEqual(['closed->open', 'open->half_open', 'half_open->open']);
  });

  it('allows exactly one trial; concurrent callers get CircuitOpenError (retryAfterMs >= 1000)', async () => {
    const { breaker, advance } = setup();
    await open(breaker);
    advance(10_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const trialFn = vi.fn(async () => {
      await gate;
      return 'trial';
    });
    const trial = breaker.execute(trialFn);
    expect(breaker.state).toBe('half_open');
    expect(breaker.snapshot().retryAfterMs).toBeGreaterThanOrEqual(1000);
    const other = vi.fn(ok);
    const rejects = await Promise.all(
      [1, 2, 3].map(() => breaker.execute(other).catch((e: unknown) => e)),
    );
    for (const r of rejects) {
      expect(r).toBeInstanceOf(CircuitOpenError);
      expect((r as CircuitOpenError).retryAfterMs).toBeGreaterThanOrEqual(1000);
    }
    expect(other).not.toHaveBeenCalled();
    expect(trialFn).toHaveBeenCalledTimes(1);
    release();
    await expect(trial).resolves.toBe('trial');
    expect(breaker.state).toBe('closed');
  });

  it('a late result of a call started before opening does not close or reset the circuit', async () => {
    const { breaker } = setup({ failureThreshold: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = breaker.execute(async () => {
      await gate;
      return 'late';
    });
    await fail(breaker); // opens
    expect(breaker.state).toBe('open');
    release();
    await expect(slow).resolves.toBe('late');
    expect(breaker.state).toBe('open');
    expect(breaker.snapshot().consecutiveFailures).toBe(1);
  });

  it('a late failure while open does not emit extra transitions', async () => {
    const { breaker, changes } = setup({ failureThreshold: 1 });
    let rej!: () => void;
    const slow = breaker.execute(
      () => new Promise<string>((_, r) => (rej = () => r(new Error('late')))),
    );
    await fail(breaker);
    rej();
    await expect(slow).rejects.toThrow('late');
    expect(changes).toEqual(['closed->open']);
  });

  it('works without onStateChange', async () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
    await fail(b);
    await expect(b.execute(ok)).resolves.toBe('ok');
  });
});
