import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuditCipher } from '../../../src/audit/crypto.js';
import { buildAuditRecord } from '../../../src/audit/record.js';
import { JsonFileAuditStore, type AuditRecord } from '../../../src/audit/store.js';
import { runAuditCli } from '../../../src/cli/audit.js';

const key = randomBytes(32);
const cipher = createAuditCipher(key, 'k1');
const SECRET = 'ssn 123-45-6789 mail a@b.example';

let dir: string;
let path: string;
let env: Record<string, string | undefined>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cli-'));
  path = join(dir, 'audit-log.json');
  env = { AUDIT_ENCRYPTION_KEY: key.toString('base64'), AUDIT_LOG_PATH: path };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (original = SECRET): AuditRecord =>
  buildAuditRecord({
    requestId: randomUUID(),
    userId: 'u1',
    outcome: 'answered',
    originalMessage: original,
    redactedMessage: 'ssn <REDACTED: SSN> mail <REDACTED: EMAIL>',
    redactions: { EMAIL: 1, CREDIT_CARD: 0, SSN: 1 },
    cipher,
  });

async function run(argv: string[], e = env) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAuditCli(argv, e, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function seed(records: AuditRecord[]): Promise<void> {
  const store = await JsonFileAuditStore.open(path);
  for (const r of records) await store.append(r);
}

describe('audit CLI usage', () => {
  it.each([[[]], [['nope']], [['verify', 'extra']], [['decrypt']], [['decrypt', 'a', 'b']], [['decrypt', '']]])(
    'exit 2 + usage for %j',
    async (argv) => {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain('Usage: audit');
    },
  );
});

describe('audit verify', () => {
  it('verifies all records, never prints plaintext', async () => {
    await seed([rec(), rec('another secret'), rec()]);
    const r = await run(['verify']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('verified 3/3 records');
    expect(r.out + r.err).not.toContain('123-45-6789');
    expect(r.out + r.err).not.toContain('another secret');
  });

  it('an empty store verifies 0/0', async () => {
    await seed([]);
    await mkdir(dir, { recursive: true });
    await writeFile(path, '{"version":1,"records":[]}');
    const r = await run(['verify']);
    expect(r).toMatchObject({ code: 0, out: 'verified 0/0 records' });
  });

  it('exit 1 and lists the failing ids (tampered record, wrong user binding)', async () => {
    const good = rec();
    const tampered = rec();
    const moved = rec();
    await seed([good, tampered, moved]);
    const file = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as {
      records: AuditRecord[];
    };
    const [, t, m] = file.records;
    const buf = Buffer.from((t as AuditRecord).originalMessage.ciphertext, 'base64');
    buf[0] = (buf[0] ?? 0) ^ 1;
    (t as AuditRecord).originalMessage.ciphertext = buf.toString('base64');
    (m as AuditRecord).userId = 'someone-else';
    await writeFile(path, JSON.stringify(file));
    const r = await run(['verify']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('verified 1/3 records');
    expect(r.err).toContain(tampered.id);
    expect(r.err).toContain(moved.id);
    expect(r.err).not.toContain(good.id);
    expect(r.out + r.err).not.toContain('123-45-6789');
  });

  it('wrong key: every record fails', async () => {
    await seed([rec(), rec()]);
    const r = await run(['verify'], { ...env, AUDIT_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
    expect(r.code).toBe(1);
    expect(r.out).toBe('verified 0/2 records');
  });

  it('missing key, bad key: exit 1 without echoing the key', async () => {
    await seed([rec()]);
    const none = await run(['verify'], { AUDIT_LOG_PATH: path });
    expect(none.code).toBe(1);
    expect(none.err).toContain('AUDIT_ENCRYPTION_KEY');
    const bad = await run(['verify'], { ...env, AUDIT_ENCRYPTION_KEY: 'short-secret-value' });
    expect(bad.code).toBe(1);
    expect(bad.err).not.toContain('short-secret-value');
  });

  it('missing or corrupt log file: exit 1', async () => {
    const missing = await run(['verify']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Cannot read the audit log');
    await writeFile(path, 'garbage');
    const corrupt = await run(['verify']);
    expect(corrupt.code).toBe(1);
    expect(corrupt.err).toContain('not valid JSON');
  });

  it('defaults AUDIT_LOG_PATH to data/audit-log.json (relative) and reports a missing file', async () => {
    const r = await run(['verify'], { AUDIT_ENCRYPTION_KEY: key.toString('base64') });
    expect(r.code).toBe(1);
    expect(r.err).toContain('data/audit-log.json');
  });
});

describe('audit decrypt', () => {
  it('prints the original of the requested record', async () => {
    const target = rec('the one I want');
    await seed([rec(), target]);
    const r = await run(['decrypt', target.id]);
    expect(r).toMatchObject({ code: 0, out: 'the one I want', err: '' });
  });

  it('unknown id: exit 1', async () => {
    await seed([rec()]);
    const r = await run(['decrypt', 'nope']);
    expect(r).toMatchObject({ code: 1, err: 'Record not found' });
  });

  it('undecryptable record: exit 1, no plaintext', async () => {
    const target = rec();
    await seed([target]);
    const r = await run(['decrypt', target.id], { ...env, AUDIT_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    expect(r.code).toBe(1);
    expect(r.err).toContain('could not be decrypted');
  });
});
