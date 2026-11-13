// OWNER: sanitizer agent. Public API is fixed by the contract (CONTRACT.md §5).
export type PiiType = 'EMAIL' | 'CREDIT_CARD' | 'SSN';

export const PII_TYPES: readonly PiiType[] = ['EMAIL', 'CREDIT_CARD', 'SSN'] as const;

export interface SanitizeResult {
  /** The redacted text. Every match is replaced by `<REDACTED: TYPE>`. */
  sanitized: string;
  /** How many matches of each type were replaced (all three keys always present). */
  redactions: Record<PiiType, number>;
}

export function redactionToken(type: PiiType): string {
  return `<REDACTED: ${type}>`;
}

export function sanitize(input: string): SanitizeResult {
  void input;
  throw new Error('sanitize: not implemented');
}

/** True when sanitize() would redact anything in `input`. */
export function containsPii(input: string): boolean {
  void input;
  throw new Error('containsPii: not implemented');
}
