// OWNER: core agent. Public API is fixed by the contract (CONTRACT.md §7).
import type { AuditCipher } from './crypto.js';
import type { AuditOutcome, AuditRecord } from './store.js';
import type { PiiType } from '../sanitizer/index.js';

export interface BuildAuditRecordInput {
  requestId: string;
  userId: string;
  outcome: AuditOutcome;
  originalMessage: string;
  redactedMessage: string;
  redactions: Record<PiiType, number>;
  cipher: AuditCipher;
  /** defaults: crypto.randomUUID / new Date() */
  newId?: () => string;
  now?: () => Date;
}

/** Encrypts the original with a fresh IV and AAD = auditAad(id, userId). */
export function buildAuditRecord(input: BuildAuditRecordInput): AuditRecord {
  void input;
  throw new Error('buildAuditRecord: not implemented');
}
