import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { sendError } from '../errors.js';

/** Server-generated request id; a client-supplied X-Request-Id is ignored. */
export function requestId(): RequestHandler {
  return (_req, res, next) => {
    const id = randomUUID();
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

export function securityHeaders(): RequestHandler[] {
  const set: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  return [helmet(), set];
}

/** One log line per request: matched route pattern only, never the URL, query, headers or body. */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    let logged = false;
    const log = (): void => {
      if (logged) return;
      logged = true;
      const routePath: unknown = req.route?.path;
      const route = typeof routePath === 'string' ? `${req.baseUrl}${routePath}` : '(unmatched)';
      const line: Record<string, unknown> = {
        requestId: res.locals.requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - start) / 1000n) / 1000,
      };
      if (typeof res.locals.outcome === 'string') line.outcome = res.locals.outcome;
      if (res.locals.redactions !== undefined) line.redactions = res.locals.redactions;
      logger.info(line, 'request');
    };
    res.on('finish', log);
    res.on('close', log);
    next();
  };
}

const JSON_TYPE = /^application\/json$/i;

/** Requires `Content-Type: application/json` (charset, when present, must be utf-8). Else 415. */
export function requireJsonContentType(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers['content-type'];
    if (header === undefined) {
      sendError(res, 'UNSUPPORTED_MEDIA_TYPE');
      return;
    }
    const [type = '', ...params] = header.split(';').map((p) => p.trim());
    let ok = JSON_TYPE.test(type);
    for (const param of params) {
      const eq = param.indexOf('=');
      const name = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
      const value = eq < 0 ? '' : param.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').toLowerCase();
      if (name === 'charset' && value !== 'utf-8' && value !== 'utf8') ok = false;
    }
    if (!ok) {
      sendError(res, 'UNSUPPORTED_MEDIA_TYPE');
      return;
    }
    next();
  };
}

/** Strict JSON parsing: size-limited, no decompression (no zip bombs), only application/json. */
export function jsonBody(limit: number): RequestHandler {
  return express.json({ limit, strict: true, inflate: false, type: 'application/json' });
}

export function methodNotAllowed(allow: string): RequestHandler {
  return (_req, res) => sendError(res, 'METHOD_NOT_ALLOWED', { headers: { Allow: allow } });
}

export function notFound(): RequestHandler {
  return (_req, res) => sendError(res, 'NOT_FOUND');
}
