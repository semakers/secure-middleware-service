# Secure Middleware Service

An Express 5 + TypeScript service that sits between users and a (mock) AI model and makes each call safe:

1. **Sanitize**: emails, Luhn-valid credit cards and SSNs in the message become
   `<REDACTED: EMAIL>`, `<REDACTED: CREDIT_CARD>` and `<REDACTED: SSN>`. The AI only ever sees this text.
2. **Call the mock AI** (a 2-second `setTimeout` that answers `"Generated Answer"`) through a
   **circuit breaker**: after 3 failures in a row, every request gets an instant `503 Service Busy`
   with `Retry-After`. After a cool-down, one trial call goes through (half-open). If it succeeds the
   circuit closes; if it fails the circuit opens again.
3. **Audit** every valid inquiry in a JSON file (the mock database): the original message
   **encrypted with AES-256-GCM** (a random IV per record, the key from the environment) and the
   redacted message in plaintext. Writes are atomic and safe under concurrent requests.

Raw PII never appears in logs, errors or responses.

| | |
|---|---|
| 🎬 Video (real commands, asciinema → MP4) | [`docs/videos/secure-middleware-demo.mp4`](docs/videos/secure-middleware-demo.mp4) · raw recording [`secure-middleware-demo.cast`](docs/videos/secure-middleware-demo.cast) · [how it was recorded](#how-the-video-was-recorded) |
| 🧪 How the AI-generated sanitizer was specified and verified | [`docs/AI_SANITIZER.md`](docs/AI_SANITIZER.md) (prompt, case table, ReDoS analysis, mutation check 20/20) |
| 🤖 How this repo was built with AI | [`PROMPT_LOG.md`](PROMPT_LOG.md) |
| 📜 The contract the agents worked against | [`docs/CONTRACT.md`](docs/CONTRACT.md) |

---

## Quick start

Requirements: Docker with Compose v2 (rootless is fine). Node 24 is only needed to run it without Docker.

```bash
cp .env.example .env
# fill in the two secrets (the commands are also in .env.example):
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"     # AUDIT_ENCRYPTION_KEY
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"  # DEMO_CONTROL_TOKEN (demo/test only)

docker compose up -d --wait            # production-mode service on 127.0.0.1:4380

curl -s -X POST 127.0.0.1:4380/secure-inquiry -H 'Content-Type: application/json' \
  -d '{"userId":"user_42","message":"I am jane.doe+billing@mail.example.co.uk, card 4111 1111 1111 1111, SSN 123-45-6789"}'
# {"requestId":"…","auditId":"…","answer":"Generated Answer",
#  "sanitizedMessage":"I am <REDACTED: EMAIL>, card <REDACTED: CREDIT_CARD>, SSN <REDACTED: SSN>",
#  "redactions":{"EMAIL":1,"CREDIT_CARD":1,"SSN":1}}

docker compose exec -T api cat /app/data/audit-log.json        # encrypted original + redacted text
docker compose exec -T api node dist/cli/audit.js verify      # decrypts every record with the key
```

| Command | What it runs |
|---|---|
| `docker compose up -d --wait` | `api`: the production image in production mode (no demo control), port `127.0.0.1:${API_PORT:-4380}` |
| `docker compose --profile demo up -d --wait` | also `api-demo`: the same image, non-production, demo control enabled, 10 s cool-down, port `127.0.0.1:${DEMO_PORT:-4381}` |
| `docker compose --profile test run --rm tests` | the **integration suite against the running containers** (`api-demo` + `api`) |
| `docker compose --profile test run --rm --no-deps -e E2E_BASE_URL= -e E2E_PROD_BASE_URL= tests npm run test:coverage` | unit + in-process integration with the 95 % coverage gate, inside the test image |
| `scripts/demo.sh` | the scripted demo shown in the video (circuit breaker included) |
| `docker compose --profile demo --profile test down` | stop everything (`-v` also deletes the audit volumes) |

Without Docker: `npm ci && npm run build && AUDIT_ENCRYPTION_KEY=… npm start` (listens on
`127.0.0.1:4380`), `npm run dev` for watch mode, `npm run check` for typecheck + lint + tests + coverage.

## API

### `POST /secure-inquiry`

Body: exactly `{ "userId": string, "message": string }`, as `Content-Type: application/json` (UTF-8).

| Rule | Error |
|---|---|
| Content-Type not `application/json`, a non-UTF-8 charset, or any `Content-Encoding` (no decompression, so no zip bombs) | 415 `UNSUPPORTED_MEDIA_TYPE` |
| Body over `MAX_BODY_BYTES` (32 KiB) | 413 `PAYLOAD_TOO_LARGE` |
| Not JSON, or a top-level `null`/string/number | 400 `INVALID_JSON` |
| Not an object, missing field, wrong type, **unknown field** | 400 `VALIDATION_ERROR` |
| `userId`: 1–64 chars `[A-Za-z0-9_-]` starting alphanumeric, and must not itself be PII (a userId that is a card or SSN is rejected) | `VALIDATION_ERROR` |
| `message`: 1–5000 **code points**, not blank, well-formed Unicode (no lone surrogates), no control characters except `\t \n \r` | `VALIDATION_ERROR` |

Success `200`:
```json
{ "requestId": "uuid", "auditId": "uuid", "answer": "Generated Answer",
  "sanitizedMessage": "…<REDACTED: SSN>…", "redactions": { "EMAIL": 0, "CREDIT_CARD": 0, "SSN": 1 } }
```

Every error has the same shape. The `message` is a fixed string per code and never echoes input.
`details` only names our own fields, never a client-supplied key, because a key can itself be PII:
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request body failed validation.", "requestId": "uuid",
             "details": [ { "field": "message", "issue": "too_long" }, { "field": "(root)", "issue": "unrecognized_keys" } ] } }
```

| Status | Code | When |
|---|---|---|
| 502 | `AI_UPSTREAM_ERROR` | the mock AI failed (after its 2 s latency) |
| 503 | `SERVICE_BUSY` (`"message": "Service Busy"`, `retryAfterSeconds`, `Retry-After` header) | circuit open: returned in ~10–20 ms, without calling the AI |
| 504 | `AI_TIMEOUT` | no answer within `AI_TIMEOUT_MS` (counts as a breaker failure) |
| 500 | `AUDIT_WRITE_FAILED` / `INTERNAL_ERROR` | the audit write failed (the answer is withheld: fail closed) / anything unexpected |
| 404 / 405 | `NOT_FOUND` / `METHOD_NOT_ALLOWED` (+ `Allow`) | |

Every response carries a server-generated `X-Request-Id`, `Cache-Control: no-store` and helmet's
headers, and no `X-Powered-By` or ETag.

### `GET /health`
`{"status":"ok","circuit":"closed"|"open"|"half_open"}`. The Docker healthcheck uses it.

### Demo control (`GET|PUT /__demo/ai-mock`, non-production only)
`PUT {"mode":"healthy"|"fail"|"hang"}` switches the mock at runtime, for the demo and the e2e suite.
It exists only when `DEMO_CONTROL_ENABLED=true` **and** `NODE_ENV` is not `production`. Otherwise the
route is not registered and returns a plain 404. `NODE_ENV=production` together with
`DEMO_CONTROL_ENABLED=true` is a configuration error, and the process refuses to start. The control
needs `Authorization: Bearer <DEMO_CONTROL_TOKEN>` (at least 24 chars), compared in constant time
on SHA-256 digests. It can switch the mock, but it cannot reset the breaker.

**Failure injection is configuration only** (`AI_MOCK_MODE` or this control). Nothing in the body,
query or headers of `/secure-inquiry` can select a failure (there's an integration test for that).

## Architecture

```
            ┌──────────────────────────── Express app (src/app.ts) ─────────────────────────────┐
 request ──►│ requestId → helmet/no-store → request log → 415 check → express.json(32 KiB, strict, │
            │ inflate:false) → zod strictObject validation (src/http) → InquiryService           │
            └───────────────────────────────────────────┬─────────────────────────────────────┘
                                                        │ {userId, message}
            ┌───────────────────────────────────────────▼─────────────────────────────────────┐
            │ src/inquiry/service.ts                                                          │
            │ 1. sanitize(message)            src/sanitizer   → sanitized text + counts       │
            │ 2. breaker.execute(() =>        src/ai          closed │ open │ half-open        │
            │      generateWithTimeout(mockAi, sanitized))     (open → instant CircuitOpenError)│
            │ 3. buildAuditRecord + store.append  src/audit   AES-256-GCM(original), AAD=id+user│
            │    (every valid inquiry, any outcome; append fails → 500, no answer)            │
            │ 4. 200 / 502 / 503 + Retry-After / 504                                          │
            └─────────────────────────────────────────────────────────────────────────────────┘
 logs: pino JSON, route pattern only (never URL/body/headers); every string re-sanitized
```

| Module | Responsibility |
|---|---|
| `src/sanitizer/` | Linear-time scanner (no giant regex): NFKC working copy with zero-width/format characters stripped and Unicode digits mapped to ASCII. Emails first, then digit chains: the longest Luhn-valid 13–19 digit window is a card, and what's left is checked for an SSN. Details in [`docs/AI_SANITIZER.md`](docs/AI_SANITIZER.md). |
| `src/ai/mockAiClient.ts` | One `setTimeout(AI_MOCK_LATENCY_MS)` per call. `healthy` resolves, `fail` rejects **after** the latency, `hang` never settles. Honours `AbortSignal`. `generateWithTimeout` enforces the deadline with no dangling timers. |
| `src/ai/circuitBreaker.ts` | Consecutive-failure breaker with an injectable clock. Open → half-open is lazy (no timers), with exactly one trial in flight. A late result from a call started before the circuit opened is ignored. |
| `src/audit/crypto.ts` | Strict key parsing (32 bytes, base64/base64url/hex, canonical; weak or all-same keys rejected). Cipher with the key in a closure, hidden from `JSON.stringify`/`inspect`. |
| `src/audit/store.ts` | `{version:1, records:[…]}` file, mode 0600, dir 0700. Each write: temp file → `fsync` → `rename` → fsync dir. In-process queue with **group commit**: one rewrite flushes every queued record, and each `append` resolves only when its record is durable. A corrupt file stops startup instead of being overwritten. |
| `src/cli/audit.ts` | Operator tool: `verify` (decrypts everything and prints counts, never plaintext) and `decrypt <id>`. |
| `src/config.ts` | zod over `process.env`, fail fast. Errors name the variable, never its value. Key and token digest are non-enumerable. |
| `src/logger.ts` | pino with `formatters.log` + `hooks.logMethod` + child bindings all passed through `sanitize()`. Errors are logged as name + stack frames (the first stack line holds `err.message`, and Node's JSON `SyntaxError` message quotes the raw body). |
| `src/bootstrap.ts` | Listen, graceful SIGTERM/SIGINT (in-flight requests and their audit writes finish), exit 1 on bad config. `src/server.ts` is the 3-line entry. |

## Security decisions

- **PII never leaves in clear.** The AI gets the sanitized text. Logs carry only request id, method,
  route pattern, status, duration, outcome and redaction counts. Every logged string goes through the
  sanitizer again as a safety net, including error stacks and nested objects (depth-limited:
  `[Truncated]`, never raw). Error responses use fixed messages. Validation details never include
  client keys. Body-parser error messages, which quote the body, are never logged. Integration tests
  capture all log output and assert that none of the raw PII strings appears.
- **Encryption.** AES-256-GCM, 12-byte random IV per record, 16-byte tag, and AAD binding the
  ciphertext to its record id and userId (moving a ciphertext to another record fails to decrypt).
  The key comes only from `AUDIT_ENCRYPTION_KEY` (git-ignored `.env`; compose fails with a clear
  message if it is missing). It is never logged or serialized, and `.env`/`.env.*` are in
  `.gitignore` and `.dockerignore`.
- **Fail closed.** If the audit write fails, the user gets a 500 and no answer. Every valid inquiry
  is audited, including 502/503/504 outcomes.
- **Strict input.** Strict JSON, a size limit, no compressed bodies, unknown fields rejected, length
  in code points, lone surrogates and control characters rejected, and a userId that is itself PII
  rejected.
- **ReDoS.** The sanitizer is a scanner with simple anchored regexes. `eslint-plugin-regexp`'s
  `no-super-linear-backtracking`/`no-super-linear-move` run on the whole repo with no disables (they
  also caught a `/=+$/` in the key parser and a regex in the mutation script). Tests run several
  100 KB adversarial inputs: each finishes in < 25 ms except 100 000 Arabic-Indic digits (63 ms),
  with < 250 ms asserted, and a ~1 MB mixed input takes ~70 ms.
- **Demo control can't reach production**: it is not registered there, startup fails if someone
  enables it, it needs a ≥ 24-char bearer token compared in constant time, and it cannot change
  breaker state.
- **Container.** Multi-stage build on `node:24-alpine`, production dependencies only (`npm audit
  --omit=dev`: 0 vulnerabilities), non-root user `app` (uid 10001, nologin), `read_only` root fs +
  `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, `init`, healthcheck via `node -e fetch`
  (no curl in the image), and ports published on `127.0.0.1` only. Image: 254 MB.

## Trade-offs

- **The JSON file database rewrites the whole file on every flush**: O(n) per write. Group commit
  amortizes that under concurrency, and it keeps the "one JSON file" requirement and atomicity
  trivially correct, but it is not meant for millions of records. A real deployment would use an
  append-only log or a database and rotate keys by `keyId`.
- **Single writer.** Atomicity and ordering are guaranteed within one process. Two containers on the
  same volume would race; that needs a lock file or a real database.
- **The circuit state is in memory and per instance.** It resets on restart, and N replicas trip
  independently. A shared breaker (e.g. Redis) would fix that at the cost of a new dependency.
- **The sanitizer redacts on purpose more than it misses.** A Luhn-valid 13–19 digit window is a card
  even inside an unrelated number (`Call 555-1234 123-45-6789` → one card). The redacted copy is
  NFKC-normalized when it contains a redaction. The original stays exact in the encrypted record.
  The documented limits (no names, phone numbers or IBANs; no cards split over lines) are in
  [`docs/AI_SANITIZER.md` §7](docs/AI_SANITIZER.md#7-known-limitations--trade-offs).
- **Rejecting PII-looking userIds** blocks a legitimate numeric id that happens to be 9 digits or a
  Luhn-valid card number. That is better than storing an SSN in plaintext as a userId.
- **Every 503 is audited too.** That adds a few ms of fsync to the "instant" response (still
  ~10–20 ms, see the video) in exchange for a complete audit trail.
- **The demo control is in the codebase** (off by default, never in production). The alternative,
  restarting the container with another `AI_MOCK_MODE`, cannot show the same process recovering.
- No authentication or rate limiting on `/secure-inquiry`: out of scope for the exercise. They would
  go in front of it, at a gateway.

## Tests

| Suite | What | Count |
|---|---|---|
| Unit (`tests/unit`) | sanitizer case table, properties, ReDoS timing; breaker transitions with an injected clock; mock AI and timeout with **fake timers**; crypto (tamper, wrong AAD/key, key parsing, no key in inspect); store (200 concurrent appends, group commit, failure + recovery, corrupt file); CLI; config; validation; logger; bootstrap and graceful shutdown | 351 |
| Integration (`tests/integration`, supertest) | happy path + audit decryption, validation and transport errors, the **circuit breaker over HTTP** (3 slow 502s → fast 503 with `Retry-After` and no AI call; half-open failing trial re-opens; healthy trial closes; hang → 504; success resets the counter), the demo control's auth and absence in production, 25 concurrent requests → 25 audit records, failing store → 500, no PII in captured logs, the real 2000 ms latency with fake timers | 50 |

The integration suite runs **against two targets with the same files**
(`tests/integration/support/target.ts`):

- **In-process** (default): `createApp()` on `127.0.0.1:0`, demo control enabled in the test
  config, short latency and cool-down, a temp audit file, and a random key.
- **The running containers** (`E2E_BASE_URL` set, `docker compose --profile test run --rm tests`):
  timings come from `GET /__demo/ai-mock` (the real 2000 ms latency and 10 s cool-down). The
  container's audit volume is mounted read-only into the test container so the suite can decrypt the
  records. `E2E_PROD_BASE_URL` checks that the production `api` has no demo control. Six tests that
  need in-process access (log capture, an injected failing store, shutdown) are skipped there.
  Result: 44 passed, 6 skipped.

Coverage (v8, `src/**` minus the 3-line `src/server.ts`) is enforced at **95 %** for lines,
branches, functions and statements in `vitest.config.ts`. Current: 99.04 % statements,
96.95 % branches, 98.2 % functions, 99.38 % lines (401 tests). The sanitizer also has a **mutation check**
(`node scripts/mutation-check.mjs`): 20 deliberate breakages, all killed.

## How the video was recorded

Screen recording wasn't available on this machine (an Asahi Linux host reached over SSH), so the
terminal itself was recorded:

1. `scripts/demo.sh` types each command on screen and then **really executes it** (`eval` in the same
   shell): `docker compose up`, `curl`, `jq`, `docker compose exec/logs`, both test suites. No output
   is pre-recorded or edited. Long outputs are trimmed with `tail`/`grep` in the visible command
   itself, and the real exit codes are printed.
2. It was recorded with **asciinema 3.2.1** in headless mode:
   `asciinema rec --headless --window-size 120x38 -f asciicast-v2 -c scripts/demo.sh docs/videos/secure-middleware-demo.cast`.
   The `.cast` file is committed: it holds the exact output with real timestamps, and
   `asciinema play docs/videos/secure-middleware-demo.cast` replays it.
3. It was rendered with **agg 1.9.0** (`--font-family "Source Code Pro" --font-size 16 --theme
   monokai --idle-time-limit 4`) to GIF, then with **ffmpeg** (`libopenh264`, 15 fps, yuv420p) to
   MP4. `--idle-time-limit 4` only shortens gaps where the screen does not change for more than 4 s
   (the silent test runs and image start-up). The 2 s AI calls, the instant 503s and the
   one-second cool-down countdown play in real time, and the `.cast` keeps the unshortened timing.

## Configuration

| Env | Default | |
|---|---|---|
| `AUDIT_ENCRYPTION_KEY` | **required** | 32 bytes as base64/base64url/hex |
| `AUDIT_KEY_ID` | `k1` | stored in each record for key rotation |
| `AUDIT_LOG_PATH` | `data/audit-log.json` (image: `/app/data/audit-log.json`) | |
| `HOST` / `PORT` | `127.0.0.1` / `4380` (image: `0.0.0.0` / `8080` inside the container) | |
| `NODE_ENV` | `development` | `production` disables the demo control |
| `LOG_LEVEL` | `info` | |
| `MAX_BODY_BYTES` | `32768` | |
| `AI_MOCK_LATENCY_MS` / `AI_MOCK_MODE` / `AI_TIMEOUT_MS` | `2000` / `healthy` / `5000` | |
| `CIRCUIT_FAILURE_THRESHOLD` / `CIRCUIT_COOLDOWN_MS` | `3` / `15000` | |
| `DEMO_CONTROL_ENABLED` / `DEMO_CONTROL_TOKEN` | `false` / — | non-production only |
| `API_PORT` / `DEMO_PORT` (compose) | `4380` / `4381` | host ports, bound to 127.0.0.1 |

## Repository layout

```
src/            sanitizer/ ai/ audit/ cli/ http/ inquiry/ + app, config, errors, logger, bootstrap, server
tests/unit/     one folder per area            tests/integration/  dual-target HTTP suite
docs/           AI_SANITIZER.md, CONTRACT.md, videos/ (MP4 + asciinema .cast)
scripts/        demo.sh (the video), mutation-check.mjs
Dockerfile      deps → build → test │ prod-deps → runtime (last stage = production image)
docker-compose.yml  api (default) · api-demo (profile demo/test) · tests (profile test)
docker/dev.Dockerfile  the development container this was built in (Fedora + official Node 24)
```
