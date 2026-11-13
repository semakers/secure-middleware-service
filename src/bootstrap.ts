import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DestinationStream } from 'pino';
import { createApp, type AppDeps } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { errorName } from './errors.js';
import { createLogger } from './logger.js';

export interface StartOptions {
  /** Test seams. */
  exit?: (code: number) => never;
  signals?: Pick<NodeJS.Process, 'once' | 'off'>;
  logDestination?: DestinationStream;
  overrides?: Partial<AppDeps>;
  shutdownTimeoutMs?: number;
}

export interface Started {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function start(env: NodeJS.ProcessEnv, options: StartOptions = {}): Promise<Started> {
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const signals = options.signals ?? process;
  const bootLogger = createLogger({ level: 'info', ...(options.logDestination && { destination: options.logDestination }) });

  try {
    const config = loadConfig(env);
    const logger = options.logDestination
      ? createLogger({ level: config.logLevel, destination: options.logDestination })
      : createLogger({ level: config.logLevel });
    const { app, close: closeApp } = await createApp(config, { logger, ...options.overrides });
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(config.port, config.host, () => resolve(s));
      s.once('error', reject);
    });
    const { address, port } = server.address() as AddressInfo;
    const url = `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
    logger.info({ url, nodeEnv: config.nodeEnv, demoControl: config.demoControlEnabled }, 'listening');

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        // Stop accepting; in-flight requests (and their audit writes) finish first.
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        const timer = setTimeout(() => server.closeAllConnections(), options.shutdownTimeoutMs ?? 10_000);
        timer.unref();
        await closed;
        clearTimeout(timer);
        await closeApp();
        signals.off('SIGTERM', onSignal);
        signals.off('SIGINT', onSignal);
      })();
      return closing;
    };
    const onSignal = (): void => {
      logger.info({}, 'shutting_down');
      void close().then(() => exit(0));
    };
    signals.once('SIGTERM', onSignal);
    signals.once('SIGINT', onSignal);
    return { server, url, close };
  } catch (err) {
    if (err instanceof ConfigError) {
      bootLogger.error({ issues: err.issues }, 'invalid_configuration');
    } else {
      bootLogger.error({ errName: errorName(err) }, 'startup_failed');
    }
    return exit(1);
  }
}
