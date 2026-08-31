import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	HANDOFF_CONTEXT_TEMPLATE,
	HANDOFF_CONTEXT_VARIABLE,
	Injector,
} from "../src/injector";
import { HandoffStore } from "../src/store";

type PromptAssembly = {
	sections: Array<{ name: string; text: string }>;
	contexts: Array<{ name: string; text: string }>;
	tools: unknown[];
	variables: Record<string, string | undefined>;
};

async function loadSystemPrompt(): Promise<{
	renderContextSnapshot(assembly: PromptAssembly): string;
}> {
	const candidates = [
		process.env.DSH_SYSTEM_PROMPT_MODULE,
		"@deepseek-ai/dsh-system-prompt",
		join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
	].filter((candidate): candidate is string => !!candidate);
	for (const candidate of candidates) {
		try {
			return await import(candidate);
		} catch (error) {
			if (candidate === candidates.at(-1)) throw error;
		}
	}
	throw new Error("dsh-system-prompt is required for runtime-context tests");
}

const { renderContextSnapshot } = await loadSystemPrompt();

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("handoff runtime context", () => {
	test("contributes no snapshot when an agent has no handoff", () => {
		expect(renderContextSnapshot({
			sections: [],
			contexts: [{ name: "handoff", text: HANDOFF_CONTEXT_TEMPLATE }],
			tools: [],
			variables: { [HANDOFF_CONTEXT_VARIABLE]: "" },
		})).toBe("");
	});

	test("preserves literal double-brace code under strict prompt interpolation", () => {
		const temporaryRoot = mkdtempSync(join(tmpdir(), "dsh-handoff-context-"));
		temporaryRoots.push(temporaryRoot);
		const branchRoot = join(temporaryRoot, "project", "main");
		mkdirSync(branchRoot, { recursive: true });

		const literal = "[]auth.PermissionRequirement{{Priv: auth.ADMINPRIV_*, Requirement: auth.READ_ONLY}}";
		writeFileSync(join(branchRoot, "handoff.md"), `# Current Goal\n\nRemember this code: ${literal}\n`);
		const injector = new Injector(new HandoffStore(branchRoot));
		const handoffText = injector.getText();

		// This is the exact failure mode introduced by strict interpolation in
		// dsh-system-prompt 0.1.1: treating handoff text as a template is invalid.
		expect(() => renderContextSnapshot({
			sections: [],
			contexts: [{ name: "handoff", text: handoffText }],
			tools: [],
			variables: {},
		})).toThrow("malformed prompt variable reference");

		const rendered = renderContextSnapshot({
			sections: [],
			contexts: [{ name: "handoff", text: HANDOFF_CONTEXT_TEMPLATE }],
			tools: [],
			variables: { [HANDOFF_CONTEXT_VARIABLE]: handoffText },
		});

		expect(rendered).toContain(literal);
		expect(rendered).toContain(handoffText);
	});
});
