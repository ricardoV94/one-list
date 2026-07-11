#!/usr/bin/env bash
# Run the whole suite. Serves the repo on :8899 and drives index.html for real.
#
#   ./tests/run.sh              # everything
#   ./tests/run.sh fork sync    # named suites only
#
# Logic suites (fork) slice the real functions out of index.html and drive them in node.
# Browser suites drive the real page in headless Chromium with Firebase route-stubbed by
# tests/fake-firestore.js.
#
# Requires: node, python3, and playwright + a chromium. Set CHROME to a browser binary if
# playwright's bundled one isn't installed:
#   CHROME=$(which chromium) ./tests/run.sh
set -uo pipefail
cd "$(dirname "$0")/.."

LOGIC=(fork)
BROWSER=(sync solo block acks propagate e2e)
SUITES=("${@:-}")
if [ -z "${1:-}" ]; then SUITES=("${LOGIC[@]}" "${BROWSER[@]}"); fi

python3 -m http.server 8899 --directory . >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1

FAILED=0
for t in "${SUITES[@]}"; do
  OUT=$(node "tests/$t.mjs" 2>&1); RC=$?
  LINE=$(echo "$OUT" | grep -E '^[0-9]+ passed' | tail -1)
  if [ $RC -ne 0 ]; then
    FAILED=$((FAILED+1))
    printf '%-12s %s\n' "$t:" "${LINE:-CRASHED}"
    echo "$OUT" | grep -E 'FAIL|Error|error:' | head -20 | sed 's/^/    /'
  else
    printf '%-12s %s\n' "$t:" "$LINE"
  fi
done

echo "---"
if [ $FAILED -eq 0 ]; then echo "all suites pass"; else echo "$FAILED suite(s) FAILING"; fi
exit $FAILED
