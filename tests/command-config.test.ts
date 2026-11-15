import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The `command` field decides which slash command the plugin registers. It only
 * works if the field exists in the composed schema: schemastery silently strips
 * unknown keys, so a field present in `src` but missing from the built bundle
 * reads as configured and does nothing. That failure is invisible at runtime,
 * which is why it is asserted here against the shipped artifact rather than
 * only against the source.
 */

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("command config field", () => {
	test("the shipped bundle declares `command` in its schema", () => {
		const lib = read("lib/index.js");
		const schemaStart = lib.indexOf("Env: HANDOFF_DEBUG");
		expect(schemaStart).toBeGreaterThan(-1);
		// The schema object ends right after its last field; look in that window.
		const window = lib.slice(schemaStart, schemaStart + 400);
		expect(window).toContain("command:");
		expect(window).toContain("handoff-memory");
	});

	test("the source and the bundle agree on the default", () => {
		const src = read("src/index.ts");
		expect(src).toContain('.default("handoff-memory")');
		const lib = read("lib/index.js");
		expect(lib).toContain('(config.command || "handoff-memory")');
	});

	test("the registered command name comes from config, not a literal", () => {
		const lib = read("lib/index.js");
		expect(lib).toContain("name: COMMAND_NAME");
		// A literal here would mean the config is decorative.
		expect(lib).not.toContain('name: "handoff-memory"');
	});
});
