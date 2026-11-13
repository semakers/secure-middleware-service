export type PiiType = 'EMAIL' | 'CREDIT_CARD' | 'SSN';

/** A half-open `[start, end)` range of the detection copy that must be redacted. */
export interface Span {
  start: number;
  end: number;
  type: PiiType;
}
