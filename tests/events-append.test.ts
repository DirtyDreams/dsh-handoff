import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffStore } from "../src/store";

/**
 * A crash between write() and the trailing newline leaves a truncated last line.
 * The reader tolerates that by skipping the malformed line, which is correct —
 * but the writer must not append straight onto it, or the next event is spliced
 * into the broken record and both disappear. This is the case a kill during an
 * append produces, and it is invisible without a direct test.
 */

const store = () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-events-"));
	return { root, events: join(root, "events.jsonl"), s: new HandoffStore(root) };
};

describe("events.jsonl append", () => {
	test("appends normally when the file ends on a boundary", () => {
		const { events, s } = store();
		s.appendEvent({ sessionId: "s", turn: 1, type: "turn_end", excerpts: [{ role: "user", text: "a" }] });
		s.appendEvent({ sessionId: "s", turn: 2, type: "turn_end", excerpts: [{ role: "user", text: "b" }] });
		const lines = readFileSync(events, "utf8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
	});

	test("a truncated tail line does not swallow the next event", () => {
		const { events, s } = store();
		s.appendEvent({ sessionId: "s", turn: 1, type: "turn_end", excerpts: [{ role: "user", text: "first" }] });
		// Simulate a crash mid-append: no trailing newline, line is incomplete.
		writeFileSync(events, readFileSync(events, "utf8") + '{"schemaVersion":2,"seq":9,"type":"turn_en');
		s.appendEvent({ sessionId: "s", turn: 2, type: "turn_end", excerpts: [{ role: "user", text: "second" }] });
		const lines = readFileSync(events, "utf8").split("\n").filter(Boolean);
		// The truncated line is still broken (we never rewrite history), but the
		// new event must be its own parsable record.
		const parsable = lines.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		});
		const healthy = parsable.filter(Boolean) as Array<{ type: string; excerpts?: Array<{ text: string }> }>;
		const second = healthy.find((e) => e.excerpts?.some((x) => x.text === "second"));
		expect(second).toBeDefined();
	});

	test("an empty or missing file is written cleanly", () => {
		const { events, s } = store();
		s.appendEvent({ sessionId: "s", turn: 1, type: "turn_end", excerpts: [{ role: "user", text: "x" }] });
		const text = readFileSync(events, "utf8");
		expect(text.startsWith("{")).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
	});
});
