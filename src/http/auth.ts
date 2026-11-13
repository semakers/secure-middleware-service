import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../errors.js';

const BEARER = /^Bearer (\S+)$/i;

export function digestOf(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison of a presented token against the expected SHA-256 digest. */
export function bearerMatches(header: string | undefined, expectedDigest: Buffer): boolean {
  const presented = header === undefined ? null : BEARER.exec(header)?.[1];
  // Always hash and compare, so the work done does not depend on the header's shape.
  const actual = digestOf(presented ?? '');
  const equal = timingSafeEqual(actual, expectedDigest);
  return equal && presented !== null && presented !== undefined;
}

export function requireBearer(expectedDigest: Buffer) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (bearerMatches(req.headers.authorization, expectedDigest)) {
      next();
      return;
    }
    sendError(res, 'UNAUTHORIZED', { headers: { 'WWW-Authenticate': 'Bearer' } });
  };
}
