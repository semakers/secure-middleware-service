import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTarget, isRemote, PII, type Target } from './support/target.js';

let t: Target;
beforeAll(async () => void (t = await createTarget()));
afterAll(async () => t.stop());

const valid = { userId: 'user_1', message: 'hello' };
const issuesOf = (res: { body: { error: { details: { field: string; issue: string }[] } } }) =>
  res.body.error.details.map((d) => `${d.field}:${d.issue}`);

async function expectError(res: { status: number; body: { error: { code: string; requestId: string } }; headers: Record<string, string> }, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
  expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['content-type']).toMatch(/application\/json/);
}

describe('validation (400)', () => {
  it.each([
    ['empty object', {}, ['userId:required', 'message:required']],
    ['wrong types', { userId: 5, message: {} }, ['userId:invalid_type', 'message:invalid_type']],
    ['empty strings', { userId: '', message: '' }, ['userId:too_short', 'message:too_short']],
    ['userId too long', { userId: 'a'.repeat(65), message: 'x' }, ['userId:too_long']],
    ['userId bad format', { userId: 'a b!', message: 'x' }, ['userId:invalid_format']],
    ['userId email', { userId: 'jane@example.com', message: 'x' }, ['userId:invalid_format']],
    ['userId is a card', { userId: PII.cardDigits, message: 'x' }, ['userId:contains_pii']],
    ['userId is an SSN', { userId: '123456789', message: 'x' }, ['userId:contains_pii']],
    ['message too long', { userId: 'u', message: 'x'.repeat(5001) }, ['message:too_long']],
    ['message blank', { userId: 'u', message: '  \n\t ' }, ['message:blank']],
    ['control char', { userId: 'u', message: 'a\u0000b' }, ['message:invalid_characters']],
    ['unknown key', { ...valid, extra: true }, ['(root):unrecognized_keys']],
    ['array body', [valid], ['(root):not_an_object']],
  ])('%s', async (_n, body, expected) => {
    const res = await t.post(body);
    await expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Request body failed validation.');
    expect(issuesOf(res)).toEqual(expected);
  });

  it('counts the length of the message in code points, not UTF-16 units', async () => {
    expect((await t.post({ userId: 'u', message: '😀'.repeat(5001) })).status).toBe(400);
  }, 30_000);

  it('rejects lone surrogates', async () => {
    const res = await t.http().post('/secure-inquiry').set('content-type', 'application/json').send('{"userId":"u","message":"a\\ud800b"}');
    await expectError(res, 400, 'VALIDATION_ERROR');
    expect(issuesOf(res)).toEqual(['message:invalid_unicode']);
  });

  it('never echoes unknown keys, even when the key is an email', async () => {
    const res = await t.post({ ...valid, [PII.email]: PII.ssn });
    await expectError(res, 400, 'VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('example.com');
    expect(JSON.stringify(res.body)).not.toContain(PII.ssn);
    expect(res.body.error.details).toEqual([{ field: '(root)', issue: 'unrecognized_keys' }]);
  });

  it('does not let the body choose a failure mode', async () => {
    const res = await t.post({ ...valid, mode: 'fail' });
    await expectError(res, 400, 'VALIDATION_ERROR');
    const q = await t.http().post('/secure-inquiry?mode=fail').set('x-mode', 'fail').send(valid);
    expect(q.status).toBe(200);
  });

  it('rejects null, a JSON string and an empty body', async () => {
    for (const raw of ['null', '"just text"', '42', '']) {
      const res = await t.http().post('/secure-inquiry').set('content-type', 'application/json').send(raw);
      expect(res.status, raw).toBe(400);
      expect(['INVALID_JSON', 'VALIDATION_ERROR']).toContain(res.body.error.code);
    }
    const empty = await t.http().post('/secure-inquiry').set('content-type', 'application/json').send('');
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
    expect(issuesOf(empty)).toEqual(['userId:required', 'message:required']);
  });

  it('invalid JSON containing PII: 400 INVALID_JSON, nothing echoed', async () => {
    const res = await t
      .http()
      .post('/secure-inquiry')
      .set('content-type', 'application/json')
      .send(`{"userId":"u","message":"${PII.email} ${PII.card}" oops`);
    await expectError(res, 400, 'INVALID_JSON');
    expect(res.body.error.message).toBe('Request body is not valid JSON.');
    expect(JSON.stringify(res.body)).not.toMatch(/example\.com|4111/);
    if (!isRemote) for (const raw of [PII.email, PII.card, PII.cardDigits]) expect(t.logs()).not.toContain(raw);
  });
});

describe('transport errors', () => {
  it('415 without or with another content type', async () => {
    for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/xml']) {
      const req = t.http().post('/secure-inquiry');
      if (ct !== undefined) req.set('content-type', ct);
      const res = await req.send(ct === undefined ? '{"userId":"u","message":"x"}' : '{"userId":"u","message":"x"}');
      await expectError(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
      expect(res.body.error.message).toBe('Content-Type must be application/json.');
    }
  });

  it('415 for a non-UTF-8 charset and for a compressed body', async () => {
    const latin = await t.http().post('/secure-inquiry').set('content-type', 'application/json; charset=latin1').send('{"userId":"u","message":"x"}');
    await expectError(latin, 415, 'UNSUPPORTED_MEDIA_TYPE');
    const gz = await t.http().post('/secure-inquiry').set('content-type', 'application/json').set('content-encoding', 'gzip').send('{"userId":"u","message":"x"}');
    await expectError(gz, 415, 'UNSUPPORTED_MEDIA_TYPE');
    const ok = await t.http().post('/secure-inquiry').set('content-type', 'application/json; charset=utf-8').send('{"userId":"u","message":"x"}');
    expect(ok.status).toBe(200);
  });

  it('413 above the body limit', async () => {
    const res = await t.http().post('/secure-inquiry').set('content-type', 'application/json').send(JSON.stringify({ userId: 'u', message: 'x'.repeat(40_000) }));
    await expectError(res, 413, 'PAYLOAD_TOO_LARGE');
    expect(res.body.error.message).toBe('Request body is too large.');
  });

  it('404 for unknown routes, without echoing the path', async () => {
    const res = await t.http().get(`/nope/${PII.email}?card=${PII.cardDigits}`);
    await expectError(res, 404, 'NOT_FOUND');
    expect(res.body.error.message).toBe('Route not found.');
    expect(JSON.stringify(res.body)).not.toContain('example.com');
    if (!isRemote) {
      expect(t.logs()).not.toContain('example.com');
      expect(t.logs()).toContain('(unmatched)');
    }
  });

  it.each(['get', 'put', 'delete', 'patch'] as const)('405 + Allow: POST for %s /secure-inquiry', async (m) => {
    const res = await t.http()[m]('/secure-inquiry');
    await expectError(res, 405, 'METHOD_NOT_ALLOWED');
    expect(res.headers.allow).toBe('POST');
  });

  it('405 + Allow: GET for POST /health', async () => {
    const res = await t.http().post('/health');
    await expectError(res, 405, 'METHOD_NOT_ALLOWED');
    expect(res.headers.allow).toBe('GET');
  });
});
