#!/usr/bin/env bash
# Scripted terminal demo of the Secure Middleware Service, recorded with asciinema
# (see README → "How the video was recorded"). Every command is typed on screen
# and then really executed with `eval` in this shell — no output is mocked.
#
#   tools/asciinema rec --headless --window-size 120x34 -c scripts/demo.sh docs/videos/demo.cast
#
# Requires: docker compose (rootless is fine), curl, jq, and a filled-in .env.
set -uo pipefail
cd "$(dirname "$0")/.."

export API="127.0.0.1:${API_PORT:-4380}"
export DEMO="127.0.0.1:${DEMO_PORT:-4381}"
export JSON='Content-Type: application/json'
TYPE_DELAY="${TYPE_DELAY:-0.01}"
TMP="$(mktemp -d)"; export TMP
trap 'rm -rf "$TMP"' EXIT

G=$'\e[1;32m'; C=$'\e[1;36m'; Y=$'\e[1;33m'; N=$'\e[0m'

say() { printf '\n%s# %s%s\n' "$C" "$*" "$N"; sleep 1.2; }
banner() { printf '\n%s━━━ %s ━━━%s\n' "$Y" "$*" "$N"; sleep 1.2; }
run() {
  local cmd="$1" i
  printf '%s$%s ' "$G" "$N"
  for ((i = 0; i < ${#cmd}; i++)); do printf '%s' "${cmd:i:1}"; sleep "$TYPE_DELAY"; done
  printf '\n'
  sleep 0.4
  eval "$cmd"
  sleep "${PAUSE:-1.5}"
}
countdown() {
  local s
  for ((s = $1; s > 0; s--)); do printf '\r  waiting for the cool-down… %2ss ' "$s"; sleep 1; done
  printf '\r  cool-down elapsed.             \n'
}

banner "Secure Middleware Service — real commands on $(uname -n), $(date -u '+%Y-%m-%d %H:%M UTC')"
run 'git log --oneline | head -5'
run 'docker version --format "client {{.Client.Version}} / server {{.Server.Version}} (rootless)"'

banner "1. docker compose up"
say "api = production mode (no demo control). api-demo = same image, demo control on, 10 s cool-down."
run 'docker compose --profile demo up -d --build --wait 2>&1 | grep -vE "^ *#|^#" | tail -n 8'
run 'docker compose --profile demo ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"'
run 'curl -s $API/health; echo'

banner "2. A request with an email, a credit card and an SSN"
run "curl -s -o \$TMP/r.json -w 'HTTP %{http_code} in %{time_total}s\n' -X POST \$API/secure-inquiry -H \"\$JSON\" \\
  -d '{\"userId\":\"user_42\",\"message\":\"Hi, I am jane.doe+billing@mail.example.co.uk. Card 4111 1111 1111 1111, SSN 123-45-6789. Thanks!\"}'"
run 'jq . $TMP/r.json'

banner "3. The audit log (mock DB = a JSON file in the container volume)"
run "docker compose exec -T api cat /app/data/audit-log.json | jq '.records[-1]'"
say "The original is AES-256-GCM ciphertext (random IV per record); the redacted text is plaintext."
run "docker compose exec -T api cat /app/data/audit-log.json | grep -cE '4111 1111|123-45-6789|jane\\.doe' || true"
run "docker compose logs --no-log-prefix api | grep -cE '4111 1111|123-45-6789|jane\\.doe' || true"
run "docker compose logs --no-log-prefix api | grep secure-inquiry | tail -n 1 | jq -c ."
say "Operator tool: with the key from .env the original can be recovered and verified."
run 'docker compose exec -T api node dist/cli/audit.js verify'
run "docker compose exec -T api node dist/cli/audit.js decrypt \$(jq -r .auditId \$TMP/r.json)"

banner "4. Circuit breaker (api-demo on :${DEMO_PORT:-4381})"
run 'set -a; . ./.env; set +a   # loads DEMO_CONTROL_TOKEN without printing it'
export AUTH="Authorization: Bearer ${DEMO_CONTROL_TOKEN:-}"
run "curl -s -X PUT \$DEMO/__demo/ai-mock -H \"\$AUTH\" -H \"\$JSON\" -d '{\"mode\":\"fail\"}' | jq -c ."
ask() { curl -s -o "$TMP/b.json" -D "$TMP/h.txt" -w "call $1 -> HTTP %{http_code} in %{time_total}s\n" -X POST "$DEMO/secure-inquiry" -H "$JSON" -d '{"userId":"user_42","message":"What is my balance?"}'; }
export -f ask
say "The mock AI now fails after its 2 s setTimeout. 3 failures in a row open the circuit:"
run 'for i in 1 2 3 4 5; do ask $i; done'
run "grep -i '^retry-after' \$TMP/h.txt; jq -c . \$TMP/b.json"
run 'curl -s $DEMO/health; echo'
say "After the cool-down one trial call goes through (half-open). The mock still fails → re-open:"
countdown "$(awk 'tolower($1)=="retry-after:"{print $2+0}' "$TMP/h.txt")"
run 'for i in 6 7; do ask $i; done'
say "Now heal the mock and wait for the next half-open trial:"
run "curl -s -X PUT \$DEMO/__demo/ai-mock -H \"\$AUTH\" -H \"\$JSON\" -d '{\"mode\":\"healthy\"}' | jq -c '{mode, circuit: .circuit | {state, retryAfterMs}}'"
countdown "$(curl -s -H "$AUTH" "$DEMO/__demo/ai-mock" | jq '(.circuit.retryAfterMs / 1000 | ceil)')"
run 'for i in 8 9; do ask $i; done; curl -s $DEMO/health; echo'
say "The production-mode api has no demo control at all:"
run "curl -s -X PUT \$API/__demo/ai-mock -H \"\$AUTH\" -H \"\$JSON\" -d '{\"mode\":\"fail\"}'; echo"

banner "5. Test suites"
say "Unit + in-process integration (supertest), coverage threshold 95 %:"
PAUSE=2 run 'docker compose --profile test run --rm --no-deps -e E2E_BASE_URL= -e E2E_PROD_BASE_URL= tests npm run test:coverage 2>&1 | tail -n 47; echo "exit code: ${PIPESTATUS[0]}"'
say "The same integration suite against the running containers (api-demo + production api):"
PAUSE=2 run 'docker compose --profile test run --rm tests 2>&1 | grep -E "✓|✗|×|Test Files|Tests |Duration" | tail -n 30; echo "exit code: ${PIPESTATUS[0]}"'

banner "6. Clean up"
run 'docker compose --profile demo --profile test down 2>&1 | tail -n 4'
printf '\n%sDone.%s\n' "$G" "$N"
sleep 2
