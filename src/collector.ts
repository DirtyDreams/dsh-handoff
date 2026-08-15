/**
 * Collector — turns DSH session events into redacted, bounded turn_end records.
 *
 * Performs NO semantic judgment: decisions/progress extraction is the
 * refresher's job. Everything the collector does is deterministic.
 *
 * DSH emits an append-only event log (see @deepseek-ai/dsh-session
 * SessionEventMap). The collector subscribes to `session/event` via the host
 * plugin and folds one turn's worth of `user/message`, `assistant/message`,
 * `tool/call`, and `tool/result` events into a single `turn_end` HandoffEvent
 * when the turn closes. Only direct human prompts (source.kind === "user")
 * are collected as user excerpts, so injected runtime-context snapshots,
 * compaction checkpoints, and tool/relay messages never echo back into the
 * handoff.
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { redact } from "./redact";
import type { HandoffEvent, HandoffStore } from "./store";

const USER_EXCERPT_MAX = 2_000;
const ASSISTANT_EXCERPT_MAX = 2_000;
const TOOL_EXCERPT_MAX = 500;
const TOOL_ARGS_DIGEST_MAX = 160;
/** A single turn may contain hundreds of tool results. Bound the durable event
 * itself so one pathological turn never relies on prompt-level head/tail loss. */
const TURN_EXCERPTS_MAX = 12_000;
const CHANGED_FILES_MAX = 200;

/** DSH tool names that mutate files on disk; their `file_path`/`path` argument
 * is recorded as a changed file when the call succeeds. */
const WRITE_TOOLS = new Set(["write", "edit", "str_replace_editor", "multi_edit", "notebook_edit"]);

type Excerpt = NonNullable<HandoffEvent["excerpts"]>[number];

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + `… [+${text.length - max} chars]`;
}

/** Flatten message content blocks to text parts, skipping images/thinking/tool blocks. */
function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as ContentBlock).type === "text" && typeof (part as { text: unknown }).text === "string") {
			out.push((part as { text: string }).text);
		}
	}
	return out;
}

/** Pull the text out of a tool-result block's nested content. */
function toolResultText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (block && typeof block === "object" && (block as ContentBlock).type === "tool-result") {
			const inner = (block as { content?: unknown }).content;
			return textParts(inner).join("\n").trim();
		}
	}
	return "";
}

/** One-line digest for an assistant tool-call content block. */
function toolCallDigests(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "tool-call") continue;
		const name = (block as unknown as { name?: string }).name ?? "tool";
		// DSH tool-call `arguments` is already a raw JSON string.
		const rawArgs = (block as unknown as { arguments?: string }).arguments ?? "";
		const args = truncate(redact(typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {})), TOOL_ARGS_DIGEST_MAX);
		out.push(`→ ${name} ${args}`);
	}
	return out;
}

/** Extract a write tool's target path from its raw JSON arguments string. */
function writeTargetPath(name: string, argumentsJson: string): string | undefined {
	if (!WRITE_TOOLS.has(name)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(argumentsJson);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const args = parsed as Record<string, unknown>;
	const path = (typeof args.file_path === "string" && args.file_path) || (typeof args.path === "string" && args.path) || (typeof args.path_str === "string" && args.path_str) || undefined;
	return path || undefined;
}

export class Collector {
	/** Excerpts accumulated for the in-flight turn, in arrival order. */
	private excerpts: Excerpt[] = [];
	/** callId → tool name + target path for write/edit calls awaiting their result. */
	private toolStartPaths = new Map<string, { name: string; path: string }>();
	/** Paths mutated by successful write/edit calls in this turn. */
	private turnChangedFiles = new Set<string>();
	private currentTurn = 0;

	constructor(private store: HandoffStore, private sessionId: string) {}

	/** Dispatch one DSH session event. Returns the appended turn_end event on a
	 * `turn/end`, otherwise undefined. */
	onEvent(event: SessionEvent): HandoffEvent | undefined {
		switch (event.type) {
			case "turn/start":
				this.resetTurn(event.data.turn);
				return undefined;
			case "turn/end":
				return this.flush(event.data.turn);
			case "user/message": {
				const msg = event.data as unknown as { content?: unknown; source?: { kind?: string } };
				if (msg.source?.kind !== "user") return undefined; // skip injected context, relays, tool results, checkpoints
				const text = redact(textParts(msg.content).join("\n").trim());
				if (text) this.excerpts.push({ role: "user", text: truncate(text, USER_EXCERPT_MAX) });
				return undefined;
			}
			case "assistant/message": {
				const msg = (event.data as unknown as { message?: { content?: unknown } }).message;
				if (!msg) return undefined;
				for (const t of textParts(msg.content)) {
					const red = redact(t.trim());
					if (red) this.excerpts.push({ role: "assistant", text: truncate(red, ASSISTANT_EXCERPT_MAX) });
				}
				for (const line of toolCallDigests(msg.content)) {
					this.excerpts.push({ role: "assistant", text: line });
				}
				return undefined;
			}
			case "tool/call": {
				const data = event.data as unknown as { callId: string; name: string; arguments: string };
				const path = writeTargetPath(data.name, data.arguments);
				if (path) this.toolStartPaths.set(data.callId, { name: data.name, path });
				return undefined;
			}
			case "tool/result": {
				const data = event.data as unknown as { message: unknown; error?: unknown };
				const text = truncate(redact(toolResultText(data.message) || "(no text output)"), TOOL_EXCERPT_MAX);
				const isError = !!data.error;
				// Confirm a tracked write/edit call succeeded → record the changed file.
				const toolCallId = this.toolResultCallId(data.message);
				if (toolCallId) {
					const tracked = toolCallId ? this.toolStartPaths.get(toolCallId) : undefined;
					if (tracked && !isError) this.turnChangedFiles.add(tracked.path);
					if (tracked) this.toolStartPaths.delete(toolCallId);
				}
				this.excerpts.push({ role: "tool", text: isError ? `[error] ${text}` : text });
				return undefined;
			}
			default:
				return undefined;
		}
	}

	private toolResultCallId(message: unknown): string | undefined {
		if (!message || typeof message !== "object") return undefined;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) return undefined;
		for (const block of content) {
			if (block && typeof block === "object" && (block as ContentBlock).type === "tool-result") {
				return (block as unknown as { toolCallId?: string }).toolCallId;
			}
		}
		return undefined;
	}

	private resetTurn(turn: number): void {
		this.currentTurn = turn;
		this.excerpts = [];
		this.toolStartPaths.clear();
		this.turnChangedFiles.clear();
	}

	/** Assemble + append one redacted turn_end event. */
	private flush(turn: number): HandoffEvent {
		const excerpts = this.excerpts;

		let keptChars = 0;
		const bounded: Excerpt[] = [];
		for (const excerpt of excerpts) {
			const remaining = TURN_EXCERPTS_MAX - keptChars;
			if (remaining <= 0) break;
			const marker = "… [turn excerpt capped]";
			const text = excerpt.text.length <= remaining
				? excerpt.text
				: remaining > marker.length
					? excerpt.text.slice(0, remaining - marker.length) + marker
					: excerpt.text.slice(0, remaining);
			bounded.push({ ...excerpt, text });
			keptChars += text.length;
		}
		if (bounded.length < excerpts.length) {
			bounded.push({ role: "tool", text: `[${excerpts.length - bounded.length} additional excerpts omitted from this turn]` });
		}

		const changedFiles = [...this.turnChangedFiles].slice(0, CHANGED_FILES_MAX);
		this.resetTurn(turn);

		return this.store.appendEvent({
			sessionId: this.sessionId,
			turn,
			type: "turn_end",
			excerpts: bounded,
			changedFiles,
		});
	}
}
