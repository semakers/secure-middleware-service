// OWNER: core agent. Public API is fixed by the contract (CONTRACT.md §7).
import type { EncryptedField } from './crypto.js';
import type { PiiType } from '../sanitizer/index.js';

export type AuditOutcome = 'answered' | 'ai_error' | 'ai_timeout' | 'circuit_open';

export interface AuditRecord {
  id: string;
  requestId: string;
  timestamp: string;
  userId: string;
  outcome: AuditOutcome;
  redactedMessage: string;
  redactions: Record<PiiType, number>;
  originalMessage: EncryptedField;
}

export interface AuditFile {
  version: 1;
  records: AuditRecord[];
}

export interface AuditStore {
  append(record: AuditRecord): Promise<void>;
  readAll(): Promise<AuditRecord[]>;
}

export class AuditStoreCorruptError extends Error {
  override readonly name = 'AuditStoreCorruptError';
}

export class JsonFileAuditStore implements AuditStore {
  /** Loads (or initialises) the JSON file. Throws AuditStoreCorruptError on an unreadable file. */
  static open(filePath: string): Promise<JsonFileAuditStore> {
    void filePath;
    throw new Error('JsonFileAuditStore.open: not implemented');
  }
  append(record: AuditRecord): Promise<void> {
    void record;
    throw new Error('not implemented');
  }
  readAll(): Promise<AuditRecord[]> {
    throw new Error('not implemented');
  }
}
