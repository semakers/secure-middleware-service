import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseEncryptionKey } from './audit/crypto.js';

export type AiMockModeName = 'healthy' | 'fail' | 'hang';

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly maxBodyBytes: number;
  readonly auditKeyId: string;
  readonly auditLogPath: string;
  readonly aiMockLatencyMs: number;
  readonly aiMockMode: AiMockModeName;
  readonly aiTimeoutMs: number;
  readonly circuitFailureThreshold: number;
  readonly circuitCooldownMs: number;
  readonly demoControlEnabled: boolean;
  /**
   * Secrets. They are defined as NON-enumerable properties, so JSON.stringify,
   * util.inspect, spreading and logging the config never reveal them.
   * `auditKey` is the parsed 32-byte key; `demoTokenDigest` the SHA-256 of the demo token
   * (the token itself is not kept).
   */
  readonly auditKey: Buffer;
  readonly demoTokenDigest: Buffer | undefined;
}

export interface ConfigIssue {
  variable: string;
  reason: 'missing' | 'invalid' | 'not_allowed';
}

/** Thrown for a bad environment. The message names variables, NEVER their values. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => `${i.variable} (${i.reason})`).join(', ')}`);
    this.issues = issues;
  }
}

const intIn = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,10}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const MIN_DEMO_TOKEN_LENGTH = 24;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const issues: ConfigIssue[] = [];

  function read<T>(name: string, schema: z.ZodType<T>, fallback: T): T {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    issues.push({ variable: name, reason: 'invalid' });
    return fallback;
  }

  const nodeEnv = read('NODE_ENV', z.enum(['development', 'test', 'production']), 'development');
  const host = read('HOST', z.string().min(1).max(255), '127.0.0.1');
  const port = read('PORT', intIn(0, 65535), 4380);
  const logLevel = read('LOG_LEVEL', z.enum(LOG_LEVELS), 'info');
  const maxBodyBytes = read('MAX_BODY_BYTES', intIn(1, 10_000_000), 32768);
  const auditKeyId = read('AUDIT_KEY_ID', z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), 'k1');
  const auditLogPath = read('AUDIT_LOG_PATH', z.string().min(1).max(4096), 'data/audit-log.json');
  const aiMockLatencyMs = read('AI_MOCK_LATENCY_MS', intIn(0, 600_000), 2000);
  const aiMockMode = read('AI_MOCK_MODE', z.enum(['healthy', 'fail', 'hang']), 'healthy');
  const aiTimeoutMs = read('AI_TIMEOUT_MS', intIn(1, 600_000), 5000);
  const circuitFailureThreshold = read('CIRCUIT_FAILURE_THRESHOLD', intIn(1, 1000), 3);
  const circuitCooldownMs = read('CIRCUIT_COOLDOWN_MS', intIn(1, 86_400_000), 15000);
  const demoControlEnabled = read(
    'DEMO_CONTROL_ENABLED',
    z.enum(['true', 'false']).transform((v) => v === 'true'),
    false,
  );

  let auditKey: Buffer | undefined;
  const rawKey = env.AUDIT_ENCRYPTION_KEY;
  if (rawKey === undefined || rawKey === '') {
    issues.push({ variable: 'AUDIT_ENCRYPTION_KEY', reason: 'missing' });
  } else {
    try {
      auditKey = parseEncryptionKey(rawKey);
    } catch {
      // Deliberately drop the error: whatever it says, it must not reach our message.
      issues.push({ variable: 'AUDIT_ENCRYPTION_KEY', reason: 'invalid' });
    }
  }

  let demoTokenDigest: Buffer | undefined;
  if (demoControlEnabled) {
    if (nodeEnv === 'production') issues.push({ variable: 'DEMO_CONTROL_ENABLED', reason: 'not_allowed' });
    const token = env.DEMO_CONTROL_TOKEN;
    if (token === undefined || token === '') {
      issues.push({ variable: 'DEMO_CONTROL_TOKEN', reason: 'missing' });
    } else if (token.length < MIN_DEMO_TOKEN_LENGTH) {
      issues.push({ variable: 'DEMO_CONTROL_TOKEN', reason: 'invalid' });
    } else {
      demoTokenDigest = createHash('sha256').update(token).digest();
    }
  }

  if (issues.length > 0 || auditKey === undefined) throw new ConfigError(issues);

  const config = {
    nodeEnv,
    host,
    port,
    logLevel,
    maxBodyBytes,
    auditKeyId,
    auditLogPath,
    aiMockLatencyMs,
    aiMockMode,
    aiTimeoutMs,
    circuitFailureThreshold,
    circuitCooldownMs,
    demoControlEnabled,
  };
  return Object.defineProperties(config, {
    auditKey: { value: auditKey, enumerable: false },
    demoTokenDigest: { value: demoTokenDigest, enumerable: false },
  }) as AppConfig;
}
