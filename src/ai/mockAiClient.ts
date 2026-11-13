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
  constructor(options: MockAiClientOptions) {
    void options;
    throw new Error('MockAiClient: not implemented');
  }
  get mode(): AiMockMode {
    throw new Error('not implemented');
  }
  get latencyMs(): number {
    throw new Error('not implemented');
  }
  setMode(mode: AiMockMode): void {
    void mode;
    throw new Error('not implemented');
  }
  generate(prompt: string, options?: { signal?: AbortSignal }): Promise<AiAnswer> {
    void prompt;
    void options;
    throw new Error('not implemented');
  }
}

/** Calls client.generate() and rejects with AiTimeoutError after timeoutMs (aborting the call). */
export function generateWithTimeout(client: AiClient, prompt: string, timeoutMs: number): Promise<AiAnswer> {
  void client;
  void prompt;
  void timeoutMs;
  throw new Error('generateWithTimeout: not implemented');
}
