import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  InvalidKeyError,
  auditAad,
  createAuditCipher,
  parseEncryptionKey,
  type EncryptedField,
} from '../../../src/audit/crypto.js';

const key = randomBytes(32);
const aad = auditAad('rec-1', 'user-1');
const mk = () => createAuditCipher(key, 'k1');

describe('AES-256-GCM cipher', () => {
  it('round-trips ASCII, Unicode and emoji', () => {
    const c = mk();
    for (const text of ['', 'hello', 'josé 用户 שלום', 'card 💳 4111 1111 1111 1111 👨‍👩‍👧', 'x'.repeat(100_000)]) {
      expect(c.decrypt(c.encrypt(text, aad), aad)).toBe(text);
    }
  });

  it('has the documented shape: 12-byte IV, 16-byte tag, keyId', () => {
    const f = mk().encrypt('secret', aad);
    expect(f.alg).toBe('AES-256-GCM');
    expect(f.keyId).toBe('k1');
    expect(Buffer.from(f.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(f.tag, 'base64')).toHaveLength(16);
    expect(f.ciphertext).not.toContain('secret');
  });

  it('uses a unique IV and ciphertext per call', () => {
    const c = mk();
    const ivs = new Set<string>();
    const cts = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const f = c.encrypt('same plaintext', aad);
      ivs.add(f.iv);
      cts.add(f.ciphertext);
    }
    expect(ivs.size).toBe(5000);
    expect(cts.size).toBe(5000);
  });

  const flip = (b64: string): string => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] = (buf[0] ?? 0) ^ 1;
    return buf.toString('base64');
  };

  it('detects tampering with ciphertext, tag and iv', () => {
    const c = mk();
    const f = c.encrypt('secret message', aad);
    expect(() => c.decrypt({ ...f, ciphertext: flip(f.ciphertext) }, aad)).toThrow();
    expect(() => c.decrypt({ ...f, tag: flip(f.tag) }, aad)).toThrow();
    expect(() => c.decrypt({ ...f, iv: flip(f.iv) }, aad)).toThrow();
  });

  it('rejects wrong AAD (ciphertext moved to another record/user) and wrong key', () => {
    const c = mk();
    const f = c.encrypt('secret message', aad);
    expect(() => c.decrypt(f, auditAad('rec-2', 'user-1'))).toThrow();
    expect(() => c.decrypt(f, auditAad('rec-1', 'user-2'))).toThrow();
    expect(() => createAuditCipher(randomBytes(32), 'k1').decrypt(f, aad)).toThrow();
  });

  it('rejects malformed fields without leaking anything', () => {
    const c = mk();
    const f = c.encrypt('secret message', aad);
    const bad: EncryptedField[] = [
      { ...f, iv: Buffer.alloc(8).toString('base64') },
      { ...f, tag: Buffer.alloc(4).toString('base64') },
      { ...f, alg: 'AES-128-CBC' as never },
    ];
    for (const b of bad) expect(() => c.decrypt(b, aad)).toThrow('Malformed encrypted field');
    try {
      c.decrypt({ ...f, ciphertext: flip(f.ciphertext) }, aad);
    } catch (e) {
      expect(String(e)).not.toContain('secret message');
      expect(String(e)).not.toContain(key.toString('base64'));
    }
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => createAuditCipher(randomBytes(16), 'k')).toThrow(InvalidKeyError);
  });

  it('keeps a private copy of the key', () => {
    const k = randomBytes(32);
    const c = createAuditCipher(k, 'k1');
    const f = c.encrypt('x', aad);
    k.fill(0);
    expect(c.decrypt(f, aad)).toBe('x');
  });

  it('hides the key from JSON.stringify, util.inspect, String and Object.keys', () => {
    const c = mk();
    const needles = [key.toString('base64'), key.toString('hex'), key.toString('base64url')];
    const dumps = [
      JSON.stringify(c),
      inspect(c, { depth: 10, showHidden: true }),
      JSON.stringify({ wrapped: c }),
      inspect({ wrapped: c }, { depth: 10 }),
      `${String(Object.keys(c))}`,
    ];
    for (const d of dumps) for (const n of needles) expect(d).not.toContain(n);
    expect(JSON.stringify(c)).toBe('"[AuditCipher]"');
    expect(inspect(c)).toBe('[AuditCipher]');
  });
});

describe('parseEncryptionKey', () => {
  const raw = randomBytes(32);
  it('accepts base64, base64url (padded or not) and hex, trimmed', () => {
    expect(parseEncryptionKey(raw.toString('base64')).equals(raw)).toBe(true);
    expect(parseEncryptionKey(`  ${raw.toString('base64')}\n`).equals(raw)).toBe(true);
    expect(parseEncryptionKey(raw.toString('base64url')).equals(raw)).toBe(true);
    expect(parseEncryptionKey(`${raw.toString('base64url')}=`).equals(raw)).toBe(true);
    expect(parseEncryptionKey(raw.toString('hex')).equals(raw)).toBe(true);
    expect(parseEncryptionKey(raw.toString('hex').toUpperCase()).equals(raw)).toBe(true);
  });

  it('accepts url-safe characters in both alphabets', () => {
    // find a key whose base64 contains '+' or '/' so both spellings are exercised
    let k = randomBytes(32);
    while (!/[+/]/.test(k.toString('base64'))) k = randomBytes(32);
    expect(parseEncryptionKey(k.toString('base64')).equals(k)).toBe(true);
    expect(parseEncryptionKey(k.toString('base64url')).equals(k)).toBe(true);
  });

  const secretish = 'S3cr3tValue-that-must-not-leak';
  const rejected: [string, string | undefined][] = [
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   \n'],
    ['short base64', randomBytes(16).toString('base64')],
    ['long base64', randomBytes(48).toString('base64')],
    ['short hex', randomBytes(31).toString('hex')],
    ['long hex', randomBytes(33).toString('hex')],
    ['not encoded', secretish],
    ['hex with bad char', `${'a1'.repeat(31)}zz`],
    ['mixed alphabets', `${'A'.repeat(20)}+${'B'.repeat(10)}_${'C'.repeat(11)}=`],
    ['non-canonical trailing bits', `${'Q'.repeat(42)}B=`],
    ['all-zero bytes', Buffer.alloc(32).toString('base64')],
    ['all-same hex', 'ab'.repeat(32)],
    ['all-0xff base64url', Buffer.alloc(32, 0xff).toString('base64url')],
  ];
  it.each(rejected)('rejects %s with InvalidKeyError and never echoes input', (_n, input) => {
    let err: unknown;
    try {
      parseEncryptionKey(input);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidKeyError);
    const msg = (err as Error).message;
    if (input !== undefined && input.trim() !== '') expect(msg).not.toContain(input.trim());
    expect(msg).not.toContain(secretish);
  });
});

describe('auditAad', () => {
  it('is unambiguous for different (id, user) splits', () => {
    expect(auditAad('a', 'bc')).not.toBe(auditAad('ab', 'c'));
  });
});
