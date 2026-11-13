# Shared contract (as given to the agents)

> This is the coordination contract the main agent wrote **before** launching the three worker
> agents (sanitizer, core, api). It is kept verbatim as a record of the process; host paths refer to
> the development machine. See PROMPT_LOG.md for how it was used.


Main agent coordinates. Three worker agents run in parallel: **sanitizer**, **core**, **api**.
Read this whole file before writing code. If something here is ambiguous, ask `main`; do not guess
in a way that changes another agent's interface.

## 0. Where things are

| What | Host path (Read/Edit/Write tools) | Inside the dev container |
|---|---|---|
| Git repo (Node 24 + Express 5 + TypeScript 6, ESM) | `/srv/devenvs/@securemw/secure-middleware-service` | `/work` |
| Coordination (this file, locks, status, inbox) | `/srv/devenvs/@securemw/coordination` | `/coordination` |

- **Every npm / npx / node / vitest / tsc / eslint / git command runs INSIDE the dev container
  `securemw-dev`**, never on the host. Helper (runs `bash -lc` in `/work`):
  `/srv/devenvs/@securemw/coordination/bin/dx '<command>'`
  e.g. `/srv/devenvs/@securemw/coordination/bin/dx 'npx vitest run tests/unit/sanitizer'`
- Editing files with Read/Edit/Write on the host path is fine (bind mount, same files).
- Docker = **rootless Docker** on the host (`docker` CLI on PATH; NOT Podman). Only use the compose
  project of this repo. **Never touch, stop or remove other containers/images/volumes**
  (`pagebuilder-dev`, `dpr-*`, Podman ones…).
- Host ports **3000 and 3001 belong to other services**. This project publishes ONLY on
  `127.0.0.1`: `API_PORT` default **4380** (production-mode `api`), `DEMO_PORT` default **4381**
  (`api-demo`). In-process tests listen on `127.0.0.1:0` (ephemeral) — create the server with
  `http.createServer(app).listen(0, '127.0.0.1')` and give supertest the server, not the app
  (supertest(app) would bind all interfaces).
- Installed: express 5.3, zod 4.6, pino 10.4, helmet 8.3; dev: typescript 6.0, vitest 5.1 +
  @vitest/coverage-v8, supertest 7.3, tsx, eslint 10 + typescript-eslint + eslint-plugin-regexp.
  ESM (`"type": "module"`), `moduleResolution: NodeNext` → **relative imports end in `.js`**.
  `verbatimModuleSyntax` → use `import type` for types. `noUncheckedIndexedAccess` is on.
- Kernel uses 16K pages (Asahi). Report anything odd instead of fighting it for long.

## 1. File ownership (do NOT edit files you don't own — ask main)

| Owner | Files |
|---|---|
| main | `package.json`*, `package-lock.json`*, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.env.example`, `README.md`, `PROMPT_LOG.md`, `docker/dev.Dockerfile`, `docs/videos/**`, `scripts/demo*` |
| sanitizer | `src/sanitizer/**`, `tests/unit/sanitizer/**`, `docs/AI_SANITIZER.md`, `scripts/mutation-check.*` |
| core | `src/ai/**`, `src/audit/**`, `src/cli/**`, `tests/unit/ai/**`, `tests/unit/audit/**`, `tests/unit/cli/**`, then (phase 2) `Dockerfile`, `.dockerignore`, `docker-compose.yml` |
| api | `src/config.ts`, `src/errors.ts`, `src/logger.ts`, `src/app.ts`, `src/bootstrap.ts`, `src/server.ts`, `src/http/**`, `src/inquiry/**`, `tests/unit/http/**`, `tests/unit/config/**`, `tests/integration/**` |

\* Need a dependency or a script? SendMessage `main` with the exact `npm` command. Trivial and
urgent: do it yourself ONLY under the `npm` lock (§9) and tell main.

The exported signatures in the stub files I wrote (`src/sanitizer/index.ts`, `src/ai/*.ts`,
`src/audit/*.ts`) are the contract: implement them, you may ADD exports, never rename/remove or
change a signature without main's OK (other agents code against them right now).

## 2. HTTP API (owner: api)

### `POST /secure-inquiry`
- Content-Type must be `application/json` (charset, if present, utf-8) → else **415**.
  `Content-Encoding` other than identity → **415** (`express.json({ inflate: false })`: no zip bombs).
- Body limit `MAX_BODY_BYTES` (default 32768) → **413**.
- Body must be a JSON **object** with exactly these keys (zod `strictObject`; unknown keys → 400):
  - `userId`: string, `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (1–64 chars), and `containsPii(userId)`
    must be false (a numeric id that is a valid card or 9-digit SSN is rejected: issue `contains_pii`).
  - `message`: string; well-formed Unicode (`String.prototype.isWellFormed`, no lone surrogates) →
    issue `invalid_unicode`; no control chars except `\t \n \r` (U+0000–U+001F, U+007F) →
    `invalid_characters`; 1–5000 **code points** (`[...s].length`) → `too_short`/`too_long`;
    not whitespace-only → `blank`.
- Flow (in `src/inquiry/service.ts`):
  1. validate → 2. `sanitize(message)` → 3. `breaker.execute(() => generateWithTimeout(ai, sanitized, AI_TIMEOUT_MS))`
     — **the AI only ever sees the sanitized text** → 4. `buildAuditRecord(...)` + `store.append(record)`
     for EVERY valid inquiry (outcomes `answered | ai_error | ai_timeout | circuit_open`); if the
     append fails → **500 AUDIT_WRITE_FAILED** (fail closed: no unaudited answers) → 5. respond.
- **200** body (exact keys):
  ```json
  { "requestId": "uuid", "auditId": "uuid", "answer": "Generated Answer",
    "sanitizedMessage": "Mail <REDACTED: EMAIL> …", "redactions": { "EMAIL": 1, "CREDIT_CARD": 0, "SSN": 0 } }
  ```

### Error envelope (every non-2xx, every route)
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request body failed validation.", "requestId": "uuid",
             "details": [ { "field": "message", "issue": "too_long" } ] } }
```
- `message` is a **fixed string per code** — never interpolate input, zod messages or `err.message`.
- `details` only for `VALIDATION_ERROR`; `field` ∈ `userId | message | mode | (root)` — never a
  client-supplied key name (a key can itself be PII). Issues: `required, invalid_type, too_short,
  too_long, blank, invalid_format, contains_pii, invalid_unicode, invalid_characters,
  unrecognized_keys, invalid_value, not_an_object`.
- `retryAfterSeconds` (integer ≥ 1) only for `SERVICE_BUSY`.

| Status | code | message |
|---|---|---|
| 400 | `INVALID_JSON` | `Request body is not valid JSON.` |
| 400 | `VALIDATION_ERROR` | `Request body failed validation.` |
| 401 | `UNAUTHORIZED` | `Missing or invalid credentials.` (+ `WWW-Authenticate: Bearer`) |
| 404 | `NOT_FOUND` | `Route not found.` |
| 405 | `METHOD_NOT_ALLOWED` | `Method not allowed.` (+ `Allow` header) |
| 413 | `PAYLOAD_TOO_LARGE` | `Request body is too large.` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type must be application/json.` |
| 500 | `AUDIT_WRITE_FAILED` | `The request could not be recorded.` |
| 500 | `INTERNAL_ERROR` | `Internal server error.` |
| 502 | `AI_UPSTREAM_ERROR` | `The AI service failed to answer.` |
| 503 | `SERVICE_BUSY` | `Service Busy` (+ `Retry-After: <seconds>` header, ceil, min 1) |
| 504 | `AI_TIMEOUT` | `The AI service timed out.` |

Every response: `X-Request-Id` (server-generated UUID; client-supplied ids are ignored),
`Cache-Control: no-store`, helmet headers, no `X-Powered-By`, JSON `charset=utf-8`.

### `GET /health` → 200 `{ "status": "ok", "circuit": "closed" | "open" | "half_open" }` (Docker healthcheck).

### Demo control (test/demo only)
Registered ONLY when `DEMO_CONTROL_ENABLED=true` AND `NODE_ENV !== 'production'`. When not
registered, these paths are plain 404 `NOT_FOUND` (indistinguishable from any unknown route).
`NODE_ENV=production` + `DEMO_CONTROL_ENABLED=true` → **config error, the process refuses to start**.
Auth: `Authorization: Bearer <DEMO_CONTROL_TOKEN>` (≥ 24 chars), constant-time compare
(`timingSafeEqual` on SHA-256 digests); missing/wrong → 401 `UNAUTHORIZED`.
- `GET /__demo/ai-mock` → 200 `{ "mode": "healthy", "latencyMs": 2000, "timeoutMs": 5000, "circuit": CircuitSnapshot }`
- `PUT /__demo/ai-mock` body `{ "mode": "healthy" | "fail" | "hang" }` (same JSON/415/strict rules) → 200 same shape.
It only switches the mock's mode. It cannot reset the breaker: the breaker recovers through its
own half-open logic (that is what the demo shows).

## 3. Configuration (owner: api, `src/config.ts`, zod over `process.env`; fail fast, never echo values)

| Env | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` disables the demo control |
| `HOST` | `127.0.0.1` | the Docker image sets `0.0.0.0` (container netns; compose publishes on 127.0.0.1 only) |
| `PORT` | `4380` | the Docker image sets `8080` |
| `LOG_LEVEL` | `info` | pino level; `silent` allowed |
| `MAX_BODY_BYTES` | `32768` | |
| `AUDIT_ENCRYPTION_KEY` | — **required** | `parseEncryptionKey()`; errors never contain the value |
| `AUDIT_KEY_ID` | `k1` | `^[A-Za-z0-9_-]{1,32}$` |
| `AUDIT_LOG_PATH` | `data/audit-log.json` | image: `/app/data/audit-log.json` |
| `AI_MOCK_LATENCY_MS` | `2000` | the 2 s setTimeout |
| `AI_MOCK_MODE` | `healthy` | `healthy | fail | hang` — **the only failure injection besides the demo control** |
| `AI_TIMEOUT_MS` | `5000` | deadline per AI call (counts as a breaker failure) |
| `CIRCUIT_FAILURE_THRESHOLD` | `3` | consecutive failures to open |
| `CIRCUIT_COOLDOWN_MS` | `15000` | open → half-open |
| `DEMO_CONTROL_ENABLED` | `false` | `true`/`false` only |
| `DEMO_CONTROL_TOKEN` | — | required (≥ 24 chars) when the control is enabled |

The parsed config object must not carry the raw key string (hold the `Buffer`/cipher only), and
`JSON.stringify`/`util.inspect` of config must not reveal the key or the demo token.
**No failure mode can be selected through the request body, query or headers** of `/secure-inquiry`.

## 4. Logging & PII (owner: api, `src/logger.ts`)
- pino JSON logs to stdout; one line per request: `requestId, method, route` (matched route
  pattern or `"(unmatched)"` — **never the raw URL/path/query**), `status, durationMs, outcome?,
  redactions?`. Circuit transitions are logged (`from`, `to`).
- **Never log** bodies, headers, query strings, zod issue messages, or `err.message` of body-parser
  errors (Node's JSON `SyntaxError` message quotes the raw body!). Unexpected errors: log `err.name`
  and a stack whose text went through `sanitize()`.
- Safety net: the logger runs `sanitize()` over every string it emits (pino `formatters.log` +
  `hooks.logMethod`), so even a mistake upstream cannot print raw PII.
- `createLogger({ level, destination? })` — `destination` injectable so tests capture the output and
  assert no PII string from any test request ever appears in it.

## 5. Sanitizer (owner: sanitizer) — `sanitize(input): { sanitized, redactions }`, `containsPii`, `redactionToken`
Spec (also the prompt the sanitizer is generated from — record it verbatim in `docs/AI_SANITIZER.md`):
- Replace each match with `<REDACTED: EMAIL>`, `<REDACTED: CREDIT_CARD>`, `<REDACTED: SSN>`;
  `redactions` counts per type (all 3 keys always present). The replacement text must not itself be
  re-detected; running `sanitize` twice is idempotent.
- **EMAIL**: local part with `.` `_` `%` `+` `-` (plus tags `a+tag@x.io`), subdomains
  (`a@mail.eu.example.co.uk`), TLD ≥ 2 letters; reasonable Unicode/IDN support (e.g. `josé@ejemplo.es`,
  `用户@例子.中国`); trailing sentence punctuation is not part of the match; obviously not emails
  (`a@b`, `@x.com`, `user@`) are not redacted.
- **CREDIT_CARD**: 13–19 digits, optionally grouped with single separators (space, `-`, `.`),
  **Luhn-valid**. A Luhn-invalid digit run is not a card. A card is always redacted whole — **never
  partly redacted as an SSN**.
- **SSN**: exactly 9 digits — `AAA-GG-SSSS` with a consistent separator (space, `-`, `.`) or 9
  contiguous digits — that are **not part of a longer number** (a 10+ digit run, a longer
  separated group sequence, a decimal like `123456789.5`, or a digit run inside an alphanumeric token).
- Order of detection must make overlaps safe (e.g. `123456789@x.com` is one EMAIL, not SSN + junk).
- **Unicode**: the input may contain emoji, RTL text, combining marks, NBSP/other Unicode spaces,
  fullwidth digits (`４１１１…`) and zero-width characters inserted to evade detection
  (`4111​1111…`). Detection must not be defeated by them (normalise a working copy — e.g. NFKC +
  strip `\p{Cf}` inside candidates — and document what the sanitized output looks like).
- **Performance / ReDoS**: linear-time. No nested/ambiguous quantifiers (eslint `regexp/no-super-linear-*`
  must pass with no disables). Tests: several **100 KB adversarial inputs** (e.g. `"a".repeat(1e5)`,
  `"a@".repeat(5e4)`, `"1-".repeat(5e4)`, `"1 ".repeat(5e4)`, long dotted domains, a long local
  part without `@`) each finish in **< 250 ms**; also a ~1 MB mixed input works.
- `docs/AI_SANITIZER.md`: the prompt/spec, the generation steps, a table of cases and **why each
  matters**, the ReDoS analysis, the known limitations, and a **mutation check**: a script
  (`scripts/mutation-check.mjs`) that applies ≥ 6 deliberate breakages (drop Luhn, drop `+` from the
  local part, drop the SSN longer-number guard, swap detection order, drop the zero-width strip,
  …) to a COPY of the sanitizer in a temp dir (never mutate files in `/work`), runs the sanitizer
  tests against each mutant and reports that every mutant is killed. Put the real output in the doc.

## 6. Mock AI + circuit breaker (owner: core) — see stubs `src/ai/mockAiClient.ts`, `src/ai/circuitBreaker.ts`
- `MockAiClient({ latencyMs, mode })`: `generate()` uses **one `setTimeout(latencyMs)`**; `healthy` →
  resolves `{ answer: "Generated Answer" }`; `fail` → rejects `AiUpstreamError` **after** the latency
  (so failing calls take ~2 s too); `hang` → never settles unless aborted. Honour `signal` (clear the
  timer, reject with an abort error). `setMode()` switches at runtime (demo control).
- `generateWithTimeout(client, prompt, timeoutMs)`: aborts and rejects `AiTimeoutError` at the deadline;
  clears every timer on settle (no dangling timers).
- `CircuitBreaker({ failureThreshold, cooldownMs, now?, onStateChange? })`:
  - closed: calls pass; a failure increments `consecutiveFailures`; a success resets it; reaching the
    threshold → open.
  - open: `execute` throws `CircuitOpenError(retryAfterMs)` **synchronously-fast, without calling fn**.
  - after `cooldownMs` (lazy, via `now()`, no timers): the next call is the ONE trial (`state` getter
    reports `half_open` once the cooldown has elapsed). While the trial is in flight, other calls get
    `CircuitOpenError` (retryAfterMs ≥ 1000). Trial success → closed (counter 0); trial failure →
    open with a fresh cooldown.
  - every error thrown by fn counts as a failure (the breaker wraps only the AI call).
  - `onStateChange(from, to)` on every transition.
- Unit tests use `vi.useFakeTimers()` for the 2 s latency/timeout and an injected clock for the
  breaker. **Test every transition**, the counter reset, the single half-open trial under
  concurrency, and that fn is never invoked while open.

## 7. Audit log (owner: core) — stubs `src/audit/crypto.ts`, `store.ts`, `record.ts`
- AES-256-GCM, 12-byte `randomBytes` IV per record, 16-byte tag, AAD = `auditAad(recordId, userId)`
  (a ciphertext moved to another record fails to decrypt). Key from `AUDIT_ENCRYPTION_KEY`:
  base64/base64url of exactly 32 bytes or 64 hex chars; reject anything else, an all-same-byte key and
  the empty string. Error messages never include key material; the cipher object hides the key from
  `JSON.stringify`/`util.inspect`.
- `JsonFileAuditStore`: file = `{ "version": 1, "records": [...] }` (2-space JSON), mode `0600`, dir
  `0700`. **Atomic**: write a temp file in the same dir → `fsync` → `rename` → fsync the dir.
  **Concurrency-safe**: appends are serialised in-process (group commit allowed: one rewrite flushes
  every queued record; each `append` resolves only after its record is durable). A failed write
  rejects the affected appends and leaves memory + file consistent. Corrupt/unreadable existing file
  → `AuditStoreCorruptError` at `open()` (never overwrite evidence). Single-writer (one process) —
  document it.
- `buildAuditRecord(...)` → record with `id` (UUID), ISO `timestamp`, plaintext `redactedMessage`,
  encrypted `originalMessage`.
- `src/cli/audit.ts`: `node dist/cli/audit.js verify` (decrypts every record with the env key, prints
  counts, never plaintext) and `decrypt <recordId>` (operator tool, prints that original). Export a
  testable `runAuditCli(argv, env, io)`; the file's bottom-level `if (isMain)` call is the only
  untested line.

## 8. Tests & coverage
- Unit: `tests/unit/<area>/**/*.test.ts`. Integration: `tests/integration/**/*.test.ts`.
- **Integration suite = the same files for two targets** (api writes `tests/integration/support/target.ts`):
  - default: in-process — `await createApp(config, overrides?)` + `http.createServer(app).listen(0,'127.0.0.1')`
    + supertest(server); demo control enabled in the test config, short latency (e.g. 50 ms) and
    cooldown (e.g. 400 ms), temp audit file.
  - `E2E_BASE_URL` set: supertest(E2E_BASE_URL) against the running container (`api-demo`);
    `E2E_DEMO_TOKEN` drives the demo control; timings are read from `GET /__demo/ai-mock`;
    `E2E_AUDIT_LOG_PATH` (the container's volume mounted read-only) + `AUDIT_ENCRYPTION_KEY` let the
    suite inspect and decrypt the audit file; `E2E_PROD_BASE_URL` (the production-mode `api`)
    checks that the demo control is a 404 there. Tests that need in-process access (log capture,
    injected failing store) use `describe.skipIf(target.remote)` — keep those few.
  - Remote = one shared server: tests must leave the circuit **closed** and the mock **healthy**
    (helper `ensureHealthyAndClosed()`).
- Coverage: v8, `src/**` minus `src/server.ts`, thresholds **95 %** lines/branches/functions/statements
  (already in `vitest.config.ts`; `npm run test:coverage` fails below). Your own area should be ≥ 95 %
  on its own. Run coverage with `COVERAGE_DIR=/tmp/coverage-<agent>` so runs don't clash.
- No real 2 s waits in unit tests (fake timers). No sleeps > 1 s in in-process integration tests.

## 9. Shared resources = locks (process semaphore)
`flock` files in `/coordination/locks/` (inside the container; on the host the same files are under
`/srv/devenvs/@securemw/coordination/locks/`). Wrap the WHOLE critical section:

| Lock | Protects | Use for |
|---|---|---|
| `npm` | package.json, package-lock.json, node_modules | `npm install/uninstall`, `npm pkg set` |
| `build` | `dist/` | `npm run build` / `tsc -p tsconfig.build.json` |
| `git` | the git index | `git add` + `git commit` together |
| `compose` | this repo's compose project, images, ports 4380/4381 | `docker compose build/up/down/run` (run on the HOST: `flock /srv/devenvs/@securemw/coordination/locks/compose.lock docker compose …`) |

```
dx 'flock /coordination/locks/git.lock sh -c "git add -- src/ai tests/unit/ai && git commit -q -m \"feat(ai): circuit breaker\" -m \"Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\" -- src/ai tests/unit/ai"'
```
- Commit ONLY your own files with explicit paths. Never `git add -A` / `git add .` / `git commit -a`.
- Conventional commits (`feat(sanitizer): …`, `test(api): …`); the message ends with a blank line +
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. The repo's author identity is already
  configured — don't change git config.
- Never hold a lock while thinking: take, run, release. `vitest`/`tsc --noEmit`/`eslint` need no lock.
- Never write secrets into the repo. Tests generate keys with `randomBytes(32)`; `.env` is git-ignored.

## 10. Status & communication (every ~5 minutes)
- At least every 5 minutes of wall-clock (check `date -u`), at each milestone and when blocked:
  1. Overwrite `/srv/devenvs/@securemw/coordination/status/<agent>.md`: UTC timestamp, `STATE:`
     (WORKING / BLOCKED / DONE), done, doing now, next, blockers, files touched, notes for others.
  2. SendMessage `main` with a 2–4 line summary (first line self-contained).
- Stuck > 10 min on the same problem → SendMessage `main` with `BLOCKED:` + exact error.
- Messages from main arrive automatically; also read `/srv/devenvs/@securemw/coordination/inbox/<agent>.md`
  when you write your status.
- When done: status `STATE: DONE`, list of commits, exact commands to run your tests, coverage of
  your area, and anything you could not do. **Main re-runs your tests and reads your code before
  accepting "done"** — report failures honestly.

## 11. Quality bar
- TypeScript strict, no `any` (use `unknown` + narrowing), no `@ts-ignore`, no eslint-disable for the
  regexp rules. `npx tsc --noEmit` and `npx eslint <your files>` clean.
- Small pure functions, injectable clocks/timers/fs where it helps testing.
- Security first: when in doubt, redact/refuse and document the trade-off.
