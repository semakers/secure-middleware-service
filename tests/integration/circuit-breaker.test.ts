import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, isRemote, sleep, type Target } from './support/target.js';

let t: Target;
beforeAll(async () => void (t = await createTarget()));
afterAll(async () => t.stop());
beforeEach(async () => t.ensureHealthyAndClosed());

const body = { userId: 'breaker', message: 'hello there' };

async function timed(): Promise<{ status: number; ms: number; res: Awaited<ReturnType<Target['post']>> }> {
  const start = performance.now();
  const res = await t.post(body);
  return { status: res.status, ms: performance.now() - start, res };
}

async function openCircuit(): Promise<void> {
  await t.setMode('fail');
  for (let i = 0; i < t.threshold; i++) expect((await timed()).status).toBe(502);
}

describe('circuit breaker over HTTP', () => {
  it('opens after N failures: 502 x3 (slow), then a fast 503 Service Busy with Retry-After', async () => {
    await t.setMode('fail');
    for (let i = 0; i < t.threshold; i++) {
      const r = await timed();
      expect(r.status).toBe(502);
      expect(r.ms).toBeGreaterThanOrEqual(t.latencyMs - 5);
      expect(r.res.body.error).toMatchObject({ code: 'AI_UPSTREAM_ERROR', message: 'The AI service failed to answer.' });
    }
    expect((await t.health()).circuit).toBe('open');

    const before = t.readAudit().length;
    const spy = isRemote ? undefined : vi.spyOn(t.deps!.ai, 'generate');
    const r = await timed();
    expect(r.status).toBe(503);
    expect(r.ms).toBeLessThan(Math.min(t.latencyMs / 2, 150));
    expect(r.res.body.error).toMatchObject({ code: 'SERVICE_BUSY', message: 'Service Busy' });
    expect(r.res.body.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(r.res.body.error.retryAfterSeconds)).toBe(true);
    expect(r.res.headers['retry-after']).toBe(String(r.res.body.error.retryAfterSeconds));
    expect(r.res.headers['cache-control']).toBe('no-store');
    if (spy) expect(spy).not.toHaveBeenCalled();

    const audit = t.readAudit();
    expect(audit.length).toBe(before + 1);
    expect(audit.at(-1)).toMatchObject({ outcome: 'circuit_open', requestId: r.res.body.error.requestId });
    expect(audit.slice(-4, -1).map((a) => a.outcome)).toEqual(['ai_error', 'ai_error', 'ai_error']);
  });

  it('half-open: a failing trial re-opens the circuit, a healthy trial closes it', async () => {
    await openCircuit();
    const view = await t.demoGet();
    expect(view.circuit.state).toBe('open');
    await sleep(view.circuit.retryAfterMs + 40);
    expect((await t.health()).circuit).toBe('half_open');

    // the single trial still fails (mock is in fail mode): it runs, takes the latency, and re-opens
    const trial = await timed();
    expect(trial.status).toBe(502);
    expect(trial.ms).toBeGreaterThanOrEqual(t.latencyMs - 5);
    expect((await t.health()).circuit).toBe('open');
    const rejected = await timed();
    expect(rejected.status).toBe(503);
    expect(rejected.ms).toBeLessThan(Math.min(t.latencyMs / 2, 150));

    // recover: healthy upstream, wait out the fresh cooldown, one trial closes it
    await t.setMode('healthy');
    const again = await t.demoGet();
    await sleep(again.circuit.retryAfterMs + 40);
    const ok = await timed();
    expect(ok.status).toBe(200);
    expect((await t.health()).circuit).toBe('closed');
    expect((await timed()).status).toBe(200);
  });

  it('a hanging upstream is cut at the timeout: 504 AI_TIMEOUT, counted as a failure', async () => {
    await t.setMode('hang');
    const r = await timed();
    expect(r.status).toBe(504);
    expect(r.ms).toBeGreaterThanOrEqual(t.timeoutMs - 10);
    expect(r.res.body.error).toMatchObject({ code: 'AI_TIMEOUT', message: 'The AI service timed out.' });
    expect((await t.demoGet()).circuit.consecutiveFailures).toBe(1);
    expect(t.readAudit().at(-1)).toMatchObject({ outcome: 'ai_timeout' });
  });

  it('a success resets the failure counter', async () => {
    await t.setMode('fail');
    expect((await timed()).status).toBe(502);
    expect((await t.demoGet()).circuit.consecutiveFailures).toBe(1);
    await t.setMode('healthy');
    expect((await timed()).status).toBe(200);
    expect((await t.demoGet()).circuit.consecutiveFailures).toBe(0);
  });
});
