#!/usr/bin/env bash
# Redaction at scale: run a real 1000+ line diff through redact() and measure
# what it removes, what it wrongly destroys, and how long it takes.
#
# The diff is the fork's own upstream..HEAD delta. Secrets are injected into
# copies of it (never into the repo) so both halves of the question can be
# answered: does it catch what it must, and does it leave the rest alone.
set -uo pipefail
cd /home/coyote/Work/dsh-handoff || exit 1

OUT=/tmp/redact-scale.json
BASE=/tmp/redact-base.diff
git diff upstream/main HEAD > "$BASE"
LINES=$(wc -l < "$BASE")
BYTES=$(wc -c < "$BASE")
echo "bazowy diff: $LINES linii, $BYTES B"

python3 - "$BASE" <<'PY'
import json, re, subprocess, sys, time

base_path = sys.argv[1]
base = open(base_path, encoding="utf8").read()

# Secrets assembled from fragments: a literal here would be refused by GitHub
# push protection if this file were ever committed, and the point is the shape.
SECRETS = {
    "openai-proj": "sk-proj-" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "anthropic": "sk-ant-" + "api03abcdefghijklmnopqrstuvwxyz0123456789",
    "groq": "gsk_" + "abcdefghijklmnopqrstuvwxyz0123456789",
    "huggingface": "hf_" + "abcdefghijklmnopqrstuvwxyz0123456789",
    "perplexity": "pplx-" + "abcdef0123456789abcdef0123456789",
    "npm": "npm_" + "abcdefghijklmnopqrstuvwxyz0123456789",
    "stripe": "sk" + "_live_" + "abcdefghijklmnopqrstuvwx",
    "github": "ghp_" + "abcdefghijklmnopqrstuvwxyz0123",
    "slack": "xoxb-" + "1234567890-abcdefghij",
    "aws-id": "AKIA" + "IOSFODNN7EXAMPLE",
    "gcp": "AIza" + "SyA1234567890abcdefghijklmnopqrstuv",
    "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "google-refresh": "1//0" + "abcdefghijklmnopqrstuvwxyzABCDEFG",
    "bearer": "Bearer " + "4fJ9kQ2mR7xL1pN8vT3wY6zA5bC0dE2gH",
    "env-line": "CCP_CLIENT_TOKEN=" + "Zx9Kq2LmP4vN7wR1",
    "prose-pl": "hasło to " + "tajnehaslo123456",
}
# Near-misses that must survive: ordinary code the plugin sees every day.
KEEPS = {
    "git-sha": "0123456789abcdef0123456789abcdef01234567",
    "short-commit": "4eeb1b0",
    "path-with-key": "src/keyboard-handler.ts",
    "path-with-token": "docs/tokens.md",
    "budget-number": "max_total_tokens = 200000",
    "prose": "The handoff records progress, decisions and next steps.",
    "diff-header": "+++ b/src/redact.ts",
    "import-line": 'import { redact } from "./redact";',
}

# Inject each secret and each near-miss as its own added line, so a removal is
# attributable to that token and an over-redaction is visible by content.
injected = base
for i, (name, value) in enumerate(SECRETS.items()):
    injected += f"\n+// probe-{name}: {value}\n"
for i, (name, value) in enumerate(KEEPS.items()):
    injected += f"\n+// keep-{name}: {value}\n"

open("/tmp/redact-injected.diff", "w", encoding="utf8").write(injected)

# Run redact through bun (the project's own runtime) over the whole blob.
script = '''
import { redact } from "/home/coyote/Work/dsh-handoff/src/redact.ts";
import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync("/tmp/redact-injected.diff", "utf8");
const t0 = performance.now();
const out = redact(text);
const ms = performance.now() - t0;
writeFileSync("/tmp/redact-out.diff", out);
console.log(JSON.stringify({ ms: Math.round(ms), in_chars: text.length, out_chars: out.length }));
'''
open("/tmp/redact-run.ts", "w").write(script)
res = subprocess.run(["mise", "exec", "bun@1.4.4", "--", "bun", "run", "/tmp/redact-run.ts"],
                     capture_output=True, text=True)
if res.returncode != 0:
    print("BUN FAILED:", res.stderr[-500:]); sys.exit(1)
timing = json.loads(res.stdout.strip().split("\n")[-1])

out = open("/tmp/redact-out.diff", encoding="utf8").read()

leaks = [n for n, v in SECRETS.items() if v in out]
destroyed = [n for n, v in KEEPS.items() if v not in out]
# Also: how much of the original diff survived byte-for-byte outside the probe lines?
base_in_out = sum(1 for line in base.split("\n") if line in out)
base_total = len([l for l in base.split("\n") if l])

report = {
    "base_lines": base_total,
    "base_chars": len(base),
    "timing_ms": timing["ms"],
    "chars_in": timing["in_chars"],
    "chars_out": timing["out_chars"],
    "secrets_injected": len(SECRETS),
    "secrets_leaked": leaks,
    "near_misses": len(KEEPS),
    "near_misses_destroyed": destroyed,
    "base_lines_preserved": f"{base_in_out}/{base_total}",
    "base_line_survival_pct": round(100 * base_in_out / base_total, 2),
}
print(json.dumps(report, indent=2))
json.dump(report, open("/tmp/redact-scale.json", "w"), indent=2)
PY
