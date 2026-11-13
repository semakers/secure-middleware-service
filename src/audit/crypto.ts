// OWNER: core agent. Public API is fixed by the contract (CONTRACT.md §7).
export interface EncryptedField {
  alg: 'AES-256-GCM';
  keyId: string;
  /** base64, 12 random bytes, unique per record */
  iv: string;
  /** base64, 16 bytes */
  tag: string;
  /** base64 */
  ciphertext: string;
}

export interface AuditCipher {
  readonly keyId: string;
  encrypt(plaintext: string, aad: string): EncryptedField;
  decrypt(field: EncryptedField, aad: string): string;
}

/** Thrown for a missing/malformed/weak key. Its message NEVER contains the key material. */
export class InvalidKeyError extends Error {
  override readonly name = 'InvalidKeyError';
}

/** Decodes AUDIT_ENCRYPTION_KEY: base64/base64url of 32 bytes, or 64 hex chars. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  void raw;
  throw new Error('parseEncryptionKey: not implemented');
}

/** The key lives only in this closure; the returned object never exposes or serialises it. */
export function createAuditCipher(key: Buffer, keyId: string): AuditCipher {
  void key;
  void keyId;
  throw new Error('createAuditCipher: not implemented');
}

/** Additional authenticated data that binds a ciphertext to its record. */
export function auditAad(recordId: string, userId: string): string {
  return JSON.stringify(['secure-inquiry-audit/v1', recordId, userId]);
}
