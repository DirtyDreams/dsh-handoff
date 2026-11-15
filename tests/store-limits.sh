#!/usr/bin/env bash
# Store limits, measured in action rather than read from constants:
#   1. handoff.md at/over HANDOFF_CAP_CHARS — oversized writes must be refused
#      cleanly, not corrupt the file
#   2. events.jsonl over EVENTS_MAX_LINES — trimming must drop folded events,
#      leave every remaining line parsable, and keep pending (unfolded) work
set -uo pipefail
cd /home/coyote/Work/dsh-handoff || exit 1
OUT=/tmp/store-limits.json

python3 - <<'PY'
import json, os, subprocess, sys, tempfile

probe = r'''
import { HandoffStore } from "/home/coyote/Work/dsh-handoff/src/store.ts";
import { HANDOFF_CAP_CHARS } from "/home/coyote/Work/dsh-handoff/src/store.ts";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out: any = { cap: HANDOFF_CAP_CHARS };
const root = mkdtempSync(join(tmpdir(), "limits-"));
const store = new HandoffStore(root, "/repo", "main");
store.initSync();

// --- 1. handoff.md cap -------------------------------------------------------
const under = "# Current Goal\n\n" + "a".repeat(HANDOFF_CAP_CHARS - 60);
let acceptedUnder = false, errUnder = null;
try { store.writeHandoff(under, { snapshot: false }); acceptedUnder = true; } catch (e) { errUnder = String(e).slice(0, 120); }
out.under_cap = { accepted: acceptedUnder, error: errUnder, bytes: existsSync(store.handoffPath) ? readFileSync(store.handoffPath, "utf8").length : 0 };

const over = "# Current Goal\n\n" + "b".repeat(HANDOFF_CAP_CHARS + 5000);
let acceptedOver = false, errOver = null;
try { store.writeHandoff(over, { snapshot: false }); acceptedOver = true; } catch (e) { errOver = String(e).slice(0, 120); }
out.over_cap = { accepted: acceptedOver, error: errOver, bytes: existsSync(store.handoffPath) ? readFileSync(store.handoffPath, "utf8").length : 0 };
// The file must still hold the last good content, not a truncated write.
out.after_reject_intact = existsSync(store.handoffPath) && readFileSync(store.handoffPath, "utf8").length === out.under_cap.bytes;

// --- 2. events.jsonl trim ----------------------------------------------------
// Fold everything, then overflow the line budget with already-folded events.
store.writeHandoff("# Current Goal\n\nsmall", { snapshot: false });
for (let i = 1; i <= 40; i++) {
  store.appendEvent({ sessionId: "s", turn: i, type: "turn_end", excerpts: [{ role: "user", text: "folded " + i }] });
}
const last = store.readEventsSince(-1).at(-1)!;
store.markRefreshed(last.seq);
// Two live (pending) turns that must survive trimming.
store.appendEvent({ sessionId: "s", turn: 41, type: "turn_end", excerpts: [{ role: "user", text: "PENDING-A" }] });
store.appendEvent({ sessionId: "s", turn: 42, type: "turn_end", excerpts: [{ role: "user", text: "PENDING-B" }] });

const beforeLines = readFileSync(store.eventsPath, "utf8").split("\n").filter(Boolean).length;
// Force overflow past 1000 lines.
for (let i = 43; i <= 1100; i++) {
  store.appendEvent({ sessionId: "s", turn: i, type: "turn_end", excerpts: [{ role: "user", text: "bulk " + i }] });
}
const raw = readFileSync(store.eventsPath, "utf8");
const lines = raw.split("\n").filter(Boolean);
let bad = 0;
for (const line of lines) { try { JSON.parse(line); } catch { bad++; } }
const text = raw;
out.events = {
  lines_before_overflow: beforeLines,
  lines_after: lines.length,
  max_lines: 1000,
  parsable: lines.length - bad,
  broken: bad,
  // Design: when pending work alone overflows the budget, the OLDEST pending
  // records are dropped and a marker states how many — visible loss, not silent.
  // The newest pending turn must always survive, since it is the one the next
  // refresh will fold.
  newest_pending_survived: text.includes("bulk 1100"),
  oldest_pending_dropped: !text.includes("PENDING-A"),
  marker_present: /were dropped to keep events\.jsonl/.test(text),
  marker_count: (() => {
    const line = text.split("\n").find((l: string) => l.includes("were dropped"));
    if (!line) return null;
    const m = /\[(\d+) older pending/.exec(line);
    return m ? Number(m[1]) : null;
  })(),
  meta_event_line_count_matches: store.meta.eventLineCount === lines.length,
};

console.log(JSON.stringify(out, null, 2));
'''
open("/tmp/limits-probe.ts", "w").write(probe)
res = subprocess.run(["mise", "exec", "bun@1.4.4", "--", "bun", "run", "/tmp/limits-probe.ts"],
                     capture_output=True, text=True)
if res.returncode != 0:
    print("PROBE FAILED"); print(res.stderr[-1200:]); sys.exit(1)
print(res.stdout)
open("/tmp/store-limits.json", "w").write(res.stdout)
PY
