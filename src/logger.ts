import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { sanitize } from './sanitizer/index.js';

export interface CreateLoggerOptions {
  level: string;
  /** Injectable sink (tests capture the output). Defaults to stdout. */
  destination?: DestinationStream;
}

const MAX_DEPTH = 6;

/** Deep-copies a log value, running every string through the PII sanitizer. */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitize(value).sanitized;
  if (value instanceof Error) {
    // Never the message (it may quote client input); name + sanitised frames only.
    const frames = (value.stack ?? '')
      .split('\n')
      .filter((l) => /^\s+at /.test(l))
      .join('\n');
    return { name: value.name, stack: sanitize(frames).sanitized };
  }
  if (typeof value !== 'object' || value === null) return value;
  // Past the limit nothing is passed through raw: a deep string could hold PII.
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[sanitize(k).sanitized] = sanitizeValue(v, depth + 1);
  return out;
}

export function createLogger({ level, destination }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: 'secure-middleware' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => sanitizeValue(obj) as Record<string, unknown>,
      // Child-logger bindings bypass formatters.log, so sanitise them too.
      bindings: (bindings) => sanitizeValue(bindings) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        // Safety net for the message and printf-style arguments (and a bare Error as first arg).
        const safe = args.map((a) => (typeof a === 'string' ? sanitize(a).sanitized : sanitizeValue(a)));
        method.apply(this, safe as unknown as Parameters<typeof method>);
      },
    },
  };
  const logger = destination === undefined ? pino(options) : pino(options, destination);
  // pino does not run formatters.log/bindings over child bindings: sanitise them here.
  const child = logger.child.bind(logger);
  logger.child = ((bindings, childOptions) => child(sanitizeValue(bindings) as typeof bindings, childOptions)) as typeof logger.child;
  return logger;
}
