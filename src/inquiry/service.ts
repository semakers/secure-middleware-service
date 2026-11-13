import type { Logger } from 'pino';
import { AiTimeoutError, generateWithTimeout, type AiClient } from '../ai/mockAiClient.js';
import { CircuitOpenError, type CircuitBreaker } from '../ai/circuitBreaker.js';
import type { AuditCipher } from '../audit/crypto.js';
import { buildAuditRecord } from '../audit/record.js';
import type { AuditOutcome, AuditStore } from '../audit/store.js';
import { AppError, errorName, type ErrorCode } from '../errors.js';
import { sanitize, type PiiType } from '../sanitizer/index.js';

export interface InquiryServiceDeps {
  ai: AiClient;
  breaker: CircuitBreaker;
  store: AuditStore;
  cipher: AuditCipher;
  logger: Logger;
  aiTimeoutMs: number;
}

export interface InquiryRequest {
  requestId: string;
  userId: string;
  message: string;
}

export interface InquirySuccess {
  requestId: string;
  auditId: string;
  answer: string;
  sanitizedMessage: string;
  redactions: Record<PiiType, number>;
}

/** What the HTTP layer needs to log, available on success and on failure. */
export interface InquiryObservation {
  outcome?: AuditOutcome;
  redactions?: Record<PiiType, number>;
}

export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

function classify(err: unknown): { outcome: AuditOutcome; error: AppError } {
  if (err instanceof CircuitOpenError) {
    const seconds = retryAfterSeconds(err.retryAfterMs);
    return {
      outcome: 'circuit_open',
      error: new AppError('SERVICE_BUSY', {
        retryAfterSeconds: seconds,
        headers: { 'Retry-After': String(seconds) },
      }),
    };
  }
  if (err instanceof AiTimeoutError) return { outcome: 'ai_timeout', error: new AppError('AI_TIMEOUT') };
  return { outcome: 'ai_error', error: new AppError('AI_UPSTREAM_ERROR' satisfies ErrorCode) };
}

export class InquiryService {
  constructor(private readonly deps: InquiryServiceDeps) {}

  /**
   * validate (done by the caller) → sanitize → AI via the breaker (sanitised text only) →
   * audit EVERY inquiry (fail closed) → answer. Throws AppError for every non-200 result.
   */
  async handle(req: InquiryRequest, observe: InquiryObservation = {}): Promise<InquirySuccess> {
    const { ai, breaker, store, cipher, logger, aiTimeoutMs } = this.deps;
    const { sanitized, redactions } = sanitize(req.message);
    observe.redactions = redactions;

    let answer: string | undefined;
    let outcome: AuditOutcome = 'answered';
    let failure: AppError | undefined;
    try {
      const result = await breaker.execute(() => generateWithTimeout(ai, sanitized, aiTimeoutMs));
      answer = result.answer;
    } catch (err) {
      ({ outcome, error: failure } = classify(err));
      if (outcome !== 'circuit_open') logger.warn({ requestId: req.requestId, errName: errorName(err), outcome }, 'ai_call_failed');
    }
    observe.outcome = outcome;

    const record = buildAuditRecord({
      requestId: req.requestId,
      userId: req.userId,
      outcome,
      originalMessage: req.message,
      redactedMessage: sanitized,
      redactions,
      cipher,
    });
    try {
      await store.append(record);
    } catch (err) {
      logger.error({ requestId: req.requestId, errName: errorName(err) }, 'audit_write_failed');
      throw new AppError('AUDIT_WRITE_FAILED');
    }

    if (failure !== undefined || answer === undefined) throw failure ?? new AppError('INTERNAL_ERROR');
    return { requestId: req.requestId, auditId: record.id, answer, sanitizedMessage: sanitized, redactions };
  }
}
