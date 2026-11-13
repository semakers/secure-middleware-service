// OWNER: core agent. Operator tool for the encrypted audit log (CONTRACT.md §7).
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { auditAad, createAuditCipher, parseEncryptionKey, type AuditCipher } from '../audit/crypto.js';
import { parseAuditFile, type AuditRecord } from '../audit/store.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  'Usage: audit <command>',
  '  verify              decrypt every record and report integrity (never prints plaintext)',
  '  decrypt <recordId>  print the original message of one record (operator use only)',
  '',
  'Environment: AUDIT_ENCRYPTION_KEY (required), AUDIT_LOG_PATH (default data/audit-log.json),',
  '             AUDIT_KEY_ID (default k1)',
].join('\n');

function tryDecrypt(cipher: AuditCipher, record: AuditRecord): string | undefined {
  try {
    return cipher.decrypt(record.originalMessage, auditAad(record.id, record.userId));
  } catch {
    return undefined;
  }
}

async function loadRecords(path: string): Promise<AuditRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Cannot read the audit log at ${path}`);
  }
  return parseAuditFile(text);
}

/** Returns the process exit code: 0 ok, 1 failure, 2 bad usage. */
export async function runAuditCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  const validVerify = command === 'verify' && rest.length === 0;
  const validDecrypt = command === 'decrypt' && rest.length === 1 && rest[0] !== '';
  if (!validVerify && !validDecrypt) {
    io.err(USAGE);
    return 2;
  }
  try {
    const key = parseEncryptionKey(env['AUDIT_ENCRYPTION_KEY']);
    const cipher = createAuditCipher(key, env['AUDIT_KEY_ID'] ?? 'k1');
    const records = await loadRecords(env['AUDIT_LOG_PATH'] ?? 'data/audit-log.json');

    if (validDecrypt) {
      const record = records.find((r) => r.id === rest[0]);
      if (record === undefined) {
        io.err('Record not found');
        return 1;
      }
      const plain = tryDecrypt(cipher, record);
      if (plain === undefined) {
        io.err('Record could not be decrypted (wrong key or tampered record)');
        return 1;
      }
      io.out(plain);
      return 0;
    }

    const failed = records.filter((r) => tryDecrypt(cipher, r) === undefined).map((r) => r.id);
    const okCount = records.length - failed.length;
    io.out(`verified ${String(okCount)}/${String(records.length)} records`);
    if (failed.length > 0) {
      io.err(`FAILED records: ${failed.join(', ')}`);
      return 1;
    }
    return 0;
  } catch (error) {
    // Errors raised above never carry key or message material.
    io.err(error instanceof Error ? error.message : 'Unexpected error');
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runAuditCli(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
