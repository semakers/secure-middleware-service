import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiTimeoutError,
  AiUpstreamError,
  GENERATED_ANSWER,
  MockAiClient,
  generateWithTimeout,
  type AiClient,
} from '../../../src/ai/mockAiClient.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function track<T>(p: Promise<T>): { state: 'pending' | 'ok' | 'err'; value?: unknown } {
  const box: { state: 'pending' | 'ok' | 'err'; value?: unknown } = { state: 'pending' };
  p.then(
    (v) => {
      box.state = 'ok';
      box.value = v;
    },
    (e: unknown) => {
      box.state = 'err';
      box.value = e;
    },
  );
  return box;
}

describe('MockAiClient', () => {
  it('exposes mode and latency, and setMode switches', () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'healthy' });
    expect(c.latencyMs).toBe(2000);
    expect(c.mode).toBe('healthy');
    c.setMode('fail');
    expect(c.mode).toBe('fail');
    expect(() => c.setMode('nope' as never)).toThrow(RangeError);
    expect(c.mode).toBe('fail');
  });

  it('healthy: pending at 1999 ms, resolved at 2000 ms, with one timer', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'healthy' });
    const box = track(c.generate('hi'));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(box.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(box).toEqual({ state: 'ok', value: { answer: GENERATED_ANSWER } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fail: rejects with AiUpstreamError only AFTER the latency', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'fail' });
    const box = track(c.generate('hi'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(box.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(box.state).toBe('err');
    expect(box.value).toBeInstanceOf(AiUpstreamError);
  });

  it('hang: never settles, uses no timer', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'hang' });
    const box = track(c.generate('hi'));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(box.state).toBe('pending');
  });

  it('an already-aborted signal rejects at once without a timer', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'healthy' });
    const ac = new AbortController();
    ac.abort();
    await expect(c.generate('hi', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abort during the latency clears the timer and rejects', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'healthy' });
    const ac = new AbortController();
    const box = track(c.generate('hi', { signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(500);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(box.state).toBe('err');
    expect((box.value as Error).name).toBe('AbortError');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abort rejects a hanging call', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'hang' });
    const ac = new AbortController();
    const box = track(c.generate('hi', { signal: ac.signal }));
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(box.state).toBe('err');
  });

  it('the mode is captured when the call starts', async () => {
    const c = new MockAiClient({ latencyMs: 100, mode: 'healthy' });
    const box = track(c.generate('hi'));
    c.setMode('fail');
    await vi.advanceTimersByTimeAsync(100);
    expect(box.state).toBe('ok');
  });
});

describe('generateWithTimeout', () => {
  it('resolves when the call is faster than the deadline and leaves no timers', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'healthy' });
    const box = track(generateWithTimeout(c, 'x', 5000));
    await vi.advanceTimersByTimeAsync(2000);
    expect(box).toEqual({ state: 'ok', value: { answer: GENERATED_ANSWER } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects AiTimeoutError exactly at the deadline (hang), aborting the call', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'hang' });
    const spy = vi.spyOn(c, 'generate');
    const box = track(generateWithTimeout(c, 'x', 5000));
    await vi.advanceTimersByTimeAsync(4999);
    expect(box.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(box.state).toBe('err');
    expect(box.value).toBeInstanceOf(AiTimeoutError);
    expect(spy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out when latency exceeds the deadline and clears the latency timer', async () => {
    const c = new MockAiClient({ latencyMs: 8000, mode: 'healthy' });
    const box = track(generateWithTimeout(c, 'x', 5000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(box.value).toBeInstanceOf(AiTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates an upstream failure and clears the deadline timer', async () => {
    const c = new MockAiClient({ latencyMs: 2000, mode: 'fail' });
    const box = track(generateWithTimeout(c, 'x', 5000));
    await vi.advanceTimersByTimeAsync(2000);
    expect(box.value).toBeInstanceOf(AiUpstreamError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a client that throws synchronously (Error and non-Error)', async () => {
    const bad: AiClient = {
      generate: () => {
        throw new Error('boom');
      },
    };
    await expect(generateWithTimeout(bad, 'x', 100)).rejects.toThrow('boom');
    const worse: AiClient = {
      generate: () => {
        throw 'str';
      },
    };
    await expect(generateWithTimeout(worse, 'x', 100)).rejects.toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
