import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError, codeForBodyParserError, createErrorHandler, ERROR_TABLE, safeStack, errorName } from '../../../src/errors.js';
import { jsonBody, notFound, requestId, requireJsonContentType } from '../../../src/http/middleware.js';
import { createLogger } from '../../../src/logger.js';

function build(limit = 100) {
  const logs: string[] = [];
  const logger = createLogger({ level: 'info', destination: { write: (s: string) => void logs.push(s) } });
  const app = express();
  app.use(requestId());
  app.post('/p', requireJsonContentType(), jsonBody(limit), (_req, res) => void res.json({ ok: true }));
  app.get('/boom', () => {
    throw new Error('secret jo@example.com 4111111111111111');
  });
  app.get('/app', () => {
    throw new AppError('SERVICE_BUSY', { retryAfterSeconds: 3, headers: { 'Retry-After': '3' } });
  });
  app.get('/late', (res0, res) => {
    res.write('x');
    throw new Error('after headers');
  });
  app.use(notFound());
  app.use(createErrorHandler(logger));
  return { app, logs };
}

describe('error handling', () => {
  it('has a fixed message per code', () => {
    expect(ERROR_TABLE.SERVICE_BUSY).toEqual({ status: 503, message: 'Service Busy' });
    expect(Object.keys(ERROR_TABLE)).toHaveLength(12);
  });

  it('maps invalid JSON without echoing the body', async () => {
    const { app } = build();
    const res = await request(app).post('/p').set('content-type', 'application/json').send('{"a": jo@example.com');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_JSON', message: 'Request body is not valid JSON.' });
    expect(JSON.stringify(res.body)).not.toContain('example.com');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('maps too large, charset and encoding errors', async () => {
    const { app } = build(20);
    const big = await request(app).post('/p').set('content-type', 'application/json').send('{"a":"' + 'x'.repeat(100) + '"}');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const lat = await request(app).post('/p').set('content-type', 'application/json; charset=latin1').send('{}');
    expect(lat.status).toBe(415);
    const gz = await request(app).post('/p').set('content-type', 'application/json').set('content-encoding', 'gzip').send('{}');
    expect(gz.status).toBe(415);
    expect(gz.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('accepts json with a utf-8 charset (quoted or not) and rejects other types', async () => {
    const { app } = build();
    for (const ct of ['application/json; charset=utf-8', 'APPLICATION/JSON;charset="UTF-8"', 'application/json; foo=bar', 'application/json; flag']) {
      expect((await request(app).post('/p').set('content-type', ct).send('{}')).status).toBe(200);
    }
    expect((await request(build().app).post('/p').set('content-type', 'application/json; charset').send('{}')).status).toBe(415);
    for (const ct of ['text/plain', 'application/xml', 'application/jsonx']) {
      expect((await request(app).post('/p').set('content-type', ct).send('{}')).status).toBe(415);
    }
    expect((await request(app).post('/p').send('')).status).toBe(415);
  });

  it('turns unexpected errors into a generic 500 and logs no message or PII', async () => {
    const { app, logs } = build();
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error.' });
    const out = logs.join('');
    expect(out).toContain('"errName":"Error"');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('4111111111111111');
  });

  it('renders AppError with its headers and retryAfterSeconds', async () => {
    const res = await request(build().app).get('/app');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.body.error.retryAfterSeconds).toBe(3);
    expect(res.body.error.details).toBeUndefined();
  });

  it('404s unknown routes and delegates when headers are already sent', async () => {
    const res = await request(build().app).get('/nope?q=jo@example.com');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await request(build().app).get('/late').catch(() => undefined);
  });

  it('helpers', () => {
    expect(codeForBodyParserError(null)).toBeUndefined();
    expect(codeForBodyParserError('x')).toBeUndefined();
    expect(codeForBodyParserError({ type: 'other' })).toBeUndefined();
    expect(safeStack('x')).toBe('');
    const e = new Error('msg jo@example.com');
    expect(safeStack(e)).not.toContain('msg');
    expect(safeStack(Object.assign(new Error('m'), { stack: undefined }))).toBe('');
    expect(errorName(e)).toBe('Error');
    expect(errorName(5)).toBe('number');
  });
});
