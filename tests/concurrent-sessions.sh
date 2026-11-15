#!/usr/bin/env bash
# Two sessions against one repo at the same time. Proves the store keeps both
# sessions' events instead of losing one to a lock race, and that every line
# stays parsable afterwards.
set -uo pipefail
CHECKOUT=/home/coyote/src/deepseek-harness
TSX="$CHECKOUT/node_modules/tsx/dist/esm/index.mjs"
TOK=$(cat "$HOME/.config/ccp/client.token")
REPO=/tmp/conc
STORE="$HOME/.agent/agent-handoff/-tmp-conc/main"

rm -rf "$REPO"; mkdir -p "$REPO"; cd "$REPO"
git init -q -b main .; git config user.email a@b; git config user.name a
echo "z=1" > con.py; git add -A; git commit -qm i

run() {
  env DSH_HOME=/home/coyote/.dsh-src CCP_CLIENT_TOKEN="$TOK" \
      TSX_TSCONFIG_PATH="$CHECKOUT/tsconfig.json" \
      node --import "file://$TSX" "$CHECKOUT/apps/cli/src/bin.ts" \
      --profile headless --permission-mode read-only "$1"
}

run "Odpowiedz jednym slowem: alfa" > /tmp/conc-a.log 2>&1 &
A=$!
run "Odpowiedz jednym slowem: beta" > /tmp/conc-b.log 2>&1 &
B=$!
wait $A; A_EXIT=$?
wait $B; B_EXIT=$?
echo "exit A=$A_EXIT  B=$B_EXIT"

echo "--- odpowiedzi ---"
tail -1 /tmp/conc-a.log; tail -1 /tmp/conc-b.log

echo "--- store ---"
[ -f "$STORE/events.jsonl" ] || { echo "FAIL: brak events.jsonl"; exit 1; }
TOTAL=$(grep -c . "$STORE/events.jsonl" || true)
BROKEN=$(python3 - "$STORE/events.jsonl" <<'PY'
import json,sys
bad=0
for line in open(sys.argv[1], encoding='utf8'):
    line=line.strip()
    if not line: continue
    try: json.loads(line)
    except Exception: bad+=1
print(bad)
PY
)
SESSIONS=$(python3 - "$STORE/events.jsonl" <<'PY'
import json,sys
ids=set()
for line in open(sys.argv[1], encoding='utf8'):
    line=line.strip()
    if not line: continue
    try: ev=json.loads(line)
    except Exception: continue
    if ev.get('sessionId'): ids.add(ev['sessionId'])
print(len(ids))
PY
)
echo "linii=$TOTAL  zepsutych=$BROKEN  różnych sesji=$SESSIONS"

[ "$BROKEN" -eq 0 ] || { echo "FAIL: zepsute linie w events.jsonl"; exit 1; }
[ "$SESSIONS" -ge 2 ] || { echo "FAIL: tylko $SESSIONS sesji w store — jedna zgubiła zdarzenia"; exit 1; }
echo "PASS: obie sesje zapisały zdarzenia, store spójny"
