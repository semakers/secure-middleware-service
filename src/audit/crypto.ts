// OWNER: core agent. Public API is fixed by the contract (CONTRACT.md §7).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

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

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=?$/;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}=?$/;

const BAD_KEY = 'AUDIT_ENCRYPTION_KEY must be 32 random bytes encoded as base64, base64url or 64 hex characters';

function decodeKey(value: string): Buffer | undefined {
  if (HEX_KEY.test(value)) return Buffer.from(value, 'hex');
  const encoding = BASE64_KEY.test(value) ? 'base64' : BASE64URL_KEY.test(value) ? 'base64url' : undefined;
  if (encoding === undefined) return undefined;
  const buf = Buffer.from(value, encoding);
  // Reject non-canonical encodings (non-zero trailing bits) so one key has one spelling.
  const canonical = buf.toString(encoding).replace(/=+$/, '');
  return buf.length === KEY_BYTES && canonical === value.replace(/=+$/, '') ? buf : undefined;
}

/** Decodes AUDIT_ENCRYPTION_KEY: base64/base64url of 32 bytes, or 64 hex chars. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim() === '') {
    throw new InvalidKeyError('AUDIT_ENCRYPTION_KEY is required');
  }
  const key = decodeKey(raw.trim());
  if (key === undefined) throw new InvalidKeyError(BAD_KEY);
  if (key.every((byte) => byte === key[0])) {
    throw new InvalidKeyError('AUDIT_ENCRYPTION_KEY is too weak (all bytes are identical)');
  }
  return key;
}

/** The key lives only in this closure; the returned object never exposes or serialises it. */
export function createAuditCipher(key: Buffer, keyId: string): AuditCipher {
  if (key.length !== KEY_BYTES) throw new InvalidKeyError('Audit cipher key must be exactly 32 bytes');
  const secret = Buffer.from(key); // private copy
  const cipher: AuditCipher = {
    keyId,
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const c = createCipheriv('aes-256-gcm', secret, iv, { authTagLength: TAG_BYTES });
      c.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return {
        alg: 'AES-256-GCM',
        keyId,
        iv: iv.toString('base64'),
        tag: c.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    },
    decrypt(field, aad) {
      const iv = Buffer.from(field.iv, 'base64');
      const tag = Buffer.from(field.tag, 'base64');
      if (field.alg !== 'AES-256-GCM' || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new Error('Malformed encrypted field');
      }
      const d = createDecipheriv('aes-256-gcm', secret, iv, { authTagLength: TAG_BYTES });
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(tag);
      try {
        return Buffer.concat([d.update(Buffer.from(field.ciphertext, 'base64')), d.final()]).toString('utf8');
      } catch {
        throw new Error('Decryption failed (wrong key, tampered data or wrong record)');
      }
    },
  };
  const hidden = (): string => '[AuditCipher]';
  Object.defineProperties(cipher, {
    toJSON: { value: hidden, enumerable: false },
    [inspect.custom]: { value: hidden, enumerable: false },
  });
  return cipher;
}

/** Additional authenticated data that binds a ciphertext to its record. */
export function auditAad(recordId: string, userId: string): string {
  return JSON.stringify(['secure-inquiry-audit/v1', recordId, userId]);
}
