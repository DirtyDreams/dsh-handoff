/**
 * Injector — assembles the handoff.md + shared project knowledge + pinned
 * rules into one stable text block and hands it to the host, which registers
 * it as a DSH dynamic runtime-context contribution
 * (`ctx.systemPrompt.context()`).
 *
 * DSH materializes runtime-context contributions as a durable user-role
 * SNAPSHOT that the agent loop change-gates: an identical rendering produces
 * no new event, so a stable handoff costs nothing per step, and a changed
 * rendering supersedes the earlier snapshot. That is the same shape and the
 * same rationale as pi-handoff's frozen `context` injection: keep the block
 * stable across requests (prompt-cache friendly) and rebuild it only when the
 * document genuinely changes.
 *
 * The text is a per-session snapshot rather than a fresh read — see `frozen`
 * below for why that is a large token saving and costs nothing.
 */

import { readFileSync, statSync } from "node:fs";
import { HANDOFF_CAP_CHARS, PROJECT_KNOWLEDGE_CAP_CHARS, HandoffStore } from "./store";

/**
 * Handoff text is untrusted prompt data, not a prompt template.  Route it
 * through a variable because DSH substitutes variable values without scanning
 * them again for `{{...}}` references.  This preserves literal code snippets
 * in handoff.md while keeping the context template itself valid.
 */
export const HANDOFF_CONTEXT_VARIABLE = "dsh_handoff_context";
export const HANDOFF_CONTEXT_TEMPLATE = `{{${HANDOFF_CONTEXT_VARIABLE}}}`;

interface CacheEntry {
	mtimeMs: number;
	size: number;
	ino: number;
	text: string;
}

export class Injector {
	private cache = new Map<string, CacheEntry>();

	/**
	 * Session-stable snapshot of the injected text.
	 *
	 * The runtime-context snapshot sits early in the provider's cached prefix.
	 * Rebuilding it per request means every background fold rewrites that
	 * prefix, invalidating the prompt cache for the WHOLE conversation —
	 * re-paying full input price for every earlier message, which costs far
	 * more than the fold that caused it. Between folds the text is identical
	 * anyway, so the rebuild bought nothing and the cache miss was pure loss.
	 *
	 * So it is built once and frozen for the session. Nothing is lost by going
	 * stale: the model lived through the turns a fold summarises, so
	 * re-injecting them tells it what it already knows. `invalidate()` is
	 * called only where the frozen text genuinely stops matching the
	 * conversation — after a clear, a branch switch, or a successful refresh
	 * (the document it described has changed). DSH's change-gated snapshot
	 * emission means a frozen stable text produces no per-step event, and an
	 * invalidated rebuild supersedes the earlier snapshot exactly once.
	 */
	private frozen: string | null = null;

	constructor(private store: HandoffStore) {}

	/** Drop the snapshot so the next request rebuilds it from disk. */
	invalidate(): void {
		this.frozen = null;
	}

	private readFresh(path: string): string {
		try {
			const st = statSync(path);
			const hit = this.cache.get(path);
			if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) return hit.text;
			const text = readFileSync(path, "utf8");
			this.cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, text });
			return text;
		} catch {
			return "";
		}
	}

	/** Build the snapshot text, or return "" when there is nothing worth injecting. */
	private buildText(): string {
		const handoff = this.readFresh(this.store.handoffPath);
		const projectKnowledge = this.store.readProjectKnowledge();
		const pins = this.store.pinnedNotes();
		if (!HandoffStore.hasRealContent(handoff) && !HandoffStore.hasRealContent(projectKnowledge) && pins.length === 0) return "";

		const body =
			handoff.length <= HANDOFF_CAP_CHARS
				? handoff.trim()
				: handoff.slice(0, HANDOFF_CAP_CHARS) + `\n\n[...truncated by handoff — full content in ${this.store.handoffPath}]`;

		const projectForContext = projectKnowledge.length <= PROJECT_KNOWLEDGE_CAP_CHARS
			? projectKnowledge
			: projectKnowledge.slice(0, PROJECT_KNOWLEDGE_CAP_CHARS) + `\n\n[...project knowledge truncated; full content in ${this.store.projectDocPath}]`;
		const project = HandoffStore.hasRealContent(projectKnowledge)
			? `\n\n<project-knowledge file="${this.store.projectDocPath}">\n${projectForContext}\n</project-knowledge>`
			: "";
		const pinned = pins.length ? `\n\n<pinned-rules>\n${pins.join("\n")}\n</pinned-rules>` : "";

		return `The branch handoff and shared project knowledge follow. The branch handoff describes current task state. Project knowledge describes durable architecture, conventions, workflows, decisions, and pitfalls shared by every branch. Pinned rules are user-managed hard constraints. Use all three as authoritative prior context; do not confuse project-wide knowledge with current branch progress.

<branch-handoff file="${this.store.handoffPath}">

${body}

</branch-handoff>${project}${pinned}`;
	}

	/** Return the frozen snapshot text, building it on first use; "" when empty. */
	getText(): string {
		if (this.frozen !== null) return this.frozen;
		const text = this.buildText();
		// Only a non-empty build is frozen: a session that starts with an empty
		// handoff must keep looking until there is something to inject.
		if (text) this.frozen = text;
		return text;
	}
}
