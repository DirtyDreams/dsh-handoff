#!/usr/bin/env bash
# Long-session probe: drive one persisted session through N turns and record what
# the handoff plugin actually does — refresh count, timing, store growth, errors.
# Evidence goes to a JSON file so the numbers come from measurement, not memory.
set -uo pipefail

N="${1:-55}"
CHECKOUT=/home/coyote/src/deepseek-harness
TSX="$CHECKOUT/node_modules/tsx/dist/esm/index.mjs"
TOK=$(cat "$HOME/.config/ccp/client.token")
REPO=/tmp/long
STORE="$HOME/.agent/agent-handoff/-tmp-long/main"
OUT=/tmp/long-session.json

dsh() {
  env DSH_HOME=/home/coyote/.dsh-src CCP_CLIENT_TOKEN="$TOK" \
      TSX_TSCONFIG_PATH="$CHECKOUT/tsconfig.json" \
      node --import "file://$TSX" "$CHECKOUT/apps/cli/src/bin.ts" \
      --profile "$(basename "${1:-headless}")" >/dev/null 2>&1
}

snap() {
  python3 - "$STORE" "$1" <<'PY'
import json, os, sys
store, phase = sys.argv[1], sys.argv[2]
meta_p = os.path.join(store, "meta.json")
ev_p = os.path.join(store, "events.jsonl")
hd_p = os.path.join(store, "handoff.md")
meta = json.load(open(meta_p)) if os.path.exists(meta_p) else {}
print(json.dumps({
  "phase": phase,
  "events_lines": sum(1 for l in open(ev_p, encoding="utf8") if l.strip()) if os.path.exists(ev_p) else 0,
  "handoff_chars": os.path.getsize(hd_p) if os.path.exists(hd_p) else 0,
  "last_collected_seq": meta.get("lastCollectedSeq"),
  "last_refreshed_seq": meta.get("lastRefreshedSeq"),
  "summarizer_calls": meta.get("summarizerUsage", {}).get("calls"),
  "summarizer_tokens": meta.get("summarizerUsage", {}).get("totalTokens"),
  "event_line_count": meta.get("eventLineCount"),
}))
PY
}

rm -rf "$REPO" "$STORE"; mkdir -p "$REPO"; cd "$REPO"
git init -q -b main .; git config user.email a@b; git config user.name a
printf 'n=1\n' > n.py; git add -A; git commit -qm init

: > "$OUT.tmp"
echo "turn,seconds,ok" >> "$OUT.tmp"

TURN_UPDATE_PROMPT="Odpowiedz jednym slowem: ok"
SID=""

START_ALL=$(date +%s)
for i in $(seq 1 "$N"); do
  S=$(date +%s)
  if [ -z "$SID" ]; then
    env DSH_HOME=/home/coyote/.dsh-src CCP_CLIENT_TOKEN="$TOK" \
        TSX_TSCONFIG_PATH="$CHECKOUT/tsconfig.json" \
        node --import "file://$TSX" "$CHECKOUT/apps/cli/src/bin.ts" \
        --profile headless --permission-mode read-only "$TURN_UPDATE_PROMPT" >/dev/null 2>&1
  else
    env DSH_HOME=/home/coyote/.dsh-src CCP_CLIENT_TOKEN="$TOK" \
        TSX_TSCONFIG_PATH="$CHECKOUT/tsconfig.json" \
        node --import "file://$TSX" "$CHECKOUT/apps/cli/src/bin.ts" \
        --profile headless --permission-mode read-only --session-id "$SID" "$TURN_UPDATE_PROMPT" >/dev/null 2>&1
  fi
  RC=$?
  E=$(date +%s)
  echo "$i,$((E-S)),$RC" >> "$OUT.tmp"

  if [ -z "$SID" ] && [ -f "$STORE/meta.json" ]; then
    SID=$(python3 -c "import json;print(json.load(open('$STORE/meta.json')).get('sessionId',''))" 2>/dev/null)
  fi

  # snapshot at each refresh boundary we care about
  case "$i" in
    10|20|30|40|50|"$N") snap "turn-$i" >> "$OUT.snaps" ;;
  esac
done
END_ALL=$(date +%s)

echo "---" 
echo "total_seconds=$((END_ALL-START_ALL))"
echo "session_id=$SID"
echo "--- snapshots ---"
cat "$OUT.snaps"
python3 - "$OUT.tmp" "$OUT" "$((END_ALL-START_ALL))" <<'PY'
import json, sys
rows = [l.strip().split(",") for l in open(sys.argv[1]) if l.strip() and not l.startswith("turn")]
secs = [int(r[1]) for r in rows]
fails = [r for r in rows if int(r[2]) != 0]
snaps = []
import os
if os.path.exists(sys.argv[1].replace(".tmp", ".snaps")):
    snaps = [json.loads(l) for l in open(sys.argv[1].replace(".tmp", ".snaps")) if l.strip()]
json.dump({
  "turns": len(rows),
  "total_seconds": int(sys.argv[3]),
  "per_turn_seconds": {"min": min(secs), "max": max(secs), "avg": round(sum(secs)/len(secs), 1)},
  "failed_turns": fails,
  "snapshots": snaps,
}, open(sys.argv[2], "w"), indent=2)
print(open(sys.argv[2]).read())
PY
