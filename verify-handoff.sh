#!/usr/bin/env bash
# E2E verification for the DSH handoff plugins. Proves memory survives a session
# boundary by planting a marker the repo does not contain and asking a fresh
# session for it — the only check that distinguishes "injected" from "read the file".
#
# Usage: verify-handoff.sh [profile]   (default: headless)
# Exit: 0 all criteria pass, 1 a criterion failed, 2 setup problem.
set -euo pipefail

PROFILE="${1:-headless}"
CHECKOUT="/home/coyote/src/deepseek-harness"
DSH_HOME_DIR="${DSH_HOME:-/home/coyote/.dsh-src}"
TSX="$CHECKOUT/node_modules/tsx/dist/esm/index.mjs"
STORE="$HOME/.agent/agent-handoff"
MARKER="VERIFY_MARKER_$(date +%s)"
TOKEN_FILE="$HOME/.config/ccp/client.token"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

[ -f "$TSX" ] || fail "tsx not found at $TSX (is the checkout built?)"
[ -f "$TOKEN_FILE" ] || fail "no ccp client token at $TOKEN_FILE"
[ -d "$DSH_HOME_DIR/profiles/$PROFILE" ] || fail "no profile '$PROFILE' under $DSH_HOME_DIR"
curl -sf -m 5 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" http://127.0.0.1:8099/healthz >/dev/null \
  || fail "ccp proxy is not answering on 127.0.0.1:8099"

WORK=$(mktemp -d /tmp/handoff-verify-XXXXXX)
cleanup() {
  rm -rf "$WORK"
  [ -n "${PROJECT_KEY:-}" ] && rm -rf "$STORE/$PROJECT_KEY"
}
trap cleanup EXIT

dsh() {
  ( cd "$WORK" && env DSH_HOME="$DSH_HOME_DIR" CCP_CLIENT_TOKEN="$(cat "$TOKEN_FILE")" \
      TSX_TSCONFIG_PATH="$CHECKOUT/tsconfig.json" \
      node --import "file://$TSX" "$CHECKOUT/apps/cli/src/bin.ts" --profile "$PROFILE" "$@" )
}

# 1. A clean repo so the store key is derived from it, not from /tmp itself.
( cd "$WORK" && git init -q -b main . && git config user.email v@local && git config user.name verify \
  && printf 'value = 1\n' > sample.py && git add -A && git commit -qm init )
ok "scratch repo created at $WORK"

PROJECT_KEY=$(echo "$WORK" | sed 's|/|-|g')
BRANCH_DIR="$STORE/$PROJECT_KEY/main"
ok "expected store: $BRANCH_DIR"

# 2. First session: let the plugin collect a turn.
dsh --permission-mode read-only "What does sample.py contain? One short sentence." >/dev/null 2>&1 || true
[ -f "$BRANCH_DIR/events.jsonl" ] || fail "plugin did not collect any events (no $BRANCH_DIR/events.jsonl)"
ok "events collected: $(wc -l < "$BRANCH_DIR/events.jsonl") line(s)"

# 3. Flush so handoff.md holds real content.
dsh --permission-mode read-only "/handoff-memory flush" >/dev/null 2>&1 || true
[ -f "$BRANCH_DIR/handoff.md" ] || fail "no handoff.md after flush"
SIZE_BEFORE=$(wc -c < "$BRANCH_DIR/handoff.md")
[ "$SIZE_BEFORE" -gt 100 ] || fail "handoff.md is only ${SIZE_BEFORE}B — summarizer produced nothing"
ok "handoff.md has ${SIZE_BEFORE}B"

# 4. Plant a marker that exists nowhere in the repo.
printf '\n# Constraints\n\n- %s: deploys go through ops/deploy.sh, never make release.\n' "$MARKER" \
  >> "$BRANCH_DIR/handoff.md"
grep -q "$MARKER" "$BRANCH_DIR/handoff.md" || fail "could not plant marker"
ok "marker planted: $MARKER"

# 5. Fresh session must answer with the marker without reading any file.
ANSWER=$(dsh --permission-mode read-only \
  "What is the deployment rule recorded in this session's context? Quote its identifier exactly." 2>&1 || true)
case "$ANSWER" in
  *"$MARKER"*) ok "fresh session returned the marker — injection works" ;;
  *) echo "--- answer was ---" >&2; echo "$ANSWER" >&2; fail "fresh session did not return the marker" ;;
esac

echo
echo "PASS: handoff memory verified end-to-end on profile '$PROFILE'"
