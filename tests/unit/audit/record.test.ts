import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditAad, createAuditCipher } from '../../../src/audit/crypto.js';
import { buildAuditRecord } from '../../../src/audit/record.js';

const cipher = createAuditCipher(randomBytes(32), 'k1');
const original = 'My email is juan.perez@example.com and card 4111 1111 1111 1111 😀';
const input = {
  requestId: 'req-1',
  userId: 'user-1',
  outcome: 'answered' as const,
  originalMessage: original,
  redactedMessage: 'My email is <REDACTED: EMAIL> and card <REDACTED: CREDIT_CARD> 😀',
  redactions: { EMAIL: 1, CREDIT_CARD: 1, SSN: 0 },
  cipher,
};

describe('buildAuditRecord', () => {
  it('decrypts back with auditAad(id, userId)', () => {
    const rec = buildAuditRecord(input);
    expect(cipher.decrypt(rec.originalMessage, auditAad(rec.id, 'user-1'))).toBe(original);
    expect(() => cipher.decrypt(rec.originalMessage, auditAad(rec.id, 'other'))).toThrow();
    expect(() => cipher.decrypt(rec.originalMessage, auditAad('other-id', 'user-1'))).toThrow();
  });

  it('fills the plaintext fields and an ISO timestamp / UUID', () => {
    const rec = buildAuditRecord(input);
    expect(rec).toMatchObject({
      requestId: 'req-1',
      userId: 'user-1',
      outcome: 'answered',
      redactedMessage: input.redactedMessage,
      redactions: { EMAIL: 1, CREDIT_CARD: 1, SSN: 0 },
    });
    expect(rec.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Date(rec.timestamp).toISOString()).toBe(rec.timestamp);
  });

  it('uses a fresh id and IV for every call', () => {
    const a = buildAuditRecord(input);
    const b = buildAuditRecord(input);
    expect(a.id).not.toBe(b.id);
    expect(a.originalMessage.iv).not.toBe(b.originalMessage.iv);
    expect(a.originalMessage.ciphertext).not.toBe(b.originalMessage.ciphertext);
  });

  it('never leaves the original (or its PII) anywhere in the record JSON', () => {
    const json = JSON.stringify(buildAuditRecord(input));
    for (const needle of [original, 'juan.perez@example.com', '4111 1111 1111 1111', '4111']) {
      expect(json).not.toContain(needle);
    }
  });

  it('honours injected newId and now, and copies redactions', () => {
    const redactions = { EMAIL: 0, CREDIT_CARD: 0, SSN: 0 };
    const rec = buildAuditRecord({
      ...input,
      redactions,
      newId: () => 'fixed-id',
      now: () => new Date('2026-01-02T03:04:05.678Z'),
    });
    expect(rec.id).toBe('fixed-id');
    expect(rec.timestamp).toBe('2026-01-02T03:04:05.678Z');
    expect(rec.redactions).not.toBe(redactions);
    expect(cipher.decrypt(rec.originalMessage, auditAad('fixed-id', 'user-1'))).toBe(original);
  });
});
