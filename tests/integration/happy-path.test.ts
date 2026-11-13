import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTarget, isRemote, PII, PII_MESSAGE, PII_SANITIZED, type Target } from './support/target.js';

let t: Target;
beforeAll(async () => void (t = await createTarget()));
afterAll(async () => t.stop());
beforeEach(async () => t.ensureHealthyAndClosed());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('POST /secure-inquiry happy path', () => {
  it('redacts email + card + SSN and answers', async () => {
    const started = Date.now();
    const res = await t.post({ userId: 'user_42', message: PII_MESSAGE }).set('X-Request-Id', 'client-supplied');
    expect(Date.now() - started).toBeGreaterThanOrEqual(t.latencyMs - 5);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['answer', 'auditId', 'redactions', 'requestId', 'sanitizedMessage']);
    expect(res.body.answer).toBe('Generated Answer');
    expect(res.body.sanitizedMessage).toBe(PII_SANITIZED);
    expect(res.body.redactions).toEqual({ EMAIL: 1, CREDIT_CARD: 1, SSN: 1 });
    expect(res.body.requestId).toMatch(UUID);
    expect(res.body.auditId).toMatch(UUID);
    expect(JSON.stringify(res.body)).not.toContain('example.com');
    // headers
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    expect(res.headers['x-request-id']).not.toBe('client-supplied');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toMatch(/^application\/json; charset=utf-8$/i);
  });

  it('leaves a clean message untouched and counts zero redactions', async () => {
    const res = await t.post({ userId: 'u', message: 'What is the weather today?' });
    expect(res.status).toBe(200);
    expect(res.body.sanitizedMessage).toBe('What is the weather today?');
    expect(res.body.redactions).toEqual({ EMAIL: 0, CREDIT_CARD: 0, SSN: 0 });
  });

  it('writes an encrypted audit record: original decrypts, redacted text is plaintext, no raw PII on disk', async () => {
    const res = await t.post({ userId: 'audit-user', message: PII_MESSAGE });
    expect(res.status).toBe(200);
    const record = t.readAudit().find((r) => r.id === res.body.auditId);
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      requestId: res.body.requestId,
      userId: 'audit-user',
      outcome: 'answered',
      redactedMessage: PII_SANITIZED,
      redactions: { EMAIL: 1, CREDIT_CARD: 1, SSN: 1 },
    });
    expect(new Date(record!.timestamp).toISOString()).toBe(record!.timestamp);
    expect(t.decryptOriginal(record!)).toBe(PII_MESSAGE);
    const file = t.auditFileText();
    for (const raw of [PII.email, PII.card, PII.cardDigits, PII.ssn, 'jane.doe']) expect(file).not.toContain(raw);
  });

  it('uses a unique IV for every record', async () => {
    await Promise.all([1, 2, 3, 4].map((i) => t.post({ userId: 'iv', message: `same message ${i % 2}` })));
    const ivs = t.readAudit().map((r) => r.originalMessage.iv);
    expect(new Set(ivs).size).toBe(ivs.length);
    for (const r of t.readAudit()) {
      expect(r.originalMessage.alg).toBe('AES-256-GCM');
      expect(Buffer.from(r.originalMessage.iv, 'base64')).toHaveLength(12);
      expect(Buffer.from(r.originalMessage.tag, 'base64')).toHaveLength(16);
    }
  });

  it('serves /health', async () => {
    const res = await t.http().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', circuit: 'closed' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.skipIf(isRemote)('keeps raw PII out of the logs and logs one line per request', async () => {
    await t.post({ userId: 'log-user', message: PII_MESSAGE });
    const logs = t.logs();
    for (const raw of [PII.email, PII.card, PII.cardDigits, PII.ssn]) expect(logs).not.toContain(raw);
    const line = logs
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'request')
      .at(-1)!;
    expect(line).toMatchObject({ method: 'POST', route: '/secure-inquiry', status: 200, outcome: 'answered', redactions: { EMAIL: 1 } });
    expect(typeof line.durationMs).toBe('number');
  });
});
