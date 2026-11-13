import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { start } from '../../../src/bootstrap.js';

class Exit extends Error {
  constructor(readonly code: number) {
    super('exit');
  }
}
const exit = ((code: number) => {
  throw new Exit(code);
}) as (code: number) => never;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    AUDIT_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    AUDIT_LOG_PATH: join(mkdtempSync(join(tmpdir(), 'smw-boot-')), 'a.json'),
    AI_MOCK_LATENCY_MS: '10',
    ...extra,
  };
}

function capture() {
  const lines: string[] = [];
  return { destination: { write: (s: string) => void lines.push(s) }, text: () => lines.join('') };
}

describe('start', () => {
  it('listens, serves /health and closes idempotently, removing its signal handlers', async () => {
    const signals = new EventEmitter();
    const log = capture();
    const s = await start(env(), { signals: signals as never, exit, logDestination: log.destination });
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const body = await new Promise<string>((resolve, reject) =>
      http.get(`${s.url}/health`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      }).on('error', reject),
    );
    expect(JSON.parse(body)).toEqual({ status: 'ok', circuit: 'closed' });
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    await Promise.all([s.close(), s.close()]);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(log.text()).toContain('listening');
  });

  it('SIGINT shuts down and exits 0', async () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    await start(env(), { signals: signals as never, exit: ((c: number) => void exits.push(c)) as never, logDestination: capture().destination });
    signals.emit('SIGINT');
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  it('forces lingering keep-alive connections closed after the shutdown timeout', async () => {
    const signals = new EventEmitter();
    const s = await start(env({ AI_MOCK_LATENCY_MS: '600000', AI_TIMEOUT_MS: '600000' }), {
      signals: signals as never,
      exit,
      logDestination: capture().destination,
      shutdownTimeoutMs: 50,
    });
    const req = http.request(`${s.url}/secure-inquiry`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ userId: 'u', message: 'hang' }));
    await new Promise((r) => setTimeout(r, 100));
    await s.close();
    expect(s.server.listening).toBe(false);
  });

  it('an invalid configuration logs the variable names (not values) and exits 1', async () => {
    const log = capture();
    await expect(start(env({ PORT: 'secret-port-value', AUDIT_ENCRYPTION_KEY: 'bad-SECRETKEY' }), { exit, logDestination: log.destination })).rejects.toMatchObject({ code: 1 });
    expect(log.text()).toContain('invalid_configuration');
    expect(log.text()).toContain('PORT');
    expect(log.text()).not.toContain('secret-port-value');
    expect(log.text()).not.toContain('SECRETKEY');
  });

  it('production with the demo control enabled refuses to start', async () => {
    await expect(
      start(env({ NODE_ENV: 'production', DEMO_CONTROL_ENABLED: 'true', DEMO_CONTROL_TOKEN: 'x'.repeat(30) }), { exit, logDestination: capture().destination }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('a failure while starting (port in use) logs a safe line and exits 1', async () => {
    const first = await start(env(), { exit, signals: new EventEmitter() as never, logDestination: capture().destination });
    const port = new URL(first.url).port;
    const log = capture();
    await expect(start(env({ PORT: port }), { exit, signals: new EventEmitter() as never, logDestination: log.destination })).rejects.toMatchObject({ code: 1 });
    expect(log.text()).toContain('startup_failed');
    await first.close();
  });

  it('works with the default process signals and logger seams', async () => {
    const s = await start(env({ LOG_LEVEL: 'silent' }), { exit });
    await s.close();
  });
});
