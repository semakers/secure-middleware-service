import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuditCipher } from '../../../src/audit/crypto.js';
import { buildAuditRecord } from '../../../src/audit/record.js';
import {
  AuditStoreCorruptError,
  JsonFileAuditStore,
  nodeAuditFs,
  type AuditFs,
  type AuditRecord,
} from '../../../src/audit/store.js';

const cipher = createAuditCipher(randomBytes(32), 'k1');
const rec = (n = 0): AuditRecord =>
  buildAuditRecord({
    requestId: randomUUID(),
    userId: `user-${String(n)}`,
    outcome: 'answered',
    originalMessage: `original ${String(n)}`,
    redactedMessage: `redacted ${String(n)}`,
    redactions: { EMAIL: 0, CREDIT_CARD: 0, SSN: 0 },
    cipher,
  });

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'audit-'));
  file = join(dir, 'sub', 'audit-log.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<{ version: number; records: AuditRecord[] }> =>
  JSON.parse(await readFile(file, 'utf8')) as { version: number; records: AuditRecord[] };

function spyFs(over: Partial<AuditFs> = {}): { fs: AuditFs; renames: number } {
  const state = { renames: 0 };
  const fs: AuditFs = {
    ...nodeAuditFs,
    rename: async (a, b) => {
      state.renames++;
      await nodeAuditFs.rename(a, b);
    },
    ...over,
  };
  return {
    fs,
    get renames() {
      return state.renames;
    },
  };
}

describe('JsonFileAuditStore.open', () => {
  it('creates the directory (0700); a missing file is an empty store and is not created yet', async () => {
    const store = await JsonFileAuditStore.open(file);
    expect(await store.readAll()).toEqual([]);
    expect((await stat(join(dir, 'sub'))).mode & 0o777).toBe(0o700);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads an existing valid file', async () => {
    const a = await JsonFileAuditStore.open(file);
    const r = rec();
    await a.append(r);
    const b = await JsonFileAuditStore.open(file);
    expect(await b.readAll()).toEqual([r]);
  });

  it.each([
    ['not JSON', 'not json {'],
    ['empty file', ''],
    ['wrong version', '{"version":2,"records":[]}'],
    ['records not an array', '{"version":1,"records":{}}'],
    ['array root', '[]'],
    ['null root', 'null'],
    ['record missing fields', '{"version":1,"records":[{"id":"x"}]}'],
    ['record not an object', '{"version":1,"records":[1]}'],
  ])('throws AuditStoreCorruptError for %s and never overwrites it', async (_n, content) => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(file, content);
    await expect(JsonFileAuditStore.open(file)).rejects.toBeInstanceOf(AuditStoreCorruptError);
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('treats an unreadable path (EISDIR) as corrupt', async () => {
    await mkdir(file, { recursive: true });
    await expect(JsonFileAuditStore.open(file)).rejects.toBeInstanceOf(AuditStoreCorruptError);
  });

  it('ignores leftover .tmp files', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(`${file}.123.deadbeef.tmp`, '{broken');
    const store = await JsonFileAuditStore.open(file);
    await store.append(rec());
    expect((await read()).records).toHaveLength(1);
  });
});

describe('JsonFileAuditStore.append', () => {
  it('writes version 1, 2-space JSON, mode 0600, and leaves no temp files', async () => {
    const store = await JsonFileAuditStore.open(file);
    await store.append(rec());
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('{\n  "version": 1,\n  "records": [')).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, 'sub'))).toEqual(['audit-log.json']);
  });

  it('200 concurrent appends: valid JSON, 200 unique records, group commit batches', async () => {
    const spy = spyFs();
    const store = await JsonFileAuditStore.open(file, spy.fs);
    await Promise.all(Array.from({ length: 200 }, (_, i) => store.append(rec(i))));
    const data = await read();
    expect(data.version).toBe(1);
    expect(data.records).toHaveLength(200);
    expect(new Set(data.records.map((r) => r.id)).size).toBe(200);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(spy.renames).toBeLessThan(10);
    expect((await store.readAll()).length).toBe(200);
  });

  it('appends made while a write is in flight are flushed together by the next write', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const spy = spyFs({
      writeFileDurable: async (p, d, m) => {
        if (first) {
          first = false;
          await gate;
        }
        await nodeAuditFs.writeFileDurable(p, d, m);
      },
    });
    const store = await JsonFileAuditStore.open(file, spy.fs);
    const p1 = store.append(rec(1));
    await new Promise((r) => setTimeout(r, 10));
    const rest = [2, 3, 4, 5].map((i) => store.append(rec(i)));
    release();
    await Promise.all([p1, ...rest]);
    expect(spy.renames).toBe(2);
    expect((await read()).records).toHaveLength(5);
  });

  it('an append resolves only after its record is durable (in the file)', async () => {
    const store = await JsonFileAuditStore.open(file);
    const r = rec();
    await store.append(r);
    expect((await read()).records.map((x) => x.id)).toEqual([r.id]);
  });

  it('keeps insertion order', async () => {
    const store = await JsonFileAuditStore.open(file);
    const rs = [rec(1), rec(2), rec(3)];
    for (const r of rs) await store.append(r);
    expect((await read()).records.map((x) => x.id)).toEqual(rs.map((r) => r.id));
  });

  it('a failed write rejects the batch, removes the temp file, keeps memory == file, and recovers', async () => {
    let fail = true;
    const spy = spyFs({
      rename: async (a, b) => {
        if (fail) throw new Error('disk full');
        await nodeAuditFs.rename(a, b);
      },
    });
    const store = await JsonFileAuditStore.open(file, spy.fs);
    const ok = rec(0);
    fail = false;
    await store.append(ok);
    fail = true;
    const results = await Promise.allSettled([store.append(rec(1)), store.append(rec(2))]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(await readdir(join(dir, 'sub'))).toEqual(['audit-log.json']);
    expect((await store.readAll()).map((r) => r.id)).toEqual([ok.id]);
    expect((await read()).records.map((r) => r.id)).toEqual([ok.id]);
    fail = false;
    const again = rec(3);
    await store.append(again);
    expect((await store.readAll()).map((r) => r.id)).toEqual([ok.id, again.id]);
    expect((await read()).records.map((r) => r.id)).toEqual([ok.id, again.id]);
  });

  it('a failure while writing the temp file also cleans up and recovers', async () => {
    let fail = true;
    const spy = spyFs({
      writeFileDurable: async (p, d, m) => {
        if (fail) {
          await writeFile(p, 'partial');
          throw new Error('EIO');
        }
        await nodeAuditFs.writeFileDurable(p, d, m);
      },
    });
    const store = await JsonFileAuditStore.open(file, spy.fs);
    await expect(store.append(rec())).rejects.toThrow('EIO');
    expect(await readdir(join(dir, 'sub'))).toEqual([]);
    fail = false;
    await store.append(rec());
    expect((await read()).records).toHaveLength(1);
  });

  it('a failing unlink during cleanup does not mask the original error', async () => {
    const spy = spyFs({
      rename: () => Promise.reject(new Error('rename failed')),
      unlink: () => Promise.reject(new Error('unlink failed')),
    });
    const store = await JsonFileAuditStore.open(file, spy.fs);
    await expect(store.append(rec())).rejects.toThrow('rename failed');
  });

  it('a failing directory fsync rejects the append but memory follows the file', async () => {
    let fail = true;
    const spy = spyFs({
      fsyncDir: async (d) => {
        if (fail) throw new Error('fsync dir failed');
        await nodeAuditFs.fsyncDir(d);
      },
    });
    const store = await JsonFileAuditStore.open(file, spy.fs);
    const r = rec(1);
    await expect(store.append(r)).rejects.toThrow('fsync dir failed');
    expect((await store.readAll()).map((x) => x.id)).toEqual([r.id]);
    expect((await read()).records.map((x) => x.id)).toEqual([r.id]);
    fail = false;
    await store.append(rec(2));
    expect((await read()).records).toHaveLength(2);
  });

  it('copies the record on append and on readAll', async () => {
    const store = await JsonFileAuditStore.open(file);
    const r = rec();
    const id = r.id;
    const pending = store.append(r);
    r.id = 'mutated-after-append';
    await pending;
    const all = await store.readAll();
    expect(all[0]?.id).toBe(id);
    expect(all).not.toBe(await store.readAll());
    (all[0] as AuditRecord).id = 'mutated';
    (all[0] as AuditRecord).redactions.EMAIL = 99;
    const again = await store.readAll();
    expect(again[0]?.id).toBe(id);
    expect(again[0]?.redactions.EMAIL).toBe(0);
  });
});

describe('nodeAuditFs', () => {
  it('writeFileDurable refuses to overwrite an existing temp file (wx)', async () => {
    const p = join(dir, 'x.tmp');
    await nodeAuditFs.writeFileDurable(p, 'a', 0o600);
    await expect(nodeAuditFs.writeFileDurable(p, 'b', 0o600)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(p, 'utf8')).toBe('a');
  });
});
