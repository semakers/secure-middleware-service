import { Router } from 'express';
import type { Logger } from 'pino';
import type { AiMockMode } from '../ai/mockAiClient.js';
import type { CircuitBreaker, CircuitSnapshot } from '../ai/circuitBreaker.js';
import { AppError, requestIdOf } from '../errors.js';
import type { InquiryObservation, InquiryService } from '../inquiry/service.js';
import { requireBearer } from './auth.js';
import { jsonBody, methodNotAllowed, requireJsonContentType } from './middleware.js';
import { validateDemoMode, validateInquiry } from './validation.js';

/** The mock AI as the demo control sees it. */
export interface ControllableAi {
  readonly mode: AiMockMode;
  readonly latencyMs: number;
  setMode(mode: AiMockMode): void;
}

export interface RouteDeps {
  service: InquiryService;
  breaker: CircuitBreaker;
  logger: Logger;
  maxBodyBytes: number;
}

export function inquiryRouter({ service, breaker, maxBodyBytes }: RouteDeps): Router {
  const router = Router();
  router
    .route('/secure-inquiry')
    .post(requireJsonContentType(), jsonBody(maxBodyBytes), async (req, res) => {
      const parsed = validateInquiry(req.body);
      if (!parsed.ok) throw new AppError('VALIDATION_ERROR', { details: parsed.details });
      const observation: InquiryObservation = {};
      try {
        const result = await service.handle({ requestId: requestIdOf(res), ...parsed.value }, observation);
        res.locals.outcome = observation.outcome;
        res.locals.redactions = observation.redactions;
        res.status(200).json(result);
      } catch (err) {
        res.locals.redactions = observation.redactions;
        throw err;
      }
    })
    .all(methodNotAllowed('POST'));

  router.route('/health').get((_req, res) => {
    res.status(200).json({ status: 'ok', circuit: breaker.state });
  }).all(methodNotAllowed('GET'));
  return router;
}

export interface DemoDeps {
  ai: ControllableAi;
  breaker: CircuitBreaker;
  aiTimeoutMs: number;
  maxBodyBytes: number;
  tokenDigest: Buffer;
}

export function demoRouter({ ai, breaker, aiTimeoutMs, maxBodyBytes, tokenDigest }: DemoDeps): Router {
  const router = Router();
  const view = (): { mode: AiMockMode; latencyMs: number; timeoutMs: number; circuit: CircuitSnapshot } => ({
    mode: ai.mode,
    latencyMs: ai.latencyMs,
    timeoutMs: aiTimeoutMs,
    circuit: breaker.snapshot(),
  });
  router
    .route('/__demo/ai-mock')
    .all(requireBearer(tokenDigest))
    .get((_req, res) => {
      res.status(200).json(view());
    })
    .put(requireJsonContentType(), jsonBody(maxBodyBytes), (req, res) => {
      const parsed = validateDemoMode(req.body);
      if (!parsed.ok) throw new AppError('VALIDATION_ERROR', { details: parsed.details });
      ai.setMode(parsed.value.mode);
      res.status(200).json(view());
    })
    .all(methodNotAllowed('GET, PUT'));
  return router;
}
