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

const MIN_RETRY_MS = 1000;

export class CircuitBreaker {
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #onStateChange: ((from: CircuitState, to: CircuitState) => void) | undefined;
  #stored: 'closed' | 'open' = 'closed';
  #trialInFlight = false;
  #failures = 0;
  #openedAt = 0;

  constructor(options: CircuitBreakerOptions) {
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new RangeError('failureThreshold must be an integer >= 1');
    }
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) {
      throw new RangeError('cooldownMs must be >= 0');
    }
    this.#threshold = options.failureThreshold;
    this.#cooldownMs = options.cooldownMs;
    this.#now = options.now ?? Date.now;
    this.#onStateChange = options.onStateChange;
  }

  #cooldownLeft(): number {
    return Math.max(0, this.#openedAt + this.#cooldownMs - this.#now());
  }

  /** Lazy: open becomes half_open once the cooldown has elapsed (or a trial is in flight). */
  get state(): CircuitState {
    if (this.#stored === 'closed') return 'closed';
    return this.#trialInFlight || this.#cooldownLeft() === 0 ? 'half_open' : 'open';
  }

  snapshot(): CircuitSnapshot {
    const state = this.state;
    let retryAfterMs = 0;
    if (state === 'open') retryAfterMs = this.#cooldownLeft();
    else if (this.#trialInFlight) retryAfterMs = MIN_RETRY_MS;
    return {
      state,
      consecutiveFailures: this.#failures,
      failureThreshold: this.#threshold,
      cooldownMs: this.#cooldownMs,
      retryAfterMs,
    };
  }

  #transition(from: CircuitState, to: CircuitState): void {
    if (from !== to) this.#onStateChange?.(from, to);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let isTrial = false;
    if (this.#stored === 'open') {
      if (this.#trialInFlight) throw new CircuitOpenError(Math.max(MIN_RETRY_MS, this.#cooldownLeft()));
      const left = this.#cooldownLeft();
      if (left > 0) throw new CircuitOpenError(left);
      isTrial = true;
      this.#trialInFlight = true;
      this.#transition('open', 'half_open');
    }
    try {
      const result = await fn();
      this.#onSuccess(isTrial);
      return result;
    } catch (err) {
      this.#onFailure(isTrial);
      throw err;
    }
  }

  #onSuccess(isTrial: boolean): void {
    if (this.#stored === 'open' && !isTrial) return; // late result of a call started before the circuit opened
    this.#failures = 0;
    if (isTrial) {
      this.#trialInFlight = false;
      this.#stored = 'closed';
      this.#transition('half_open', 'closed');
    }
  }

  #onFailure(isTrial: boolean): void {
    this.#failures += 1;
    if (isTrial) {
      this.#trialInFlight = false;
      this.#openedAt = this.#now();
      this.#transition('half_open', 'open');
    } else if (this.#stored === 'closed' && this.#failures >= this.#threshold) {
      this.#stored = 'open';
      this.#openedAt = this.#now();
      this.#transition('closed', 'open');
    }
  }
}
