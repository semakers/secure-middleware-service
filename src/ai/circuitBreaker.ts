// OWNER: core agent. Public API is fixed by the contract (CONTRACT.md §6).
export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit (default config: 3). */
  failureThreshold: number;
  /** How long the circuit stays open before allowing one trial call. */
  cooldownMs: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  failureThreshold: number;
  cooldownMs: number;
  /** ms until a call may be attempted again; 0 when closed or a trial is allowed now. */
  retryAfterMs: number;
}

/** Thrown immediately (fn is NOT called) when the circuit rejects a call. */
export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
  constructor(readonly retryAfterMs: number) {
    super('Circuit is open');
  }
}

export class CircuitBreaker {
  constructor(options: CircuitBreakerOptions) {
    void options;
    throw new Error('CircuitBreaker: not implemented');
  }
  get state(): CircuitState {
    throw new Error('not implemented');
  }
  snapshot(): CircuitSnapshot {
    throw new Error('not implemented');
  }
  execute<T>(fn: () => Promise<T>): Promise<T> {
    void fn;
    throw new Error('not implemented');
  }
}
