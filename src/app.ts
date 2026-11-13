import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { CircuitBreaker } from './ai/circuitBreaker.js';
import { MockAiClient } from './ai/mockAiClient.js';
import { createAuditCipher, type AuditCipher } from './audit/crypto.js';
import { JsonFileAuditStore, type AuditStore } from './audit/store.js';
import type { AppConfig } from './config.js';
import { createErrorHandler } from './errors.js';
import { notFound, requestId, requestLogger, securityHeaders } from './http/middleware.js';
import { demoRouter, inquiryRouter, type ControllableAi } from './http/routes.js';
import { InquiryService } from './inquiry/service.js';
import { createLogger } from './logger.js';

export interface AppDeps {
  logger: Logger;
  ai: ControllableAi & MockAiClient;
  breaker: CircuitBreaker;
  store: AuditStore;
  cipher: AuditCipher;
}

export interface CreatedApp {
  app: Express;
  deps: AppDeps;
  close(): Promise<void>;
}

export async function createApp(config: AppConfig, overrides: Partial<AppDeps> = {}): Promise<CreatedApp> {
  const logger = overrides.logger ?? createLogger({ level: config.logLevel });
  const ai =
    overrides.ai ?? new MockAiClient({ latencyMs: config.aiMockLatencyMs, mode: config.aiMockMode });
  const breaker =
    overrides.breaker ??
    new CircuitBreaker({
      failureThreshold: config.circuitFailureThreshold,
      cooldownMs: config.circuitCooldownMs,
      onStateChange: (from, to) => logger.warn({ from, to }, 'circuit_state_change'),
    });
  const store = overrides.store ?? (await JsonFileAuditStore.open(config.auditLogPath));
  const cipher = overrides.cipher ?? createAuditCipher(config.auditKey, config.auditKeyId);
  const deps: AppDeps = { logger, ai, breaker, store, cipher };

  const service = new InquiryService({ ai, breaker, store, cipher, logger, aiTimeoutMs: config.aiTimeoutMs });
  const routeDeps = { service, breaker, logger, maxBodyBytes: config.maxBodyBytes };

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(requestId(), ...securityHeaders(), requestLogger(logger));
  app.use(inquiryRouter(routeDeps));
  if (config.demoControlEnabled && config.nodeEnv !== 'production' && config.demoTokenDigest !== undefined) {
    app.use(
      demoRouter({
        ai,
        breaker,
        aiTimeoutMs: config.aiTimeoutMs,
        maxBodyBytes: config.maxBodyBytes,
        tokenDigest: config.demoTokenDigest,
      }),
    );
  }
  app.use(notFound());
  app.use(createErrorHandler(logger));

  return { app, deps, close: async () => undefined };
}
