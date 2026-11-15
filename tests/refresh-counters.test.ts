import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffStore } from "../src/store";

/**
 * Auto-refresh fires on `turnsSinceRefresh >= thresholdTurns`. That counter is
 * derived state, not a meta field, so a store reopened by a *new process* must
 * rebuild it from the durable log — otherwise every CLI invocation starts at 0
 * and a session spread over many short-lived processes never refreshes at all,
 * no matter how many turns it collected.
 */

const fresh = () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-counts-"));
	const store = new HandoffStore(root, "/repo", "main");
	store.initSync();
	for (let i = 1; i <= 12; i++) {
		store.appendEvent({ sessionId: "s", turn: i, type: "turn_end", excerpts: [{ role: "user", text: `turn ${i} ` + "x".repeat(50) }] });
	}
	return { root, store };
};

describe("refresh counters across processes", () => {
	test("a reopened store rebuilds turnsSinceRefresh from the log", () => {
		const { root } = fresh();
		const reopened = new HandoffStore(root, "/repo", "main");
		reopened.initSync();
		expect(reopened.turnsSinceRefresh).toBe(12);
	});

	test("a reopened store rebuilds pendingChars from the log", () => {
		const { root, store } = fresh();
		const before = store.pendingChars;
		expect(before).toBeGreaterThan(0);
		const reopened = new HandoffStore(root, "/repo", "main");
		reopened.initSync();
		expect(reopened.pendingChars).toBe(before);
	});

	test("a refreshed log yields zero pending turns", () => {
		const { root, store } = fresh();
		const last = store.readEventsSince(-1).at(-1)!;
		store.markRefreshed(last.seq);
		const reopened = new HandoffStore(root, "/repo", "main");
		reopened.initSync();
		expect(reopened.turnsSinceRefresh).toBe(0);
		expect(reopened.pendingChars).toBe(0);
	});

	test("an empty store still starts at zero", () => {
		const root = mkdtempSync(join(tmpdir(), "handoff-empty-"));
		const store = new HandoffStore(root, "/repo", "main");
		store.initSync();
		expect(store.turnsSinceRefresh).toBe(0);
		expect(store.pendingChars).toBe(0);
	});
});
