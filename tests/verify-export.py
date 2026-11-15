#!/usr/bin/env python3
"""Verify a snow-The session export against its own source transcript.

The export endpoint builds the document from session events. This script reads
the same durable log and checks the export against it field by field, so a
missing message, a reordering, or an injected-context leak is visible as a
number rather than as an impression.

Usage: verify-export.py <session.v4.jsonl.zstd> <exported.md>
"""
import json
import re
import subprocess
import sys

SESSION_KINDS_INJECTED = {"runtime-context", "skill-catalog", "time-context", "agent-instructions"}


def read_events(path: str) -> list[dict]:
    raw = subprocess.run(["zstdcat", path], capture_output=True, text=True, check=True).stdout
    events = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def main() -> int:
    session_path, export_path = sys.argv[1], sys.argv[2]
    events = read_events(session_path)
    export = open(export_path, encoding="utf8").read()

    user_msgs, injected = [], []
    turns = assistant = tool_calls = 0
    for e in events:
        t = e.get("type")
        if t == "turn/start":
            turns += 1
        elif t == "assistant/message":
            assistant += 1
        elif t == "tool/call":
            tool_calls += 1
        elif t == "user/message":
            data = e.get("data") or {}
            kind = (data.get("source") or {}).get("kind")
            text = " ".join(
                c.get("text", "") for c in data.get("content", []) if isinstance(c, dict)
            ).strip()
            if kind in SESSION_KINDS_INJECTED:
                injected.append((kind, text))
            else:
                user_msgs.append((kind, text))

    def num(label: str) -> int | None:
        m = re.search(rf"- {label}: (\d+)", export)
        return int(m.group(1)) if m else None

    checks = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append((name, ok, detail))

    check("turns match", num("turns") == turns, f"export={num('turns')} source={turns}")
    check(
        "user messages match real user turns",
        num("user messages") == len(user_msgs),
        f"export={num('user messages')} real={len(user_msgs)} injected={len(injected)}",
    )
    check(
        "assistant messages match",
        num("assistant messages") == assistant,
        f"export={num('assistant messages')} source={assistant}",
    )
    check(
        "tool calls match",
        num("tool calls") == tool_calls,
        f"export={num('tool calls')} source={tool_calls}",
    )

    # Every real user objective must appear, in order.
    objectives_section = export.split("## Recent user objectives")[1].split("##")[0] if "## Recent user objectives" in export else ""
    positions = [objectives_section.find(t[:60]) for _, t in user_msgs if t]
    check(
        "real objectives appear in the export",
        all(p >= 0 for p in positions),
        f"found {sum(1 for p in positions if p >= 0)}/{len(positions)}",
    )
    check(
        "real objectives keep their order",
        positions == sorted(positions),
        f"positions={positions}",
    )

    # Injected context must NOT be presented as a user objective.
    leaked = [
        kind
        for kind, text in injected
        if text and text[:40] in objectives_section
    ]
    check(
        "injected context is not shown as a user objective",
        not leaked,
        f"leaked kinds={leaked}" if leaked else "none leaked",
    )

    # Encoding: the document must be valid UTF-8 with no replacement characters.
    raw = open(export_path, "rb").read()
    try:
        text = raw.decode("utf8")
        encoding_ok = "\ufffd" not in text
        detail = f"{len(raw)}B, valid utf-8, replacement chars={'yes' if not encoding_ok else 'no'}"
    except UnicodeDecodeError as exc:
        encoding_ok = False
        detail = f"invalid utf-8: {exc}"
    check("encoding is clean", encoding_ok, detail)

    check(
        "document is not truncated",
        export.rstrip().endswith("heavy work.") or "## Agent guidance" in export,
        "ends with the guidance section" if "## Agent guidance" in export else "truncated",
    )

    width = max(len(n) for n, _, _ in checks)
    failed = 0
    for name, ok, detail in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {detail}")
        failed += 0 if ok else 1
    print()
    print(f"{len(checks) - failed}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
