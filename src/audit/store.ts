// OWNER: core agent. Public API is fixed by the contract (CONTRACT.md §7).
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

/** The few filesystem operations the store needs; injectable so tests can force failures. */
export interface AuditFs {
  mkdir(dir: string, mode: number): Promise<void>;
  /** Resolves with the file content; rejects with an ENOENT error when missing. */
  readFile(path: string): Promise<string>;
  /** Creates `path` exclusively with `mode`, writes `data`, fsyncs and closes. */
  writeFileDurable(path: string, data: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fsyncDir(dir: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const nodeAuditFs: AuditFs = {
  async mkdir(dir, mode) {
    await fs.mkdir(dir, { recursive: true, mode });
  },
  readFile: (path) => fs.readFile(path, 'utf8'),
  async writeFileDurable(path, data, mode) {
    const handle = await fs.open(path, 'wx', mode);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => fs.rename(from, to),
  async fsyncDir(dir) {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  unlink: (path) => fs.unlink(path),
};

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAuditRecord(v: unknown): v is AuditRecord {
  if (!isObject(v)) return false;
  const enc = v['originalMessage'];
  return (
    typeof v['id'] === 'string' &&
    typeof v['requestId'] === 'string' &&
    typeof v['timestamp'] === 'string' &&
    typeof v['userId'] === 'string' &&
    typeof v['outcome'] === 'string' &&
    typeof v['redactedMessage'] === 'string' &&
    isObject(v['redactions']) &&
    isObject(enc) &&
    typeof enc['iv'] === 'string' &&
    typeof enc['tag'] === 'string' &&
    typeof enc['ciphertext'] === 'string'
  );
}

export function parseAuditFile(text: string): AuditRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AuditStoreCorruptError('Audit log file is not valid JSON');
  }
  if (!isObject(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['records'])) {
    throw new AuditStoreCorruptError('Audit log file has an unexpected structure');
  }
  const records: unknown[] = parsed['records'];
  if (!records.every(isAuditRecord)) {
    throw new AuditStoreCorruptError('Audit log file contains an invalid record');
  }
  return records as AuditRecord[];
}

interface Pending {
  record: AuditRecord;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Single-writer (one process) JSON file store. Every flush rewrites the whole file atomically:
 * temp file in the same dir (0600) -> fsync -> rename -> fsync(dir). Appends are serialised
 * in-process with group commit: records queued while a write is in flight are flushed together
 * by the next write, and each append resolves only once its record is durable.
 */
export class JsonFileAuditStore implements AuditStore {
  readonly #path: string;
  readonly #fs: AuditFs;
  #records: AuditRecord[];
  #queue: Pending[] = [];
  #flushing = false;

  private constructor(path: string, fileSystem: AuditFs, records: AuditRecord[]) {
    this.#path = path;
    this.#fs = fileSystem;
    this.#records = records;
  }

  /** Loads (or initialises) the JSON file. Throws AuditStoreCorruptError on an unreadable file. */
  static async open(filePath: string, fileSystem: AuditFs = nodeAuditFs): Promise<JsonFileAuditStore> {
    await fileSystem.mkdir(dirname(filePath), DIR_MODE);
    let text: string;
    try {
      text = await fileSystem.readFile(filePath);
    } catch (err) {
      if (isObject(err) && err['code'] === 'ENOENT') return new JsonFileAuditStore(filePath, fileSystem, []);
      throw new AuditStoreCorruptError('Audit log file cannot be read');
    }
    return new JsonFileAuditStore(filePath, fileSystem, parseAuditFile(text));
  }

  append(record: AuditRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ record: structuredClone(record), resolve, reject });
      if (!this.#flushing) {
        this.#flushing = true;
        void this.#drain();
      }
    });
  }

  readAll(): Promise<AuditRecord[]> {
    return Promise.resolve(structuredClone(this.#records));
  }

  async #drain(): Promise<void> {
    // Let appends issued in the same tick join the first batch.
    await Promise.resolve();
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0);
      const next = [...this.#records, ...batch.map((p) => p.record)];
      try {
        await this.#write(next);
        for (const p of batch) p.resolve();
      } catch (err) {
        for (const p of batch) p.reject(err);
      }
    }
    this.#flushing = false;
  }

  async #write(records: AuditRecord[]): Promise<void> {
    const file: AuditFile = { version: 1, records };
    const data = `${JSON.stringify(file, null, 2)}\n`;
    const tmp = join(dirname(this.#path), `${basename(this.#path)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await this.#fs.writeFileDurable(tmp, data, FILE_MODE);
      await this.#fs.rename(tmp, this.#path);
    } catch (err) {
      await this.#fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
    // The file now holds `next`, so memory follows it even if the directory fsync below fails
    // (the callers are still told, fail closed, that durability is not guaranteed).
    this.#records = records;
    await this.#fs.fsyncDir(dirname(this.#path));
  }
}
