// OWNER: core agent. Public API is fixed by the contract (CONTRACT.md §6).
export type AiMockMode = 'healthy' | 'fail' | 'hang';
export const AI_MOCK_MODES: readonly AiMockMode[] = ['healthy', 'fail', 'hang'] as const;
export const GENERATED_ANSWER = 'Generated Answer';

export interface AiAnswer {
  answer: string;
}

export interface AiClient {
  generate(prompt: string, options?: { signal?: AbortSignal }): Promise<AiAnswer>;
}

/** The mock upstream failed (mode "fail"). */
export class AiUpstreamError extends Error {
  override readonly name = 'AiUpstreamError';
}

/** The call did not settle within the configured timeout. */
export class AiTimeoutError extends Error {
  override readonly name = 'AiTimeoutError';
}

export interface MockAiClientOptions {
  latencyMs: number;
  mode: AiMockMode;
}

export class MockAiClient implements AiClient {
  readonly #latencyMs: number;
  #mode: AiMockMode;

  constructor(options: MockAiClientOptions) {
    this.#latencyMs = options.latencyMs;
    this.#mode = options.mode;
  }
  get mode(): AiMockMode {
    return this.#mode;
  }
  get latencyMs(): number {
    return this.#latencyMs;
  }
  setMode(mode: AiMockMode): void {
    if (!AI_MOCK_MODES.includes(mode)) throw new RangeError('Unknown AI mock mode');
    this.#mode = mode;
  }
  /** One setTimeout per call. The mode is read when the call starts. */
  generate(prompt: string, options?: { signal?: AbortSignal }): Promise<AiAnswer> {
    void prompt;
    const signal = options?.signal;
    const mode = this.#mode;
    return new Promise<AiAnswer>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (mode === 'hang') {
        // never settles unless aborted; no timer
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        if (mode === 'fail') reject(new AiUpstreamError('Mock AI upstream failure'));
        else resolve({ answer: GENERATED_ANSWER });
      }, this.#latencyMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function abortError(): Error {
  const err = new Error('The AI call was aborted');
  err.name = 'AbortError';
  return err;
}

/** Calls client.generate() and rejects with AiTimeoutError after timeoutMs (aborting the call). */
export function generateWithTimeout(client: AiClient, prompt: string, timeoutMs: number): Promise<AiAnswer> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AiTimeoutError(`AI call exceeded ${String(timeoutMs)} ms`));
      controller.abort();
    }, timeoutMs);
  });
  let call: Promise<AiAnswer>;
  try {
    call = client.generate(prompt, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    return Promise.reject(err instanceof Error ? err : new Error('AI call failed'));
  }
  return Promise.race([call, deadline]).finally(() => {
    clearTimeout(timer);
  });
}
