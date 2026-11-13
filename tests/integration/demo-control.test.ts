import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { ConfigError, loadConfig } from '../../src/config.js';
import { createTarget, type Target } from './support/target.js';

let t: Target;
beforeAll(async () => void (t = await createTarget()));
afterAll(async () => t.stop());

const PATH = '/__demo/ai-mock';

describe('demo control (enabled target)', () => {
  it('requires a Bearer token: none, wrong, wrong scheme -> 401', async () => {
    for (const method of ['get', 'put'] as const) {
      const none = await t.http()[method](PATH).send({ mode: 'fail' });
      expect(none.status).toBe(401);
      expect(none.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Missing or invalid credentials.' });
      expect(none.headers['www-authenticate']).toBe('Bearer');
      const wrong = await t.http()[method](PATH).set('Authorization', 'Bearer nope-nope-nope-nope-nope-nope').send({ mode: 'fail' });
      expect(wrong.status).toBe(401);
      const scheme = await t.http()[method](PATH).set('Authorization', `Basic ${t.demoToken}`).send({ mode: 'fail' });
      expect(scheme.status).toBe(401);
      const raw = await t.http()[method](PATH).set('Authorization', t.demoToken).send({ mode: 'fail' });
      expect(raw.status).toBe(401);
    }
    expect((await t.demoGet()).mode).toBe('healthy');
  });

  it('GET shows mode, timings and the circuit snapshot', async () => {
    const res = await t.http().get(PATH).set('Authorization', `Bearer ${t.demoToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'healthy',
      latencyMs: t.latencyMs,
      timeoutMs: t.timeoutMs,
      circuit: { state: 'closed', consecutiveFailures: 0, failureThreshold: t.threshold, cooldownMs: t.cooldownMs },
    });
  });

  it('PUT switches the mode, validated strictly', async () => {
    const auth = { Authorization: `Bearer ${t.demoToken}` };
    try {
      const res = await t.http().put(PATH).set(auth).send({ mode: 'fail' });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('fail');
      for (const [body, issue] of [
        [{ mode: 'explode' }, 'mode:invalid_value'],
        [{}, 'mode:required'],
        [{ mode: 'fail', extra: 1 }, '(root):unrecognized_keys'],
      ] as const) {
        const bad = await t.http().put(PATH).set(auth).send(body);
        expect(bad.status).toBe(400);
        expect(bad.body.error.details.map((d: { field: string; issue: string }) => `${d.field}:${d.issue}`)).toEqual([issue]);
      }
      const ct = await t.http().put(PATH).set(auth).set('content-type', 'text/plain').send('{"mode":"fail"}');
      expect(ct.status).toBe(415);
      expect((await t.http().delete(PATH).set(auth)).status).toBe(405);
      expect((await t.http().delete(PATH).set(auth)).headers.allow).toBe('GET, PUT');
    } finally {
      await t.ensureHealthyAndClosed();
    }
  });

  it('cannot reset the breaker: there is no such endpoint', async () => {
    const res = await t.http().post(`${PATH}/reset`).set('Authorization', `Bearer ${t.demoToken}`);
    expect(res.status).toBe(404);
  });
});

describe('demo control is invisible in production mode', () => {
  it('404 NOT_FOUND exactly like any unknown route', async () => {
    const url = await t.productionUrl();
    if (url === undefined) return; // remote run without E2E_PROD_BASE_URL
    for (const method of ['get', 'put'] as const) {
      const res = await request(url)[method](PATH).set('Authorization', `Bearer ${t.demoToken}`).send({ mode: 'fail' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Route not found.' });
    }
    const unknown = await request(url).get('/nothing-here');
    expect(unknown.status).toBe(404);
    const health = await request(url).get('/health');
    expect(health.body.status).toBe('ok');
  });
});

describe('startup refusal', () => {
  it('production + DEMO_CONTROL_ENABLED=true is a config error that names only the variable', () => {
    const env = {
      NODE_ENV: 'production',
      DEMO_CONTROL_ENABLED: 'true',
      DEMO_CONTROL_TOKEN: 'secret-token-0123456789-abcdef',
      AUDIT_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    try {
      loadConfig(env);
    } catch (e) {
      expect((e as Error).message).toContain('DEMO_CONTROL_ENABLED');
      expect((e as Error).message).not.toContain('secret-token');
    }
  });
});
