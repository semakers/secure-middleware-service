import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { start } from '../../src/bootstrap.js';
import { createTarget, isRemote, PII, PII_MESSAGE, type Target } from './support/target.js';

describe('concurrency', () => {
  let t: Target;
  beforeAll(async () => void (t = await createTarget()));
  afterAll(async () => t.stop());

  it('25 concurrent requests -> 25 responses and 25 new valid audit records', async () => {
    await t.ensureHealthyAndClosed();
    const before = new Set(t.readAudit().map((r) => r.id));
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => t.post({ userId: `user-${i}`, message: `Mail jane${i}.doe@example.com card ${PII.card} (#${i})` })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(25).fill(200));
    const auditIds = results.map((r) => r.body.auditId as string);
    expect(new Set(auditIds).size).toBe(25);
    const fresh = t.readAudit().filter((r) => !before.has(r.id));
    expect(fresh.map((r) => r.id).sort()).toEqual([...auditIds].sort());
    for (const [i, res] of results.entries()) {
      const rec = fresh.find((r) => r.id === res.body.auditId)!;
      expect(rec.requestId).toBe(res.body.requestId);
      expect(t.decryptOriginal(rec)).toBe(`Mail jane${i}.doe@example.com card ${PII.card} (#${i})`);
    }
    expect(new Set(fresh.map((r) => r.originalMessage.iv)).size).toBe(25);
    expect(t.auditFileText()).not.toContain('example.com');
  });
});

describe.skipIf(isRemote)('failing audit store (in-process)', () => {
  let t: Target;
  beforeAll(async () => {
    t = await createTarget({
      overrides: {
        store: {
          append: () => Promise.reject(new Error(`disk full while writing ${PII.email}`)),
          readAll: () => Promise.resolve([]),
        },
      },
    });
  });
  afterAll(async () => t.stop());

  it('fails closed: 500 AUDIT_WRITE_FAILED, no answer, no PII in response or logs', async () => {
    const res = await t.post({ userId: 'u', message: PII_MESSAGE });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'AUDIT_WRITE_FAILED', message: 'The request could not be recorded.' });
    expect(res.body.answer).toBeUndefined();
    const logs = t.logs();
    for (const raw of [PII.email, PII.card, PII.cardDigits, PII.ssn]) {
      expect(JSON.stringify(res.body)).not.toContain(raw);
      expect(logs).not.toContain(raw);
    }
    expect(logs).toContain('audit_write_failed');
  });

  it('the AI only ever receives the sanitised text', async () => {
    const spy = vi.spyOn(t.deps!.ai, 'generate');
    await t.post({ userId: 'u', message: PII_MESSAGE });
    expect(spy).toHaveBeenCalledTimes(1);
    const prompt = spy.mock.calls[0]![0];
    for (const raw of [PII.email, PII.card, PII.ssn]) expect(prompt).not.toContain(raw);
    expect(prompt).toContain('<REDACTED: EMAIL>');
  });
});

describe.skipIf(isRemote)('log hygiene across a mixed run (in-process)', () => {
  let t: Target;
  beforeAll(async () => void (t = await createTarget()));
  afterAll(async () => t.stop());

  it('no raw PII from any kind of request ever reaches the logs', async () => {
    await t.post({ userId: 'u', message: PII_MESSAGE });
    await t.post({ userId: 'u', message: PII_MESSAGE, [PII.email]: 1 });
    await t.http().post('/secure-inquiry').set('content-type', 'application/json').send(`{"x":"${PII.ssn}" ${PII.email}`);
    await t.http().post(`/secure-inquiry?e=${PII.email}`).set('content-type', 'text/plain').send(PII_MESSAGE);
    await t.http().get(`/${PII.cardDigits}`).set('Authorization', `Bearer ${PII.email}`);
    await t.setMode('fail');
    for (let i = 0; i < 4; i++) await t.post({ userId: 'u', message: PII_MESSAGE });
    await t.ensureHealthyAndClosed();
    const logs = t.logs();
    expect(logs.length).toBeGreaterThan(0);
    for (const raw of [PII.email, 'jane.doe', PII.card, PII.cardDigits, PII.ssn]) expect(logs).not.toContain(raw);
    expect(logs).toContain('circuit_state_change');
  });
});

describe.skipIf(isRemote)('default 2 s latency with fake timers (in-process)', () => {
  let t: Target;
  beforeAll(async () => void (t = await createTarget({ latencyMs: 2000, timeoutMs: 5000 })));
  afterAll(async () => {
    vi.useRealTimers();
    await t.stop();
  });

  it('answers after the mock latency without a real 2 s wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = t.post({ userId: 'u', message: 'hello' }).then((r) => r);
    for (let i = 0; i < 200 && vi.getTimerCount() === 0; i++) await new Promise((r) => setImmediate(r));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Generated Answer');
  });
});

describe.skipIf(isRemote)('graceful shutdown (in-process)', () => {
  it('SIGTERM stops accepting, lets the in-flight request and its audit write finish, then exits 0', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomBytes } = await import('node:crypto');
    const { EventEmitter } = await import('node:events');
    const dir = mkdtempSync(join(tmpdir(), 'smw-shutdown-'));
    const signals = new EventEmitter();
    const exits: number[] = [];
    const s = await start(
      {
        PORT: '0',
        HOST: '127.0.0.1',
        LOG_LEVEL: 'silent',
        AUDIT_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
        AUDIT_LOG_PATH: join(dir, 'a.json'),
        AI_MOCK_LATENCY_MS: '300',
      },
      { signals: signals as never, exit: ((c: number) => void exits.push(c)) as never },
    );
    const inflight = request(s.url).post('/secure-inquiry').send({ userId: 'u', message: 'in flight' });
    const done = inflight.then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    signals.emit('SIGTERM');
    const res = await done;
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(exits).toEqual([0]));
    const addr = s.server.address() as AddressInfo | null;
    expect(addr).toBeNull();
    await expect(new Promise((resolve, reject) => http.get(s.url + '/health', resolve).on('error', reject))).rejects.toThrow();
    const records = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'a.json'), 'utf8')).records;
    expect(records).toHaveLength(1);
  });
});
