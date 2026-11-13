import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config.js';

const KEY = randomBytes(32).toString('base64');
const TOKEN = 'demo-token-' + 'x'.repeat(20);
const base = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ AUDIT_ENCRYPTION_KEY: KEY, ...extra });

function issuesOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues.map((i) => i.variable);
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig(base());
    expect(c).toMatchObject({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 4380,
      logLevel: 'info',
      maxBodyBytes: 32768,
      auditKeyId: 'k1',
      auditLogPath: 'data/audit-log.json',
      aiMockLatencyMs: 2000,
      aiMockMode: 'healthy',
      aiTimeoutMs: 5000,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 15000,
      demoControlEnabled: false,
    });
    expect(c.auditKey).toBeInstanceOf(Buffer);
    expect(c.auditKey.length).toBe(32);
    expect(c.demoTokenDigest).toBeUndefined();
  });

  it('reads every variable and treats empty strings as unset', () => {
    const c = loadConfig(
      base({
        NODE_ENV: 'test',
        HOST: '0.0.0.0',
        PORT: '8080',
        LOG_LEVEL: 'silent',
        MAX_BODY_BYTES: '1000',
        AUDIT_KEY_ID: 'key_2',
        AUDIT_LOG_PATH: '/tmp/a.json',
        AI_MOCK_LATENCY_MS: '50',
        AI_MOCK_MODE: 'fail',
        AI_TIMEOUT_MS: '400',
        CIRCUIT_FAILURE_THRESHOLD: '5',
        CIRCUIT_COOLDOWN_MS: '400',
        DEMO_CONTROL_ENABLED: 'true',
        DEMO_CONTROL_TOKEN: TOKEN,
      }),
    );
    expect(c).toMatchObject({ nodeEnv: 'test', host: '0.0.0.0', port: 8080, logLevel: 'silent', aiMockMode: 'fail', demoControlEnabled: true });
    expect(c.demoTokenDigest?.length).toBe(32);
    expect(loadConfig(base({ PORT: '', HOST: '' })).port).toBe(4380);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['PORT', '-1'],
    ['PORT', '80.5'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'loud'],
    ['MAX_BODY_BYTES', '0'],
    ['AUDIT_KEY_ID', 'bad id!'],
    ['AI_MOCK_MODE', 'broken'],
    ['AI_TIMEOUT_MS', '0'],
    ['CIRCUIT_FAILURE_THRESHOLD', '0'],
    ['CIRCUIT_COOLDOWN_MS', 'x'],
    ['DEMO_CONTROL_ENABLED', 'yes'],
    ['DEMO_CONTROL_ENABLED', 'TRUE'],
  ])('rejects %s=%s naming the variable but not the value', (name, value) => {
    const env = base({ [name]: value, DEMO_CONTROL_TOKEN: TOKEN });
    expect(issuesOf(env)).toContain(name);
    try {
      loadConfig(env);
    } catch (e) {
      expect((e as Error).message).toContain(name);
      expect((e as Error).message).not.toContain(`${value}`.length > 3 ? value : '\u0000');
    }
  });

  it('requires the audit key and never echoes a bad one', () => {
    expect(issuesOf({})).toEqual(['AUDIT_ENCRYPTION_KEY']);
    expect(issuesOf({ AUDIT_ENCRYPTION_KEY: '' })).toEqual(['AUDIT_ENCRYPTION_KEY']);
    const bad = 'not-a-valid-key-SECRETVALUE';
    try {
      loadConfig({ AUDIT_ENCRYPTION_KEY: bad });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('AUDIT_ENCRYPTION_KEY');
      expect((e as Error).message).not.toContain('SECRETVALUE');
    }
  });

  it('collects every problem at once', () => {
    expect(issuesOf({ PORT: 'x', LOG_LEVEL: 'y' })).toEqual(['PORT', 'LOG_LEVEL', 'AUDIT_ENCRYPTION_KEY']);
  });

  it('demo control needs a token of at least 24 characters', () => {
    expect(issuesOf(base({ DEMO_CONTROL_ENABLED: 'true' }))).toEqual(['DEMO_CONTROL_TOKEN']);
    expect(issuesOf(base({ DEMO_CONTROL_ENABLED: 'true', DEMO_CONTROL_TOKEN: 'short' }))).toEqual(['DEMO_CONTROL_TOKEN']);
    expect(loadConfig(base({ DEMO_CONTROL_ENABLED: 'false', DEMO_CONTROL_TOKEN: 'short' })).demoTokenDigest).toBeUndefined();
  });

  it('refuses production with the demo control enabled', () => {
    expect(issuesOf(base({ NODE_ENV: 'production', DEMO_CONTROL_ENABLED: 'true', DEMO_CONTROL_TOKEN: TOKEN }))).toEqual([
      'DEMO_CONTROL_ENABLED',
    ]);
    expect(loadConfig(base({ NODE_ENV: 'production' })).nodeEnv).toBe('production');
  });

  it('does not reveal the key or the token through JSON, inspect or spread', () => {
    const c = loadConfig(base({ DEMO_CONTROL_ENABLED: 'true', DEMO_CONTROL_TOKEN: TOKEN }));
    for (const text of [JSON.stringify(c), inspect(c, { depth: 5 }), JSON.stringify({ ...c }), String(Object.values(c))]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(c.auditKey.toString('hex'));
      expect(text).not.toContain(c.auditKey.toString('base64'));
    }
    expect(Object.keys(c)).not.toContain('auditKey');
  });
});
