# AI-Augmented Prompt Log — Secure Middleware Service

This log was built from the **real transcript of the session** that produced this repository: the
main agent's JSONL transcript plus the three worker agents' transcripts, with the git history for
timestamps. All times are UTC on 2026-11-13. Quotes are verbatim, except that model names are
replaced by their roles (`[lead model]`, `[worker model]`) and long agent briefs are shortened where
marked `…`. The full contract the agents worked against is in [`docs/CONTRACT.md`](docs/CONTRACT.md).

Cast:

| Role | Who | Owned |
|---|---|---|
| **Human** | Adrián | the prompt below |
| **main** | the lead coding agent | scaffold, contract, coordination, reviews and fixes, README, video, this log |
| **sanitizer** | worker agent | `src/sanitizer/**`, its tests, `docs/AI_SANITIZER.md`, `scripts/mutation-check.mjs` |
| **core** | worker agent | mock AI, circuit breaker, crypto, audit store, CLI; then `Dockerfile` and `docker-compose.yml` |
| **api** | worker agent | config, errors, logger, Express app, routes, inquiry service, bootstrap, the integration suite |

---

## 1. The Strategy (Architecture & Data Flow)

### The request path the system implements

```
POST /secure-inquiry {userId, message}
  → requestId, helmet, no-store, request log (route pattern only)
  → 415 unless application/json (utf-8, no Content-Encoding) → express.json (32 KiB, strict)
  → zod strictObject validation (unknown keys, lengths in code points, lone surrogates, PII in userId)
  → sanitize(message)                          EMAIL / CREDIT_CARD (Luhn) / SSN → <REDACTED: TYPE>
  → breaker.execute(() => generateWithTimeout(mockAi, sanitized))   the AI only sees redacted text
        closed: call (2 s setTimeout) · 3 consecutive failures → open
        open: CircuitOpenError immediately → 503 "Service Busy" + Retry-After (no AI call)
        after cool-down: ONE trial (half-open) → success closes, failure re-opens
  → buildAuditRecord: AES-256-GCM(original, random IV, AAD = record id + userId) + redacted plaintext
  → JsonFileAuditStore.append: temp file → fsync → rename → fsync dir, group commit; failure → 500
  → 200 {requestId, auditId, answer, sanitizedMessage, redactions} | 502 | 503 | 504
```

### How the work was split, and why

The human asked for a lead agent that coordinates up to three parallel workers, acts as a "process
semaphore" between them, collects status every 5 minutes, and does not trust their reports. The
strategy was to remove every reason for the workers to block on one another **before** launching
them:

1. **Environment first (01:36–01:44).** main created a new btrfs subvolume on the external drive
   (`/srv/devenvs/@securemw`), a dev container (`securemw-dev`) on the existing rootless Docker,
   the git repo with the human's identity, and all npm dependencies. It also downloaded the asciinema
   and agg binaries for the video into a project-local `tools/` folder, so nothing on the host was
   installed. Ports 3000/3001 belong to other services, so everything was bound to 127.0.0.1:4380/4381.
2. **Interfaces as code.** Before any agent started, main committed **stub modules with the final
   signatures** (`sanitize`, `MockAiClient`, `generateWithTimeout`, `CircuitBreaker`,
   `createAuditCipher`, `JsonFileAuditStore`, `buildAuditRecord`). The api agent could then wire the
   whole app on the first minute against real types, while the other two filled in the bodies.
3. **A written contract** (`docs/CONTRACT.md`, 01:46) fixed the rest:
   - the HTTP API and the **error envelope**: a fixed message per code, `details` never echo client
     keys, and a status table;
   - the config table, the logging/PII rules and the sanitizer spec (which doubles as the sanitizer's
     generating prompt);
   - **file ownership** per agent, and **locks** (`flock`) on `npm`, `build`, `git` and `compose`,
     with explicit-path commits only;
   - status files plus a message to main every ~5 minutes, and a `BLOCKED:` escalation rule.
4. **One integration suite, two targets.** The contract required the same supertest files to run
   in-process and against the running container (`E2E_BASE_URL`). The demo control, which is off
   and impossible in production, let the remote run drive the circuit breaker.
5. **main as verifier and messenger.** main relayed each "X landed" to the agents waiting on it,
   reviewed critical code as it was committed, and at the end re-ran everything itself: typecheck,
   lint, 401 tests with coverage, the e2e suite in Docker and the mutation check. It also recorded the video.

### Timeline (from the transcript and `git log`)

| Time | Event |
|---|---|
| 01:35:46 | Prompt received |
| 01:46:02 | Scaffold + stub contracts committed (`e42858e`); contract written; three agents launched 01:47–01:48 |
| 01:49:18 | core: mock AI + circuit breaker (`2876547`) |
| 01:50:57 | api: config, errors, logger, HTTP layer, service, app, bootstrap (`d54f79d`) |
| 01:51:27 | core: AES-GCM cipher, atomic store, records, CLI (`75e8347`, `d991035`) |
| 01:53:08 | core: Dockerfile + compose, but the container crash-looped on the sanitizer stub |
| 01:53:48 | sanitizer v1 (`91f37fa`), after main put it on the critical path |
| 01:55:59 | api: unit tests + dual-target integration suite (`5bb9e1d`) |
| 01:56:56 | main: dev image switched to the official Node build (eslint segfault root cause) |
| 01:57–02:02 | all three agents report DONE |
| 02:00–02:01 | main re-runs: 391 tests and coverage ✔, e2e in Docker 44 ✔ / 6 skipped |
| 02:08–02:21 | main's review fixes two real sanitizer leaks (`aea26d4`, `cf0ca24`); README, contract copy (`5ee9a90`) |
| 02:25–02:29 | final video recorded (real 3 min 49 s, 401 tests ✔, e2e 44 ✔) and rendered to MP4 |

---

## 2. The Prompt Chain

### P0 — The human's prompt (verbatim)

> We are going to solve a backend problem with Node.js, Express and TypeScript. Like the last project, run everything in a new Docker container on the external drive (reuse the rootless Docker under /srv/devenvs/@docker from the dynamic-page-renderer project; do not use Podman). No internal Claude and no tailnet inside it: you work directly. Do not touch anything else on this machine: ports 3000 and 3001 belong to other services, so bind everything to 127.0.0.1 on a free, configurable port. Create a local git repo with my identity; I will publish it to my GitHub later.
> 
> You will be the main [lead model] agent and you can launch up to 3 parallel agents with the necessary tasks. Before launching them, write a shared contract: the API shape, the error format, which agent owns which files, and locks on npm, the build and git. Every 5 minutes they will give you updates on their status so you can help them and act as a messenger between agents, functioning as a process semaphore in case one affects another's work. These agents will be [worker model], and if any of them gets stuck you will step in to help. Do not trust their reports: re-run their tests and read the critical code yourself before you accept "done".
> 
> Everything must have unit tests and integration tests (supertest against the app, and the same suite again against the running Docker container), with at least 95% coverage enforced as a threshold.
> 
> Remember to add the Dockerfile, docker-compose.yml and the video to the final repo.
> 
> The task: Build a Secure Middleware Service.
> 
> 1. The endpoint: POST /secure-inquiry accepts a JSON body { userId: string, message: string }. Validate it strictly (types, length limits, max body size, no unknown fields) and return consistent JSON errors.
> 
> 2. The logic:
> - Step 1 (Sanitization): use AI to generate a robust sanitizer that strips emails, credit cards and SSNs (Social Security Numbers, or exactly 9 numeric digits that are not part of a longer number) from message and replaces them with <REDACTED: TYPE> (EMAIL, CREDIT_CARD, SSN). Cover separators (spaces, dashes, dots), cards validated with Luhn, emails with + tags and subdomains, overlaps (a card must never be partly redacted as an SSN), unicode, and very long input. The regexes must be ReDoS-safe: add a test that a 100 KB adversarial input finishes fast. Document in docs/AI_SANITIZER.md the prompt/spec it was generated from, the cases and why each matters, and a mutation check that proves the tests catch a broken pattern.
> - Step 2 (Mock AI call): simulate an external AI call with a setTimeout of 2 seconds that returns a "Generated Answer". Failures are injected only through configuration, never through the request body or headers; tests use fake timers. For the demo, a control that is disabled by default and protected by a token may switch the mock between failing and healthy; it must not exist in production mode.
> - Step 3 (Audit log): write the original message encrypted (AES-256-GCM, a random IV per record, the key from an environment variable that is never committed or logged) and the redacted message in plaintext to a mock database (a JSON file). Writes must be atomic and safe under concurrent requests. Raw PII must never appear in logs, errors or responses.
> 
> 3. The twist (Circuit Breaker): if the mock AI call fails 3 times in a row, the API must instantly return the fallback message "Service Busy" (503 with Retry-After) without waiting for the timeout. After a cool-down it lets one trial call through (half-open), closes on success and re-opens on failure. Test every transition.
> 
> Deploy it in Docker: a production Dockerfile (multi-stage, non-root user, healthcheck) and a docker-compose.yml with the service and a test runner. The encryption key comes from a git-ignored env file, with a .env.example in the repo.
> 
> Video: record a video of my local environment showing the project working, and commit it to the repo in docs/videos/. It must show real commands, not mocked output:
> - docker compose up;
> - a request whose emails, card and SSN come back redacted;
> - the audit log, with the original encrypted and the redacted text in plaintext;
> - the circuit breaker tripping, with the timing visible (calls of about 2 s, then an instant "Service Busy"), and then recovering;
> - the test suites passing.
> Screen recording is not available here, so record the terminal with asciinema, render it to MP4, and explain in the README how it was recorded.
> 
> At the end:
> - A README with the architecture, how to run it, the security decisions and the trade-offs.
> - PROMPT_LOG.md in English, built from this session's real transcript, following this template: 1. The Strategy (Architecture & Data Flow); 2. The Prompt Chain (my prompt, what the AI gave, the action taken); 3. The "Glass Box" Validation (one complex AI-generated function explained step by step); 4. The Security & Integrity Check (which mistakes the AI made and how they were caught). Also export it as a PDF to ~/Downloads on my MacBook Pro (ssh mac).
> - Tell me the exact time from this prompt to your final verified result.

### Step 1 — Environment, scaffold, contract

- **Prompt:** P0.
- **What the AI gave:** a plan (three agents: `sanitizer`, `core`, `api`) and an environment check: the
  Docker context, the busy ports (3000/3001 taken, 4380/4381 free), sudo, the network, and `ssh mac`.
  It created the subvolume, the dev container (Fedora 43 + Node 24) and the repo; installed Express 5.3,
  zod 4.6, pino 10.4, helmet 8.3, TypeScript 6.0, Vitest 5.1, supertest 7.3, ESLint 10 and
  `eslint-plugin-regexp`; wrote `tsconfig`, the Vitest config with two projects and a 95 % coverage
  threshold, and an ESLint config whose ReDoS rules are set to `error`; and wrote the stub modules and
  `CONTRACT.md`.
- **Action taken:** `tsc`, `eslint` and `vitest` sanity runs, then commit `e42858e`. A random key and a
  random demo token went into a git-ignored `.env` (mode 600), which was never printed.

### Step 2 — Three agent briefs (01:47–01:48)

Each brief starts the same way: *"FIRST read the whole shared contract … it is binding (ownership,
locks, how to run commands in the Docker dev container, status reporting)."* Then the specific
parts:

- **sanitizer:** *"You ARE the AI that generates it. The generating prompt/spec is contract §5 plus this
  brief; record it verbatim in `docs/AI_SANITIZER.md` … Work spec-first: write the case table + tests
  first, then implement until green … **overlaps** (a card must never be partly redacted as an SSN;
  `123456789@x.com` is one EMAIL; a card followed by an SSN in the same sentence … gives exactly one
  CARD + one SSN …) … Design for linear time: prefer a small tokenizer/scanner + simple anchored regexes
  … When ambiguous, prefer over-redaction (a leak is worse than a false positive) … the api agent calls
  `containsPii(userId)` … land a WORKING first version … within ~20 minutes."*
- **core:** *"Mock AI … ONE `setTimeout(latencyMs)` per call; `fail` rejects AFTER the latency … Unit
  tests with `vi.useFakeTimers()` (advance 1999 ms → still pending, 2000 → settled) … CircuitBreaker …
  **Test every transition** … Commit, then SendMessage main: 'ai + breaker committed' (api is waiting
  for these) … Phase 2 — Docker … non-root user … HEALTHCHECK using `node -e` + `fetch` … Ports bind to
  127.0.0.1 ONLY."*
- **api:** *"The stub files already define the exact signatures — code against them now … the SAME
  suite must run against two targets … circuit breaker over HTTP: mode fail → 3 × 502 each taking ≥
  latency, 4th → 503 Service Busy with Retry-After and fast … the captured logs of the whole file contain
  none of the raw PII strings used … Never put `err.message` in a response or log."*

- **What the AI gave:** 14 commits in ~14 minutes (see the timeline), each agent inside its own files.
- **Action taken:** after each "landed" message main forwarded the news (e.g. 01:50:09 *"core has
  committed the real MockAiClient, generateWithTimeout and CircuitBreaker … You can now wire them into
  createApp"*) and read the code as it arrived: the breaker (`execute`, the lazy half-open, ignoring
  late results), the crypto and the store, then the api agent's errors, logger, middleware, auth and service.

### Step 3 — Review follow-ups sent by main while the agents were working

| Time | Prompt from main | What the AI gave | Action |
|---|---|---|---|
| 01:51:24 → api | *"src/logger.ts sanitizeValue: at depth >= MAX_DEPTH it returns the object RAW, so strings nested deeper than 6 levels bypass the PII safety net … pino's formatters.log does not touch child-logger bindings"* | `[Truncated]` at the depth limit, child bindings sanitized, a test with a deeply nested email (`5bb9e1d`) | verified in the code and tests |
| 01:53:34 → sanitizer | *"you are now on the critical path. core's container and the api agent's tests both crash on the sanitize() stub … commit a working v1 … in the next few minutes"* | v1 committed at 01:53:48 (`91f37fa`, 84 cases) | main unblocked core and api |
| 01:53:55 → api | *"treat an EMPTY E2E_BASE_URL … as unset"* (so coverage can run inside the compose test image) | done in `target.ts` | used in the video's coverage run |
| 01:53:57 → core | *"a production operator should be able to run docker compose up WITHOUT a DEMO_CONTROL_TOKEN … verify whether the `${DEMO_CONTROL_TOKEN:?…}` … breaks plain docker compose up"* | confirmed that it did break; changed to `${…:-}` (`726d0b3`); the app itself still refuses to start `api-demo` without a token | verified in compose |
| 01:57:05 → api | *"core ran your early suite in Docker: 42 passed, 2 skipped, 1 failed … for an EMPTY body the test expects a (root) detail, but the server returns userId+message required … make test and code agree"* | test aligned with the behaviour (`7217b11`) | e2e re-run: 0 failures |
| 01:59:22 → sanitizer | *"npx eslint . (now working) reports 2 errors in your scripts/mutation-check.mjs … Fix it without disabling the rule"* | line-by-line parsing (`3de1127`) | `eslint .` clean on the whole repo |

### Step 4 — "Done" was not accepted until main re-ran everything

- **Prompt (the human's rule):** *"Do not trust their reports: re-run their tests and read the critical code
  yourself before you accept 'done'."*
- **What main ran (02:00–02:01):** `tsc --noEmit` ✔, then `eslint .`. The latter found **9 errors that
  every agent's "lint clean" report had missed** (see §4). Then `npm run test:coverage`: 391 tests ✔,
  99.12 % statements, 97.22 % branches. Then the full e2e suite against the containers: 44 ✔, 6
  in-process-only tests skipped, 1 min 25 s.
- **Action taken:** fixed the lint findings in core's crypto (`a7186e3`), and read the sanitizer's
  scanner line by line. That reading produced the two leak fixes in §3 and §4 (`aea26d4`, `cf0ca24`).

### Step 5 — Video, README, this log

- **Prompt:** *"record the terminal with asciinema, render it to MP4 … It must show real commands, not
  mocked output."*
- **What the AI gave:** `scripts/demo.sh`, which types each command and then runs it with `eval`. A dry
  run found the first version trimmed away the test counts, so the script now prints the real exit
  codes. Recorded with asciinema 3.2.1 (headless), rendered with agg 1.9.0 and ffmpeg (OpenH264).
- **Action taken:** main checked the cast's text (`asciinema convert -f txt`): three 502s at about 2.03 s,
  503s in 0.012–0.023 s, the half-open trial re-opening and then closing, 401 tests and 44 e2e tests
  passing (final recording), and 0 matches for the PII strings in the audit file and the logs. It also looked at frames
  extracted from the MP4.

---

## 3. The "Glass Box" Validation — `processChain` / `cardEnds` / `chooseCardEnd` (`src/sanitizer/digits.ts`)

This is the most intricate AI-generated code in the repo: the piece that decides, for a run of
digits and separators, which part is a card and which is an SSN. It is linear, regex-free and
overlap-safe. It is also where the review found a real leak, so the walkthrough shows the fixed
version on the input that used to leak:

```
card 4111 1111 1111 1111 102-45-6789 end
```

**Step 0 — the chain.** `findNumberSpans` scans for a digit, then extends while it sees
`digits (one separator) digits`. A separator is exactly one space, `-`, `.`, Unicode space or Unicode
dash. This gives a *chain* of runs with the separator class between each pair:

| run k | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| digits | 4111 | 1111 | 1111 | 1111 | 102 | 45 | 6789 |
| `seps[k]` (to the next run) | SPACE | SPACE | SPACE | SPACE | DASH | DASH | — |

**Step 1a — SSN-before-card exception.** At run 0, is there an SSN-shaped group (`AAA-GG-SSSS` with
one consistent separator, or a 9-digit run) **immediately followed by a valid card**? `4111 1111 1111` is
not 3-2-4, so no.

**Step 1b — `cardEnds(text, chain, 0)`: every Luhn-valid 13–19 digit window starting at run 0, in one
pass.** Luhn doubles every second digit *counted from the right*, so which digits are doubled
depends on the window's final length, which is not known while scanning left to right. The function
keeps **two running sums**: `evenDoubled` (as if the digits at even offsets from the left were doubled)
and `oddDoubled`. At each run boundary it picks the one that matches the current length: for an even
total, the doubled digits are the even offsets; for an odd total, the odd offsets.

| after run | digits so far | total | sum used | valid? |
|---|---|---|---|---|
| 0–2 | 4111 1111 1111 | 12 | — (< 13) | — |
| 3 | …1111 | 16 | `evenDoubled` = 30 | **yes → end 3** |
| 4 | …102 | 19 | `oddDoubled` = 40 | **yes → end 4** (`4111111111111111102` is Luhn-valid) |
| 5 | +45 → 21 | — | > 19: stop | |

Each window costs O(its digits). The loop stops at 19 digits, so the scan is O(19) per start run, which
keeps the whole sanitizer linear. That is what the ReDoS tests measure.

**Step 1c — `chooseCardEnd(chain, [3, 4])`.** The first version simply took the **longest** window
(end 4). That claimed `4111 1111 1111 1111 102` as the card and left `-45-6789` in clear: **6 of the
SSN's 9 digits leaked.** The fixed version walks the shorter valid ends from longest to shortest
and keeps one when an SSN-shaped group starts right after it: `ssnShapeAt(chain, 4)` sees runs 4–6 =
`102-45-6789` (3-2-4, both separators DASH) and returns 6, so the card ends at run 3. The longer
window can be discarded safely: a card is ≥ 13 digits and an SSN is 9, so both never fit in one
19-digit window, and the longer window always cuts the SSN.

**Step 2 — SSNs in what is left.** Runs 0–3 are claimed by the card. The remaining group 4–6 is, as a
whole, `isSsnShape` → claimed as SSN (unless glued to a letter: `ssnInsideWord`). If the leftover group
were longer (`… 1112 123-45-6789`, with a Luhn-invalid card), `claimSeparatedSsns` would look for a
3-2-4 window whose neighbours are joined by a **different** separator. A change of separator ends
a number, while `123-45-6789-12` (same separator) stays "part of a longer number", as the spec
requires.

**Result:** `card <REDACTED: CREDIT_CARD> <REDACTED: SSN> end`, with `{CREDIT_CARD: 1, SSN: 1}`.

**How each step is pinned by tests.** The case table has `4111 1111 1111 1111 102-45-6789` and
`… 128-45-6789` (the colliding cases) next to the spec's `… 123-45-6789`. A property test generates
600 random valid 16-digit cards × random SSNs × every separator pairing and requires that no digit
survive. The mutation check has a mutant for each guard: `luhn-always-true`, `luhn-parity-flipped`,
`card-max-length-unbounded`, `card-min-length-lowered`, `order-card-before-ssn-lost`,
`card-swallows-following-ssn`, `ssn-separator-change-ignored`, `ssn-same-separator-guard-removed`,
and more. **20/20 are killed**; the real output is in `docs/AI_SANITIZER.md` §6.

---

## 4. The Security & Integrity Check — mistakes the AI made, and how they were caught

| # | Mistake (who) | Impact | How it was caught | Fix |
|---|---|---|---|---|
| 1 | **Longest Luhn window swallowed the first group of a following SSN** (sanitizer) | ~1 in 10 "card + SSN" messages leaked 6 SSN digits (`<REDACTED: CREDIT_CARD>-45-6789`) | main, by tracing the function by hand for the Glass Box section, then a probe that searched for colliding 3-digit groups (102, 110 and 128 all leaked). The spec's own example `123` happened not to collide, so the case table passed. | `chooseCardEnd` + 3 cases + a 600-pair property test + mutant (`cf0ca24`) |
| 2 | **An SSN after a Luhn-invalid card left in clear, documented as a "trade-off"** (sanitizer) | `4111-1111-1111-1112 123-45-6789` leaked the SSN | main reading the agent's own limitations section and rejecting it ("a leak is worse than a false positive" was in the brief) | separator change ends a number (`aea26d4`), 5 cases, 2 mutants |
| 3 | **Logger safety net returned raw objects past depth 6** (api) | PII nested deeply in a log object would bypass `sanitize()` | main's code review of `d54f79d`, 30 s after the commit | `[Truncated]` + test; child-logger bindings also sanitized |
| 4 | **"eslint clean" reports while ESLint was crashing** (all) | the ReDoS lint, the main guard asked for, wasn't really running | main ran it itself: exit 139 (segfault). It bisected 60+ rules to `regexp/no-misleading-unicode-character`, then reproduced it as `new Intl.Segmenter()` segfaulting in **Fedora's Node 24 build (system ICU)**, while `node:24-alpine` worked on the same kernel. One agent had worked around it with `--jitless`. | dev image switched to the official Node 24.22.3 build (`b75d5e2`), the same runtime family as production |
| 5 | **Super-linear regexes** `/=+$/` in key parsing (core) and in the mutation script (sanitizer) | quadratic on adversarial input (not exploitable in the key parser, where input is length-checked first) | `eslint .` on the whole tree once the lint ran: 9 errors | loop-based strip (`a7186e3`), line parsing in the script |
| 6 | **`${DEMO_CONTROL_TOKEN:?}` in compose** (core) | a production operator without a demo token could not run `docker compose up` at all (compose interpolates every service) | main asked core to test it with a temp env file | `${…:-}`; the app's config still refuses `api-demo` without a token |
| 7 | **Empty-body test disagreed with the server** (api) | e2e failure | only visible when core ran the suite **in Docker** | test aligned with the parser's real behaviour |
| 8 | **Flaky "instant 503" assertion** at 50–100 ms mock latency under coverage load (api) | intermittent CI failures | the api agent re-ran 3× and saw 35 ms vs 227 ms | in-process latency 300 ms; threshold `min(latency/2, 150 ms)` |
| 9 | **Tests that passed for the wrong reason** (sanitizer) | "12 digits / 20 digits are not cards" used Luhn-invalid numbers, so the length bounds were untested | the mutation check: 2 of 17 mutants survived on the first run | Luhn-valid 12/20-digit cases |
| 10 | **Card stealing digits of a preceding SSN** (sanitizer, v1) | `123-45-6789 4111 …` lost the SSN | its own case table on the first run | SSN-before-card exception |
| 11 | **A wrong test of main's own**: `Call 555-1234 123-45-6789` assumed to be phone + SSN | none: the scanner was right, `5551234123456789` is Luhn-valid, so it is one card by the over-redaction rule | the test failed and main checked the Luhn sum instead of "fixing" the code | kept as a documented over-redaction case |

### Integrity checks performed by main (not by the agents)

- `npx tsc --noEmit` and `npx eslint .` (ReDoS rules, no disables): clean.
- `npm run test:coverage`: **401 tests** (351 unit + 50 integration), coverage gate 95 % enforced;
  final numbers 99.04 % statements, 96.95 % branches, 98.2 % functions, 99.38 % lines.
- `docker compose --profile test run --rm tests`: the same integration suite against the running
  `api-demo` and the production-mode `api` containers: 44 passed, 6 in-process-only skipped.
- `node scripts/mutation-check.mjs`: 20/20 mutants killed. The script works on a temp copy, never on
  the repo.
- In the recorded demo, `grep -cE '4111 1111|123-45-6789|jane\.doe'` over the audit file and over
  the container logs both print `0`, and the CLI's `verify` decrypts every record.
- Secrets: `.env` is git-ignored (and in `.dockerignore`), was created with mode 600, was never printed
  or committed, and `git log -p | grep` for the key finds nothing. The compose file reads it only
  through interpolation.
