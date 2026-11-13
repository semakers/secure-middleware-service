// One integration suite, two targets (CONTRACT.md §8):
//  - in-process (default): createApp() with a test config, served on 127.0.0.1:0;
//  - remote (E2E_BASE_URL set): a running container; timings come from GET /__demo/ai-mock.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createAuditCipher, parseEncryptionKey, auditAad } from '../../../src/audit/crypto.js';
import type { AuditRecord } from '../../../src/audit/store.js';
import { createApp, type AppDeps, type CreatedApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/config.js';
import { createLogger } from '../../../src/logger.js';

export const isRemote = Boolean(process.env.E2E_BASE_URL);

/** Raw PII used by the tests; none of these strings may appear in logs or the audit file. */
export const PII = {
  email: 'jane.doe+test@example.com',
  card: '4111 1111 1111 1111',
  cardDigits: '4111111111111111',
  ssn: '123-45-6789',
} as const;
export const PII_MESSAGE = `Contact ${PII.email}, card ${PII.card} and SSN ${PII.ssn} please.`;
export const PII_SANITIZED =
  'Contact <REDACTED: EMAIL>, card <REDACTED: CREDIT_CARD> and SSN <REDACTED: SSN> please.';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CircuitView {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  failureThreshold: number;
  cooldownMs: number;
  retryAfterMs: number;
}

export interface TargetOptions {
  latencyMs?: number;
  timeoutMs?: number;
  cooldownMs?: number;
  /** In-process only. */
  overrides?: Partial<AppDeps>;
  /** In-process only: capture logs here instead of the target's own buffer. */
  maxBodyBytes?: number;
}

export interface Target {
  readonly remote: boolean;
  readonly url: string;
  readonly latencyMs: number;
  readonly timeoutMs: number;
  readonly cooldownMs: number;
  readonly threshold: number;
  readonly demoToken: string;
  readonly auditPath: string | undefined;
  /** In-process only. */
  readonly deps: AppDeps | undefined;
  readonly created: CreatedApp | undefined;
  http(): ReturnType<typeof request>;
  post(body: unknown): request.Test;
  demoGet(): Promise<{ mode: string; latencyMs: number; timeoutMs: number; circuit: CircuitView }>;
  setMode(mode: 'healthy' | 'fail' | 'hang'): Promise<void>;
  health(): Promise<{ status: string; circuit: string }>;
  ensureHealthyAndClosed(): Promise<void>;
  readAudit(): AuditRecord[];
  auditFileText(): string;
  decryptOriginal(record: AuditRecord): string;
  logs(): string;
  /** URL of a production-mode server (demo control must be a 404 there), if one is available. */
  productionUrl(): Promise<string | undefined>;
  stop(): Promise<void>;
}

interface Listening {
  server: http.Server;
  url: string;
}

async function listen(app: http.RequestListener): Promise<Listening> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(l: Listening): Promise<void> {
  l.server.closeAllConnections();
  await new Promise<void>((resolve) => l.server.close(() => resolve()));
}

export async function createTarget(options: TargetOptions = {}): Promise<Target> {
  return isRemote ? createRemote() : createInProcess(options);
}

async function createInProcess(options: TargetOptions): Promise<Target> {
  const dir = mkdtempSync(path.join(tmpdir(), 'smw-int-'));
  const auditPath = path.join(dir, 'audit', 'audit-log.json');
  const key = randomBytes(32).toString('base64');
  const demoToken = `test-token-${randomBytes(16).toString('hex')}`;
  const latencyMs = options.latencyMs ?? 300;
  const timeoutMs = options.timeoutMs ?? 800;
  const cooldownMs = options.cooldownMs ?? 400;
  const baseEnv = {
    AUDIT_ENCRYPTION_KEY: key,
    AUDIT_LOG_PATH: auditPath,
    AI_MOCK_LATENCY_MS: String(latencyMs),
    AI_TIMEOUT_MS: String(timeoutMs),
    CIRCUIT_COOLDOWN_MS: String(cooldownMs),
    CIRCUIT_FAILURE_THRESHOLD: '3',
    ...(options.maxBodyBytes !== undefined && { MAX_BODY_BYTES: String(options.maxBodyBytes) }),
    NODE_ENV: 'test',
  };
  const config = loadConfig({ ...baseEnv, DEMO_CONTROL_ENABLED: 'true', DEMO_CONTROL_TOKEN: demoToken });

  const logLines: string[] = [];
  const logger = createLogger({ level: 'debug', destination: { write: (s: string) => void logLines.push(s) } });
  const created = await createApp(config, { logger, ...options.overrides });
  const main = await listen(created.app);

  let prod: (Listening & { created: CreatedApp }) | undefined;
  const cipher = createAuditCipher(parseEncryptionKey(key), 'k1');

  const target: Target = {
    remote: false,
    url: main.url,
    latencyMs,
    timeoutMs,
    cooldownMs,
    threshold: 3,
    demoToken,
    auditPath,
    deps: created.deps,
    created,
    http: () => request(main.url),
    post: (body) => request(main.url).post('/secure-inquiry').send(body as object),
    demoGet: async () => (await request(main.url).get('/__demo/ai-mock').set('Authorization', `Bearer ${demoToken}`)).body,
    setMode: async (mode) => {
      const res = await request(main.url).put('/__demo/ai-mock').set('Authorization', `Bearer ${demoToken}`).send({ mode });
      if (res.status !== 200) throw new Error(`setMode failed: ${res.status}`);
    },
    health: async () => (await request(main.url).get('/health')).body,
    ensureHealthyAndClosed: () => ensureHealthyAndClosed(target),
    readAudit: () => readAuditFile(auditPath),
    auditFileText: () => readText(auditPath),
    decryptOriginal: (r) => cipher.decrypt(r.originalMessage, auditAad(r.id, r.userId)),
    logs: () => logLines.join(''),
    productionUrl: async () => {
      if (prod === undefined) {
        const cfg = loadConfig({ ...baseEnv, NODE_ENV: 'production', AUDIT_LOG_PATH: path.join(dir, 'prod', 'a.json') });
        const app = await createApp(cfg, { logger: createLogger({ level: 'silent' }) });
        prod = { ...(await listen(app.app)), created: app };
      }
      return prod.url;
    },
    stop: async () => {
      await close(main);
      if (prod !== undefined) await close(prod);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return target;
}

async function createRemote(): Promise<Target> {
  const url = process.env.E2E_BASE_URL as string;
  const demoToken = process.env.E2E_DEMO_TOKEN ?? '';
  const auditPath = process.env.E2E_AUDIT_LOG_PATH || undefined;
  const key = process.env.AUDIT_ENCRYPTION_KEY || undefined;
  const prodUrl = process.env.E2E_PROD_BASE_URL || undefined;
  const cipher = key === undefined ? undefined : createAuditCipher(parseEncryptionKey(key), process.env.AUDIT_KEY_ID ?? 'k1');

  const get = async () =>
    (await request(url).get('/__demo/ai-mock').set('Authorization', `Bearer ${demoToken}`)).body as Awaited<ReturnType<Target['demoGet']>>;
  const initial = await get();
  if (initial?.circuit === undefined) throw new Error('E2E: GET /__demo/ai-mock failed (check E2E_DEMO_TOKEN)');

  const target: Target = {
    remote: true,
    url,
    latencyMs: initial.latencyMs,
    timeoutMs: initial.timeoutMs,
    cooldownMs: initial.circuit.cooldownMs,
    threshold: initial.circuit.failureThreshold,
    demoToken,
    auditPath,
    deps: undefined,
    created: undefined,
    http: () => request(url),
    post: (body) => request(url).post('/secure-inquiry').send(body as object),
    demoGet: get,
    setMode: async (mode) => {
      const res = await request(url).put('/__demo/ai-mock').set('Authorization', `Bearer ${demoToken}`).send({ mode });
      if (res.status !== 200) throw new Error(`setMode failed: ${res.status}`);
    },
    health: async () => (await request(url).get('/health')).body,
    ensureHealthyAndClosed: () => ensureHealthyAndClosed(target),
    readAudit: () => {
      if (auditPath === undefined) throw new Error('E2E_AUDIT_LOG_PATH is required');
      return readAuditFile(auditPath);
    },
    auditFileText: () => {
      if (auditPath === undefined) throw new Error('E2E_AUDIT_LOG_PATH is required');
      return readText(auditPath);
    },
    decryptOriginal: (r) => {
      if (cipher === undefined) throw new Error('AUDIT_ENCRYPTION_KEY is required');
      return cipher.decrypt(r.originalMessage, auditAad(r.id, r.userId));
    },
    logs: () => {
      throw new Error('logs are only available in-process');
    },
    productionUrl: async () => prodUrl,
    stop: async () => {
      await ensureHealthyAndClosed(target);
    },
  };
  await ensureHealthyAndClosed(target);
  return target;
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

function readAuditFile(file: string): AuditRecord[] {
  const text = readText(file);
  if (text === '') return [];
  return (JSON.parse(text) as { records: AuditRecord[] }).records;
}

/** Leaves the mock healthy and the circuit closed (needed on the shared remote server). */
async function ensureHealthyAndClosed(t: Target): Promise<void> {
  await t.setMode('healthy');
  for (let i = 0; i < 20; i++) {
    const { circuit } = await t.demoGet();
    if (circuit.state === 'closed' && circuit.consecutiveFailures === 0) return;
    if (circuit.state === 'open') {
      await sleep(circuit.retryAfterMs + 30);
      continue;
    }
    // half_open (or closed with failures): a healthy call is the trial / resets the counter.
    await t.post({ userId: 'reset', message: 'reset the circuit' });
  }
  throw new Error('could not restore a healthy closed circuit');
}
