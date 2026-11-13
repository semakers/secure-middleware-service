import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

export type ErrorCode =
  | 'INVALID_JSON'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'AUDIT_WRITE_FAILED'
  | 'INTERNAL_ERROR'
  | 'AI_UPSTREAM_ERROR'
  | 'SERVICE_BUSY'
  | 'AI_TIMEOUT';

/** Fixed status + message per code. Messages never interpolate anything. */
export const ERROR_TABLE: Readonly<Record<ErrorCode, { status: number; message: string }>> = {
  INVALID_JSON: { status: 400, message: 'Request body is not valid JSON.' },
  VALIDATION_ERROR: { status: 400, message: 'Request body failed validation.' },
  UNAUTHORIZED: { status: 401, message: 'Missing or invalid credentials.' },
  NOT_FOUND: { status: 404, message: 'Route not found.' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Method not allowed.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Request body is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Content-Type must be application/json.' },
  AUDIT_WRITE_FAILED: { status: 500, message: 'The request could not be recorded.' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error.' },
  AI_UPSTREAM_ERROR: { status: 502, message: 'The AI service failed to answer.' },
  SERVICE_BUSY: { status: 503, message: 'Service Busy' },
  AI_TIMEOUT: { status: 504, message: 'The AI service timed out.' },
};

export type ValidationField = 'userId' | 'message' | 'mode' | '(root)';
export interface ValidationDetail {
  field: ValidationField;
  issue: string;
}

export interface ErrorOptions {
  details?: readonly ValidationDetail[];
  retryAfterSeconds?: number;
  headers?: Readonly<Record<string, string>>;
}

export class AppError extends Error {
  override readonly name = 'AppError';
  constructor(
    readonly code: ErrorCode,
    readonly options: ErrorOptions = {},
  ) {
    super(code); // the message is the code, never client data
  }
}

export function requestIdOf(res: Response): string {
  const id: unknown = res.locals.requestId;
  return typeof id === 'string' ? id : 'unknown';
}

/** Writes the uniform error envelope. */
export function sendError(res: Response, code: ErrorCode, options: ErrorOptions = {}): void {
  const { status, message } = ERROR_TABLE[code];
  res.locals.outcome = code;
  for (const [name, value] of Object.entries(options.headers ?? {})) res.setHeader(name, value);
  const error: Record<string, unknown> = { code, message, requestId: requestIdOf(res) };
  if (options.details !== undefined) error.details = options.details;
  if (options.retryAfterSeconds !== undefined) error.retryAfterSeconds = options.retryAfterSeconds;
  res.status(status).json({ error });
}

/** Maps body-parser errors (by their `type`) to a code; undefined = not a body-parser error we know. */
export function codeForBodyParserError(err: unknown): ErrorCode | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const type: unknown = (err as { type?: unknown }).type;
  switch (type) {
    case 'entity.parse.failed':
      return 'INVALID_JSON';
    case 'entity.too.large':
      return 'PAYLOAD_TOO_LARGE';
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return 'UNSUPPORTED_MEDIA_TYPE';
    default:
      return undefined;
  }
}

/** Stack frames only: the first line of a stack carries err.message, which may quote the body. */
export function safeStack(err: unknown): string {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return '';
  return err.stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      sendError(res, err.code, err.options);
      return;
    }
    const mapped = codeForBodyParserError(err);
    if (mapped !== undefined) {
      sendError(res, mapped);
      return;
    }
    logger.error(
      { requestId: requestIdOf(res), errName: errorName(err), stack: safeStack(err) },
      'unhandled_error',
    );
    sendError(res, 'INTERNAL_ERROR');
  };
}
