#!/usr/bin/env node
// Mutation check for the PII sanitizer.
//
// Copies src/sanitizer + tests/unit/sanitizer into a fresh temp dir, applies ONE deliberate breakage
// at a time to the copy, runs the sanitizer tests on it and reports killed/survived. The real tree
// is never modified. Exit code 1 if the unmutated copy fails or any mutant survives.
//
//   node scripts/mutation-check.mjs            (inside the dev container: dx 'node scripts/mutation-check.mjs')
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each mutant: a name, what it breaks, and [file, exact text, replacement] edits (text must occur once). */
const mutants = [
  {
    name: 'luhn-always-true',
    why: 'Luhn check removed: any 13-19 digit run becomes a card',
    edits: [['src/sanitizer/digits.ts', '(total % 2 === 0 ? evenDoubled : oddDoubled) % 10 === 0', 'true']],
  },
  {
    name: 'luhn-parity-flipped',
    why: 'wrong digits doubled in the Luhn sum',
    edits: [['src/sanitizer/digits.ts', '(total % 2 === 0 ? evenDoubled : oddDoubled) % 10 === 0', '(total % 2 === 0 ? oddDoubled : evenDoubled) % 10 === 0']],
  },
  {
    name: 'email-plus-removed',
    why: '`+` dropped from the local-part class (plus tags)',
    edits: [
      ['src/sanitizer/email.ts', '._%+-]$/u', '._%-]$/u'],
      ['src/sanitizer/email.ts', 'c === 43 || // +', 'false ||'],
    ],
  },
  {
    name: 'ssn-longer-number-guard-removed',
    why: 'a 10+ digit run is accepted as an SSN (">= 9" instead of "=== 9")',
    edits: [['src/sanitizer/digits.ts', 'if (count === 1) return runLength(chain, first) === 9;', 'if (count === 1) return runLength(chain, first) >= 9;']],
  },
  {
    name: 'ssn-separator-change-ignored',
    why: 'an SSN after another number joined by a different separator would leak',
    edits: [['src/sanitizer/digits.ts', 'claimSeparatedSsns(text, chain, i, j, claim);', 'void claimSeparatedSsns;']],
  },
  {
    name: 'ssn-same-separator-guard-removed',
    why: 'a window inside a longer same-separator number would be redacted as SSN',
    edits: [['src/sanitizer/digits.ts', '!joinedBefore && !joinedAfter && isSsnShape', 'isSsnShape']],
  },
  {
    name: 'card-swallows-following-ssn',
    why: 'longest Luhn window wins even when it cuts an SSN that follows a shorter valid card',
    edits: [['src/sanitizer/digits.ts', 'if (ssnShapeAt(chain, end + 1) !== -1) return end;', 'if (false) return end;']],
  },
  {
    name: 'ssn-word-guard-removed',
    why: 'SSN inside an alphanumeric token is redacted',
    edits: [['src/sanitizer/digits.ts', 'return leftWord || rightWord;', 'return false;']],
  },
  {
    name: 'ssn-mixed-separators-accepted',
    why: 'consistent-separator rule dropped',
    edits: [['src/sanitizer/digits.ts', 'chain.seps[first] === chain.seps[first + 1]', 'true']],
  },
  {
    name: 'order-numbers-scanned-inside-emails',
    why: 'detection order broken: digits in an e-mail address are also scanned as SSN/card',
    edits: [['src/sanitizer/index.ts', 'findNumberSpans(text, cursor, email.start)', 'findNumberSpans(text, cursor, email.end)']],
  },
  {
    name: 'order-card-before-ssn-lost',
    why: 'an SSN followed by a card gets swallowed by the card window',
    edits: [['src/sanitizer/digits.ts', 'bestCardEnd(text, chain, ssnLast + 1) !== -1', 'false']],
  },
  {
    name: 'zero-width-strip-removed',
    why: 'format characters (zero-width space/joiner, BOM, ...) are no longer stripped',
    edits: [['src/sanitizer/normalize.ts', 'if (FORMAT_CHAR.test(ch)) skip = true;', 'if (FORMAT_CHAR.test(ch) && false) skip = true;']],
  },
  {
    name: 'mark-strip-after-digit-removed',
    why: 'combining marks / keycaps after digits no longer stripped',
    edits: [['src/sanitizer/normalize.ts', 'else if (prevDigit && MARK_CHAR.test(ch)) skip = true;', 'else if (false && MARK_CHAR.test(ch)) skip = true;']],
  },
  {
    name: 'nfkc-removed',
    why: 'no Unicode normalisation (fullwidth digits/@ evade detection)',
    edits: [['src/sanitizer/normalize.ts', "input.normalize('NFKC')", 'input']],
  },
  {
    name: 'separator-class-narrowed-dash',
    why: 'hyphen no longer a separator',
    edits: [['src/sanitizer/digits.ts', 'if (c === 45) return DASH;', '']],
  },
  {
    name: 'separator-class-narrowed-unicode-space',
    why: 'NBSP / Unicode spaces no longer separators (after NFKC only exotic ones remain)',
    edits: [['src/sanitizer/digits.ts', 'if (UNICODE_SPACE.test(ch)) return SPACE;', ''], ['src/sanitizer/digits.ts', 'const UNICODE_DASH = /^[\\p{Pd}\\u2212]$/u;', 'const UNICODE_DASH = /^-$/u;']],
  },
  {
    name: 'card-max-length-unbounded',
    why: 'quantifier/limit made unbounded: 20+ digit runs treated as card candidates',
    edits: [['src/sanitizer/digits.ts', 'const MAX_CARD = 19;', 'const MAX_CARD = 1000;']],
  },
  {
    name: 'card-min-length-lowered',
    why: '12-digit runs may be cards',
    edits: [['src/sanitizer/digits.ts', 'const MIN_CARD = 13;', 'const MIN_CARD = 12;']],
  },
  {
    name: 'tld-min-length-lowered',
    why: 'one-letter TLD accepted (a@b.c)',
    edits: [['src/sanitizer/email.ts', '/^\\p{L}[\\p{L}\\p{M}][\\p{L}\\p{M}\\p{N}-]*$/u', '/^\\p{L}[\\p{L}\\p{M}]?[\\p{L}\\p{M}\\p{N}-]*$/u']],
  },
  {
    name: 'email-merge-removed',
    why: 'overlapping chained addresses no longer merged (leaves "@d.com")',
    edits: [['src/sanitizer/email.ts', 'start = prev.start;', 'void prev;']],
  },
];

function run(dir) {
  const r = spawnSync(
    process.execPath,
    [join(dir, 'node_modules/vitest/vitest.mjs'), 'run', '--root', dir, '--config', join(dir, 'vitest.config.mjs'), '--bail', '1'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } },
  );
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const tmp = mkdtempSync(join(tmpdir(), 'sanitizer-mutation-'));
try {
  const nm = existsSync(join(repo, 'node_modules')) ? join(repo, 'node_modules') : '/work/node_modules';
  symlinkSync(nm, join(tmp, 'node_modules'), 'dir');
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'mutation-copy', type: 'module', private: true }));
  writeFileSync(
    join(tmp, 'vitest.config.mjs'),
    "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { environment: 'node', include: ['tests/unit/sanitizer/**/*.test.ts'] } });\n",
  );
  cpSync(join(repo, 'src/sanitizer'), join(tmp, 'src/sanitizer'), { recursive: true });
  cpSync(join(repo, 'tests/unit/sanitizer'), join(tmp, 'tests/unit/sanitizer'), { recursive: true });

  const pristine = new Map();
  for (const m of mutants) for (const [f] of m.edits) if (!pristine.has(f)) pristine.set(f, readFileSync(join(repo, f), 'utf8'));
  const restore = () => { for (const [f, text] of pristine) writeFileSync(join(tmp, f), text); };

  console.log(`mutation copy: ${tmp}`);
  const base = run(tmp);
  console.log(`baseline (unmutated copy): ${base.code === 0 ? 'PASS' : 'FAIL'}`);
  if (base.code !== 0) {
    console.log(base.out.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } else {
    const rows = [];
    for (const m of mutants) {
      restore();
      for (const [file, from, to] of m.edits) {
        const src = pristine.get(file);
        const count = src.split(from).length - 1;
        if (count !== 1) throw new Error(`mutant ${m.name}: expected exactly one occurrence of ${JSON.stringify(from)} in ${file}, found ${count}`);
        writeFileSync(join(tmp, file), readFileSync(join(tmp, file), 'utf8').replace(from, () => to));
      }
      const r = run(tmp);
      const failing = r.out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('FAIL') || l.startsWith('×')) ?? '';
      rows.push({ name: m.name, killed: r.code !== 0, by: failing.slice(0, 70), why: m.why });
    }
    restore();
    const w = Math.max(...rows.map((r) => r.name.length));
    console.log(`\n${'mutant'.padEnd(w)}  result    first failing test`);
    for (const r of rows) console.log(`${r.name.padEnd(w)}  ${(r.killed ? 'killed' : 'SURVIVED').padEnd(8)}  ${r.by}`);
    const survived = rows.filter((r) => !r.killed);
    console.log(`\n${rows.length - survived.length}/${rows.length} mutants killed`);
    if (survived.length > 0) {
      console.log(`SURVIVORS: ${survived.map((s) => s.name).join(', ')}`);
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
