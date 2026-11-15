/**
 * dsh-handoff — a self-maintaining handoff.md per project + git branch for
 * DeepSeek Harness, stored outside the project.
 *
 * Each project gets its own store under ~/.agent/agent-handoff/, named after
 * the project root's absolute path (see resolveProjectRoot) — the git repo /
 * worktree top-level when the working directory is inside a repo, so opening
 * from a subdirectory of the same repo lands on the SAME store; outside git
 * the working directory itself is the key. Each git branch gets its own
 * subdirectory within it. Nothing is written into the repository itself.
 *
 * The on-disk layout is byte-identical to pi-handoff's, so the two agents
 * share one store at ~/.agent/agent-handoff and read each other's handoff.md,
 * project.md, and events.jsonl. Switching from pi to DeepSeek Harness (or
 * running both) reuses the existing handoff files with no migration.
 *
 *   events.jsonl   append-only log, written by the collector (no LLM)
 *   handoff.md     the document, refreshed in the background as work happens
 *   project.md     shared project knowledge + pinned rules, one per project
 *
 * Recall: every model request gets the current document injected as a DSH
 * runtime-context snapshot (change-gated, so a stable handoff costs nothing
 * per step and a changed one supersedes the earlier snapshot exactly once).
 *
 * The agent curates the shared project.md itself through the `handoff` tool
 * (status|flush|project_propose|pin|unpin). The user-only `/handoff` command
 * adds clear / pause / resume / project review on top.
 *
 * Pausing is session-scoped and in-memory: while paused nothing is collected,
 * so the paused stretch leaves no trace to filter out later, while injection
 * keeps working so the agent still READS the existing documents. Work buffered
 * before the pause survives and folds in after `/handoff resume`.
 *
 * Only top-level agents (not subagents) adopt a store, collect, and inject —
 * subagents are isolated short-lived workers and sharing one events.jsonl
 * with the parent would only contend on its lock.
 *
 * Commands: /handoff status|flush|project|pin|unpin|clear|pause|resume
 * Tool:     handoff(status|flush|project_propose|pin|unpin) — agent-callable
 * Env:      HANDOFF_MODEL=provider/id  HANDOFF_THRESHOLD_CHARS=24000
 *           HANDOFF_THRESHOLD_TURNS=20  HANDOFF_DIR=<dir>  HANDOFF_DEBUG=1
 *           (PI_HANDOFF_* aliases are honored for parity with pi-handoff.)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import type { AssembleContext } from "@deepseek-ai/dsh-system-prompt";
import { defineTool } from "@deepseek-ai/dsh-tools";
// Type-only imports that also apply each package's `declare module '@deepseek-ai/cordis'`
// Context augmentations (ctx.commands, ctx.skills) without pulling runtime side effects.
import type { CommandRuntime } from "@deepseek-ai/dsh-commands";
import type { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { Collector } from "./collector";
import { HANDOFF_CONTEXT_TEMPLATE, HANDOFF_CONTEXT_VARIABLE, Injector } from "./injector";
import { redact } from "./redact";
import {
	HandoffStore,
	PROJECT_KNOWLEDGE_CAP_CHARS,
	PROJECT_SECTIONS,
	listBranchDocs,
	migrateProjectKey,
	orphanSubdirStores,
	storeHome,
	type ProjectCandidate,
	type ProjectSection,
} from "./store";
import { runProjectExtraction, runRefresh, type ModelCtx } from "./summarizer";

export const name = "handoff";
export const inject = ["agents", "systemPrompt", "llm", "tools"];

export const Config = z.object({
	dir: z.string().default("").description("Override the store root (default ~/.agent/agent-handoff). Env: HANDOFF_DIR / PI_HANDOFF_DIR."),
	model: z.string().default("").description('Override the summarizer model as "provider/model-id". Env: HANDOFF_MODEL / PI_HANDOFF_MODEL.'),
	thresholdChars: z.number().default(24_000).description("Auto-refresh once this many new excerpt chars accumulate. Env: HANDOFF_THRESHOLD_CHARS."),
	thresholdTurns: z.number().default(20).description("Auto-refresh every this many turns (0 = chars only). Env: HANDOFF_THRESHOLD_TURNS."),
	maxTokens: z.number().default(16_384).description("Max output tokens for one summarizer call. Env: HANDOFF_MAX_TOKENS."),
	debug: z.boolean().default(false).description("Log refresh/extraction diagnostics to stderr. Env: HANDOFF_DEBUG / PI_HANDOFF_DEBUG."),
	command: z
		.string()
		.default("handoff-memory")
		.description("Slash-command name to register. Defaults to handoff-memory so it cannot collide with another plugin's /handoff."),
});

/** Resolved plugin configuration (mirrors {@link Config}). */
interface HandoffConfig {
	dir: string;
	model: string;
	thresholdChars: number;
	thresholdTurns: number;
	maxTokens: number;
	debug: boolean;
	command: string;
}

/** Character ceiling: force an early refresh once this many new chars accumulate. */
let CHAR_THRESHOLD = 24_000;
/** Turn backstop: auto-refresh every this many turns. 0 disables it (chars only). */
let TURN_THRESHOLD = 20;
let HANDOFF_MODEL = "";
/** Registered slash-command name; kept distinct from dsh-session-handoff's /handoff. */
let COMMAND_NAME = "handoff-memory";
let MAX_TOKENS = 16_384;
const REFRESH_TIMEOUT_MS = 120_000;
/** Each handoff contributes at most 8k chars to extraction; five stay below the
 * 48k model-input cap with room for existing knowledge and prompt framing. */
const PROJECT_SCAN_BRANCHES_PER_BATCH = 5;

function shouldAutoRefresh(chars: number, turns: number): boolean {
	return (TURN_THRESHOLD > 0 && turns >= TURN_THRESHOLD) || chars >= CHAR_THRESHOLD;
}

/** True if a process with `pid` is still running (best-effort: false if dead or unknown). */
function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
}

/** cwd -> project root cache: repo membership of a directory doesn't change mid-session. */
const projectRootCache = new Map<string, string>();

/** Nearest ancestor of `cwd` (inclusive) containing a `.git` entry, or null. */
function findGitRoot(cwd: string): string | null {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** The identity of "the project": the git repo/worktree top-level when `cwd`
 * is inside one, else `cwd` itself. Cached per cwd. */
export function resolveProjectRoot(cwd: string): string {
	const hit = projectRootCache.get(cwd);
	if (hit) return hit;
	const gitRoot = findGitRoot(cwd);
	let root = gitRoot ?? cwd;
	if (!gitRoot) {
		try {
			const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
				encoding: "utf8",
				timeout: 2000,
			}).trim();
			if (top) root = top;
		} catch {
			// not a repo — the working directory itself is the project
		}
	}
	projectRootCache.set(cwd, root);
	return root;
}

/** Best-effort current git branch of `cwd`. Returns "default" when not in a repo
 * or on any error, and "detached-<short-sha>" for detached HEAD. */
export function detectBranch(cwd: string, fallback = "default"): string {
	const run = (args: string[]) =>
		execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 2000 }).trim();
	try {
		let ref = "";
		try {
			ref = run(["symbolic-ref", "-q", "HEAD"]);
		} catch {
			// detached
		}
		if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
		if (ref) return ref.replace(/^refs\//g, "");
		try {
			const sha = run(["rev-parse", "--short", "HEAD"]);
			return sha ? `detached-${sha}` : fallback;
		} catch {
			return fallback;
		}
	} catch {
		return fallback;
	}
}

/** Current local and remote branch names. Null means detection failed. */
function activeGitBranches(cwd: string): Set<string> | null {
	try {
		const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			timeout: 3_000,
		});
		const branches = new Set<string>();
		for (const ref of refs.split("\n").map((line) => line.trim()).filter(Boolean)) {
			if (ref.startsWith("refs/heads/")) branches.add(ref.slice("refs/heads/".length));
			else if (ref.startsWith("refs/remotes/")) {
				const name = ref.slice("refs/remotes/".length).replace(/^[^/]+\//, "");
				if (name && name !== "HEAD") branches.add(name);
			}
		}
		return branches;
	} catch {
		return null;
	}
}

const kb = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}k`);
const fsSize = (path: string) => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

// ---------------------------------------------------------------------------
// Per-agent state
// ---------------------------------------------------------------------------

interface AgentHandoff {
	agent: Agent;
	store: HandoffStore;
	collector: Collector;
	injector: Injector;
	branch: string;
	paused: boolean;
	busy: boolean;
	inFlight: Promise<unknown> | null;
	errors: number;
	lastModel: string | null;
	activeAbort: AbortController | null;
}

const agents = new Map<string, AgentHandoff>();
let debug = false;
let llmRuntime: LlmRuntime | null = null;

const dbg = (msg: string) => {
	if (debug) console.error(`[handoff] ${msg}`);
};

/** A subagent (delegationDepth > 0 or origin 'subagent') is isolated and does
 * not adopt a store — it would only contend on the parent's events.jsonl. */
function isSubagent(header: { origin?: string; delegationDepth?: number }): boolean {
	return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}

function resolveModelCtx(h: AgentHandoff): ModelCtx | null {
	if (!llmRuntime) return null;
	let provider = "";
	let model = "";
	if (HANDOFF_MODEL) {
		const [p, ...rest] = HANDOFF_MODEL.split("/");
		provider = p;
		model = rest.join("/");
	}
	if (!provider || !model) {
		const latest = h.agent.session.requestHeader()?.config;
		if (latest?.provider && latest?.model) {
			provider = latest.provider;
			model = latest.model;
		}
	}
	if (!provider || !model) {
		if (h.agent.options.provider && h.agent.options.model) {
			provider = h.agent.options.provider;
			model = h.agent.options.model;
		}
	}
	if (!provider || !model) return null;
	return { llm: llmRuntime, provider, model, sessionId: h.agent.session.id, maxTokens: MAX_TOKENS };
}

// ---------------------------------------------------------------------------
// Refresh queue (one per agent, in-memory, never persisted)
// ---------------------------------------------------------------------------

async function runExclusive<T>(h: AgentHandoff, fn: () => Promise<T>): Promise<T | null> {
	if (h.busy && h.inFlight) await h.inFlight.catch(() => {});
	if (h.busy) return null;
	h.busy = true;
	try {
		return await fn();
	} finally {
		h.busy = false;
	}
}

function drain(h: AgentHandoff, opts: { force?: boolean } = {}): Promise<unknown> | null {
	if (h.paused && !opts.force) return null;
	if (h.busy) return h.inFlight;
	const wanted = opts.force
		? h.store.pendingChars > 0
		: shouldAutoRefresh(h.store.pendingChars, h.store.turnsSinceRefresh);
	if (!wanted) return null;

	const s = h.store;
	const ac = new AbortController();
	h.activeAbort = ac;
	const modelCtx = resolveModelCtx(h);
	if (!modelCtx) {
		dbg(`drain: no model available for ${h.agent.id}; events stay buffered`);
		return null;
	}
	const p = runExclusive(h, async () => {
		let batchRemaining = false;
		do {
			try {
				const r = await runRefresh(s, modelCtx, REFRESH_TIMEOUT_MS, ac.signal);
				batchRemaining = !!r?.remaining;
				if (r?.modelSource) h.lastModel = r.modelSource;
				h.errors = 0;
				h.injector.invalidate(); // pick up the new handoff content
			} catch (e) {
				if (!ac.signal.aborted) {
					h.errors++;
					dbg(`refresh failed: ${e instanceof Error ? e.message : e}`);
				}
				break;
			}
		} while (!ac.signal.aborted && (shouldAutoRefresh(s.pendingChars, s.turnsSinceRefresh) || (opts.force && batchRemaining)));
	});
	h.inFlight = p.catch(() => {});
	void p.finally(() => {
		h.inFlight = null;
		if (h.activeAbort === ac) h.activeAbort = null;
	});
	return p;
}

// ---------------------------------------------------------------------------
// Store adoption + branch switch
// ---------------------------------------------------------------------------

function adoptStore(h: AgentHandoff, branch: string): HandoffStore {
	const cwd = h.agent.session.header.cwd ?? process.cwd();
	const projectRoot = resolveProjectRoot(cwd);
	migrateProjectKey(cwd, projectRoot);
	const s = HandoffStore.forCwdAndBranch(projectRoot, branch);
	s.initSync();
	h.store = s;
	h.branch = branch;
	const since = s.readEventsSince(s.meta.lastRefreshedSeq);
	s.pendingChars = since.reduce((n, e) => n + (e.excerpts ?? []).reduce((m, x) => m + x.text.length, 0), 0);
	s.turnsSinceRefresh = since.filter((e) => e.type === "turn_end").length;
	h.collector = new Collector(s, String(h.agent.id));
	h.injector = new Injector(s);
	dbg(`adoptStore: branch=${branch} root=${s.root} events=${s.meta.nextSeq - 1} pending=${s.pendingChars}`);
	return s;
}

function claimOwnership(h: AgentHandoff): void {
	h.store.meta.sessionId = String(h.agent.id);
	h.store.meta.pid = process.pid;
	h.store.meta.endedAt = "";
	h.store.saveMetaSync();
}

function swapStore(h: AgentHandoff, branch: string): void {
	if (h.activeAbort) h.activeAbort.abort(new Error("handoff: branch switch"));
	if (h.inFlight) void h.inFlight.catch(() => {});
	try {
		h.store.meta.endedAt = new Date().toISOString();
		h.store.saveMetaSync();
	} catch { /* best-effort */ }
	adoptStore(h, branch);
	claimOwnership(h);
	h.injector.invalidate();
	dbg(`branch switch -> ${branch} (store ${h.store.root})`);
}

// ---------------------------------------------------------------------------
// Status text (shared by command + tool)
// ---------------------------------------------------------------------------

function statusText(h: AgentHandoff): string {
	const m = h.store.meta;
	const cwd = h.agent.session.header.cwd ?? process.cwd();
	return [
		`handoff — store: ${h.store.root}`,
		`  branch: ${h.branch}`,
		`  project: ${m.projectPath || cwd}`,
		`  recording: ${h.paused ? "paused (this session; injection still active)" : "yes"}   queue: ${h.busy ? "running" : "idle"}`,
		`  events: ${m.eventLineCount}/1000 lines · latest seq ${m.nextSeq - 1} · pending ${kb(h.store.pendingChars)} · ${h.store.turnsSinceRefresh} turns (fold ≥${TURN_THRESHOLD} turns or ≥${kb(CHAR_THRESHOLD)} chars)`,
		`  handoff.md: ${kb(fsSize(h.store.handoffPath))} (refreshed at seq ${m.lastRefreshedSeq})`,
		`  pinned: ${h.store.pinnedNotes().length} project-level note(s) in ${h.store.projectDocPath}`,
		`  project knowledge: ${h.store.readProjectKnowledge().split("\n").filter((line) => line.startsWith("- ")).length} fact(s) · ${h.store.readProjectCandidates().filter((c) => c.status === "suggested").length} suggestion(s)`,
		...h.store.pinnedNotes().map((n) => `    ${n}`),
		`  summarizer: ${m.summarizerUsage.calls} calls, ${m.summarizerUsage.totalTokens} tokens${h.lastModel ? `, last via ${h.lastModel}` : ""}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// clear / pause / resume
// ---------------------------------------------------------------------------

function clearHandoff(h: AgentHandoff): void {
	h.store.appendEvent({ sessionId: String(h.agent.id), turn: -1, type: "clear" });
	h.store.clearTaskState();
	h.injector.invalidate();
	h.store.markRefreshed(h.store.meta.nextSeq - 1);
	h.store.saveMetaSync();
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx: Context, config: HandoffConfig) {
	// Resolve configuration, honoring env aliases for parity with pi-handoff.
	debug = !!(config.debug || process.env.HANDOFF_DEBUG || process.env.PI_HANDOFF_DEBUG);
	CHAR_THRESHOLD = (() => {
		const n = Number(process.env.HANDOFF_THRESHOLD_CHARS ?? process.env.PI_HANDOFF_THRESHOLD_CHARS ?? config.thresholdChars);
		return Number.isFinite(n) ? Math.max(200, Math.floor(n)) : 24_000;
	})();
	TURN_THRESHOLD = (() => {
		const n = Math.floor(Number(process.env.HANDOFF_THRESHOLD_TURNS ?? process.env.PI_HANDOFF_THRESHOLD_TURNS ?? config.thresholdTurns));
		return Number.isFinite(n) && n >= 0 ? n : 20;
	})();
	HANDOFF_MODEL = (config.model || process.env.HANDOFF_MODEL || process.env.PI_HANDOFF_MODEL || "").trim();
	MAX_TOKENS = (() => {
		const n = Number(process.env.HANDOFF_MAX_TOKENS ?? config.maxTokens);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : 16_384;
	})();
	COMMAND_NAME = (config.command || "handoff-memory").trim().replace(/^\//, "") || "handoff-memory";
	if (config.dir) process.env.HANDOFF_DIR = config.dir; // storeHome() reads this
	llmRuntime = ctx.llm;

	// ------------------------------------------------------------- injection
	// One global runtime-context contribution; the framework evaluates it per
	// assembly and passes the owning agent, so we route to that agent's frozen
	// handoff snapshot. Subagents (no AgentHandoff) contribute nothing.
	ctx.systemPrompt.variable(HANDOFF_CONTEXT_VARIABLE, (c: AssembleContext) => {
		const agent = (c as AssembleContext & { agent?: Agent }).agent;
		if (!agent) return "";
		const h = agents.get(String(agent.id));
		if (!h) return "";
		return h.injector.getText();
	});
	ctx.systemPrompt.context({
		name: "handoff",
		order: -200,
		text: HANDOFF_CONTEXT_TEMPLATE,
	});

	// ------------------------------------------------------------- lifecycle
	ctx.on("agent/created", (payload: { agent: Agent; source: string }): undefined => {
		try {
			const agent = payload.agent;
			if (isSubagent(agent.session.header as { origin?: string; delegationDepth?: number })) return;
			if (agents.has(String(agent.id))) return; // already adopted (e.g. compact→restart)
			const cwd = agent.session.header.cwd ?? process.cwd();
			const branch = detectBranch(cwd);
			const h: AgentHandoff = {
				agent,
				store: undefined as unknown as HandoffStore,
				collector: undefined as unknown as Collector,
				injector: undefined as unknown as Injector,
				branch: "",
				paused: false,
				busy: false,
				inFlight: null,
				errors: 0,
				lastModel: null,
				activeAbort: null,
			};
			agents.set(String(agent.id), h);
			adoptStore(h, branch);
			claimOwnership(h);
			const orphans = orphanSubdirStores(resolveProjectRoot(cwd));
			if (orphans.length > 0)
				dbg(`${orphans.length} older handoff store(s) keyed to a subdirectory of this repo are not being read:\n${orphans.map((p) => `  ${p}`).join("\n")}\nThis session uses the repo root. Import anything worth keeping with /handoff project add, or delete those directories under ${storeHome()}.`);
			dbg(`session_start: branch=${h.branch} source=${payload.source} root=${h.store.root}`);
		} catch (e) {
			dbg(`session_start failed: ${e instanceof Error ? e.message : e}`);
		}
	});

	ctx.on("agent/status", (payload: { agent: Agent; status: string }) => {
		if (payload.status !== "idle") return;
		const h = agents.get(String(payload.agent.id));
		if (!h || h.paused) return;
		drain(h)?.catch(() => {}); // never block the agent loop
	});

	ctx.on("agent/disposed", (payload: { agent: Agent }) => {
		const h = agents.get(String(payload.agent.id));
		if (!h) return;
		try {
			if (h.activeAbort) h.activeAbort.abort(new Error("handoff: disposed"));
			if (h.inFlight) void h.inFlight.catch(() => {});
			h.store.meta.endedAt = new Date().toISOString();
			h.store.saveMetaSync();
			h.store.clearEventsOnShutdownIfLarge();
		} catch {
			// never throw while disposing
		}
		agents.delete(String(payload.agent.id));
	});

	// ------------------------------------------------------------- collection
	ctx.on("session/event", (session: { id: SessionId; header: { cwd?: string } }, event: SessionEvent) => {
		const h = agents.get(String(session.id));
		if (!h) return;
		// Compaction events come from an optional dsh-compaction augmentation that is
		// not part of this package's static type graph; compare the raw string so a
		// profile with compaction still invalidates the snapshot, and one without it
		// simply never matches.
		const type = event.type as string;
		try {
			if (type === "turn/start") {
				// Re-detect the git branch each turn; a mid-session `git checkout`
				// swaps to that branch's store before this turn is collected.
				const cwd = session.header.cwd ?? process.cwd();
				const b = detectBranch(cwd, h.branch || "default");
				if (b !== h.branch) swapStore(h, b);
			} else if (type === "compaction/start" || type === "compaction/end" || type === "compaction/summary") {
				h.injector.invalidate();
			}
			h.collector.onEvent(event);
			if (type === "turn/end" && !h.paused) {
				drain(h)?.catch(() => {});
			}
		} catch (e) {
			dbg(String(e));
		}
	});

	// ------------------------------------------------------------- tool
	ctx.tools.register(defineTool({
		name: "handoff",
		description:
			"Inspect and curate persistent memory: handoff.md is branch task state; project.md contains reviewed project-wide knowledge plus protected pinned rules. " +
			"Actions: 'status', 'flush', 'project_propose' (queue durable project knowledge for user review; requires note, optional section), 'pin' (record a hard standing rule), and 'unpin'. " +
			"Use project_propose for reusable architecture, conventions, workflows, decisions with rationale, and recurring pitfalls. It need not have appeared on every branch, but must remain useful after the current task and must not be branch-specific. " +
			"Use pin only for hard constraints or explicit user preferences that must never be rewritten: deploy rules, hard prohibitions, or critical non-obvious commands. " +
			"Do NOT pin: anything about the current task or its progress (the handoff records that automatically), anything specific to one branch, one-off decisions, transient state, anything already stated in AGENTS.md/README (it is already in your context), or secrets. " +
			"Pins are permanent, apply to every branch, and are never rewritten by the summarizer — so prefer one durable sentence over a running commentary, and when in doubt, do not pin. Re-pinning an existing note is a no-op.",
		parameters: {
			action: { type: "string", required: true, enum: ["status", "flush", "project_propose", "pin", "unpin"], description: "status = inspect; flush = refresh branch handoff; project_propose = queue shared knowledge for review; pin/unpin = manage protected rules" },
			section: { type: "string", enum: [...PROJECT_SECTIONS], description: "project.md section for action=project_propose; defaults to Conventions" },
			note: { type: "string", description: "For action=pin: the standing project rule to record (applies on every branch). For action=unpin: a substring identifying which pin to remove. For action=project_propose: the durable fact to queue." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string", required: true } },
			},
			render: (_args, value) => [{ type: "text", text: String((value as { text?: string } | null)?.text ?? "") }],
		},
		execute: async (args: Record<string, unknown>, exec: { agent?: Agent; signal?: AbortSignal }) => {
			const agent = exec.agent;
			const h = agent ? agents.get(String(agent.id)) : undefined;
			if (!h) return { text: "handoff: not initialized for this session" };
			const action = String(args.action ?? "");
			switch (action) {
				case "status":
					return { text: statusText(h) };
				case "project_propose": {
					const statement = args.note ? redact(String(args.note).replace(/\s+/g, " ").trim()).slice(0, 240).trim() : "";
					if (!statement) return { text: "handoff: action=project_propose requires a 'note'" };
					const id = createHash("sha256").update(statement.toLowerCase()).digest("hex").slice(0, 16);
					const candidates = h.store.readProjectCandidates();
					if (candidates.some((c) => c.id === id) || h.store.readProjectKnowledge().toLowerCase().includes(statement.toLowerCase()))
						return { text: "handoff: project knowledge already recorded or proposed — no change" };
					candidates.push({
						id,
						section: (args.section as ProjectSection | undefined) ?? "Conventions",
						statement,
						evidence: "Proposed by the active agent from current work; awaiting user review.",
						branches: [h.branch || "default"],
						createdAt: new Date().toISOString(),
						status: "suggested",
						action: "add",
					});
					h.store.saveProjectCandidates(candidates);
					return { text: `Queued project knowledge for user review under ${(args.section as string | undefined) ?? "Conventions"}.` };
				}
				case "pin": {
					const note = String(args.note ?? "").trim();
					if (!note) return { text: "handoff: action=pin requires a 'note'" };
					if (!h.store.appendPinned(note)) return { text: `handoff: already pinned — no change. Current pins:\n${h.store.pinnedNotes().join("\n") || "(none)"}` };
					h.store.appendEvent({ sessionId: String(h.agent.id), turn: -1, type: "pin", note });
					h.injector.invalidate();
					return { text: `Pinned to ${h.store.projectDocPath} — applies on every branch of this project. It appears in context from the next request on.` };
				}
				case "unpin": {
					const match = String(args.note ?? "").trim();
					if (!match) return { text: "handoff: action=unpin requires a 'note' (a substring of the pin to remove)" };
					const { removed, candidates } = h.store.removePinned(match);
					if (removed) { h.injector.invalidate(); return { text: `Unpinned ${removed}` }; }
					if (candidates.length > 1)
						return { text: `"${match}" matches ${candidates.length} pins — nothing removed (ambiguous matches never delete). Be more specific:\n${candidates.join("\n")}` };
					return { text: `No pin matches "${match}". Current pins:\n${h.store.pinnedNotes().join("\n") || "(none)"}` };
				}
				case "flush": {
					if (h.paused) return { text: "handoff: paused for this session — nothing is being recorded or folded. The user can resume with /handoff resume." };
					const errsBefore = h.errors;
					const p = drain(h, { force: true });
					if (!p) return { text: "handoff: nothing to flush" };
					await p.catch(() => {});
					if (exec.signal?.aborted) return { text: "handoff: flush aborted — buffered events are kept and retried automatically." };
					if (h.errors > errsBefore) return { text: "handoff: summarizer call failed — buffered events are kept and will be retried automatically." };
					return { text: `handoff.md is up to date (${kb(fsSize(h.store.handoffPath))}).` };
				}
				default:
					return { text: `handoff: unknown action "${action}" — try status|flush|project_propose|pin|unpin` };
			}
		},
	}));

	// ------------------------------------------------------------- command
	ctx.inject(["commands"], (cmdCtx: Context) => {
		cmdCtx.commands.register({
			name: COMMAND_NAME,
			description: "handoff: branch handoff + shared project knowledge (status|flush|project|pin|unpin|clear|pause|resume)",
			handler: async (inv: { agent: Agent; rawInput: string; signal: AbortSignal }) => {
				const h = agents.get(String(inv.agent.id));
				if (!h) return { kind: "error" as const, text: "handoff: not initialized for this session" };
				const [sub = "status", ...rest] = inv.rawInput.trim().split(/\s+/);
				const text = rest.join(" ");
				try {
					switch (sub) {
						case "status":
							return { kind: "success" as const, text: statusText(h) };
						case "flush":
							return await cmdFlush(h, inv.signal);
						case "pin":
							return cmdPin(h, text);
						case "unpin":
							return cmdUnpin(h, text);
						case "project":
							return await cmdProject(h, rest, inv.signal);
						case "clear":
							return await cmdReset(h, inv);
						case "pause":
							return cmdPause(h);
						case "resume":
							return cmdResume(h);
						default:
							return { kind: "error" as const, text: `handoff: unknown subcommand "${sub}" — try status|flush|pin|unpin|project|clear|pause|resume` };
					}
				} catch (e) {
					return { kind: "error" as const, text: `handoff ${sub} failed: ${e instanceof Error ? e.message : e}` };
				}
			},
		});
	});

	// ------------------------------------------------------------- skill
	ctx.inject(["skills"], (skillCtx: Context) => {
		skillCtx.skills.register({
			name: "write-handoff",
			description: "Compact the current conversation into a handoff document for another agent to pick up.",
			whenToUse: "When the user wants to write a handoff document for the next session.",
			source: "bundled",
			content: WRITE_HANDOFF_SKILL,
			invocation: { modelInvocable: true, userInvocable: true },
		} as never);
	});
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdFlush(h: AgentHandoff, _signal: AbortSignal): Promise<{ kind: "success"; text: string } | { kind: "error"; text: string }> {
	try {
		await h.agent.whenIdle();
	} catch { /* best-effort */ }
	const done = drain(h, { force: true });
	if (!done) return { kind: "success", text: "handoff: nothing to flush" };
	await done.catch(() => {});
	return { kind: "success", text: `handoff: handoff.md refreshed · ${kb(fsSize(h.store.handoffPath))}` };
}

function cmdPin(h: AgentHandoff, text: string): { kind: "success"; text: string } | { kind: "error"; text: string } {
	if (!text) return { kind: "error", text: "usage: /handoff pin <note>" };
	if (!h.store.appendPinned(text)) return { kind: "error", text: "handoff: already pinned — no change" };
	h.store.appendEvent({ sessionId: String(h.agent.id), turn: -1, type: "pin", note: text });
	h.injector.invalidate();
	return { kind: "success", text: `handoff: pinned to ${h.store.projectDocPath} — applies on every branch of this project` };
}

function cmdUnpin(h: AgentHandoff, text: string): { kind: "success"; text: string } | { kind: "error"; text: string } {
	if (!text) return { kind: "error", text: "usage: /handoff unpin <substring of the pin>" };
	const { removed, candidates } = h.store.removePinned(text);
	if (removed) { h.injector.invalidate(); return { kind: "success", text: `handoff: unpinned ${removed}` }; }
	if (candidates.length > 1) return { kind: "error", text: `handoff: "${text}" matches ${candidates.length} pins — be more specific:\n${candidates.join("\n")}` };
	return { kind: "error", text: `handoff: no pin matches "${text}". Current pins:\n${h.store.pinnedNotes().join("\n") || "(none)"}` };
}

async function cmdProject(h: AgentHandoff, args: string[], signal: AbortSignal): Promise<{ kind: "success"; text: string } | { kind: "error"; text: string }> {
	const [action = "review", ...rest] = args;
	const text = rest.join(" ").trim();
	switch (action) {
		case "status":
			return cmdProjectStatus(h);
		case "refresh":
			return await cmdProjectRefresh(h, rest[0] === "all", signal);
		case "review":
			return await cmdProjectReview(h);
		case "add":
			return cmdProjectAdd(h, text);
		case "forget":
			return cmdProjectForget(h, text);
		default:
			return { kind: "error", text: "usage: /handoff project status|refresh|review|add|forget" };
	}
}

function cmdProjectStatus(h: AgentHandoff): { kind: "success"; text: string } {
	const candidates = h.store.readProjectCandidates();
	const suggested = candidates.filter((c) => c.status === "suggested");
	return {
		kind: "success",
		text: [
			`handoff project — ${h.store.projectDocPath}`,
			`  knowledge: ${h.store.readProjectKnowledge().split("\n").filter((line) => line.startsWith("- ")).length} accepted fact(s)`,
			`  suggestions: ${suggested.length} awaiting review`,
			...suggested.slice(0, 8).map((c) => {
				const a = c.action ?? "add";
				return a === "replace" ? `    [replace/${c.section}] ${c.target} → ${c.statement}`
					: a === "remove" ? `    [remove/${c.section}] ${c.target ?? c.statement}`
						: `    [add/${c.section}] ${c.statement}`;
			}),
		].join("\n"),
	};
}

async function cmdProjectRefresh(h: AgentHandoff, includeArchived: boolean, signal: AbortSignal): Promise<{ kind: "success"; text: string } | { kind: "error"; text: string }> {
	try {
		await h.agent.whenIdle();
	} catch { /* best-effort */ }
	const modelCtx = resolveModelCtx(h);
	if (!modelCtx) return { kind: "error", text: "handoff project: no model available for extraction" };
	const result = await runExclusive(h, async () => {
		const cwd = h.agent.session.header.cwd ?? process.cwd();
		const storedDocs = listBranchDocs(resolveProjectRoot(cwd));
		const active = includeArchived ? null : activeGitBranches(cwd);
		const allDocs = active === null
			? storedDocs
			: storedDocs.filter((doc) => doc.branch === h.branch || doc.branch === "default" || active.has(doc.branch));
		if (allDocs.length === 0) return { kind: "error" as const, text: "handoff project: no branch handoff has durable content yet" };
		const oldHashes = h.store.projectScanHashes();
		const nextHashes = { ...oldHashes };
		const changed = allDocs.filter((doc) => oldHashes[doc.branch] !== createHash("sha256").update(doc.doc).digest("hex"));
		if (changed.length === 0) return { kind: "success" as const, text: "handoff project: all branch handoffs already scanned" };
		let candidates = h.store.readProjectCandidates();
		const currentKnowledge = [...h.store.readProjectKnowledge().split("\n").filter((line) => line.startsWith("- "))];
		const protectedPins = h.store.pinnedNotes();
		const considered = new Set(candidates.map((c) => c.statement));
		let added = 0;
		let invalidated = 0;
		let modelSource = "unknown model";
		for (let offset = 0; offset < changed.length; offset += PROJECT_SCAN_BRANCHES_PER_BATCH) {
			const batch = changed.slice(offset, offset + PROJECT_SCAN_BRANCHES_PER_BATCH);
			if (signal.aborted) break;
			const res = await runProjectExtraction(batch, currentKnowledge, [...considered], protectedPins, modelCtx, REFRESH_TIMEOUT_MS, signal);
			modelSource = res.modelSource;
			const byId = new Map(candidates.map((c) => [c.id, c]));
			for (const c of res.candidates) {
				if (c.action === "invalidate") {
					const target = c.target?.toLowerCase();
					const prior = candidates.find((candidate) => candidate.status === "suggested" && candidate.statement.toLowerCase() === target);
					if (prior) { prior.status = "rejected"; byId.set(prior.id, prior); invalidated++; }
					continue;
				}
				const id = createHash("sha256").update(`${c.action}\0${c.target ?? ""}\0${c.statement}`.trim().toLowerCase()).digest("hex").slice(0, 16);
				if (byId.has(id)) continue;
				byId.set(id, { ...c, action: c.action as ProjectCandidate["action"], id, createdAt: new Date().toISOString(), status: "suggested" });
				considered.add(c.statement);
				added++;
			}
			candidates = [...byId.values()];
			h.store.saveProjectCandidates(candidates);
			for (const doc of batch) nextHashes[doc.branch] = createHash("sha256").update(doc.doc).digest("hex");
			h.store.saveProjectScanHashes(nextHashes);
		}
		const archived = storedDocs.length - allDocs.length;
		return {
			kind: "success" as const,
			text: `handoff project: scanned ${changed.length} changed handoff(s) in ${Math.ceil(changed.length / PROJECT_SCAN_BRANCHES_PER_BATCH)} batch(es) via ${modelSource}; ${added} new suggestion(s)${invalidated ? `, ${invalidated} conflicting unreviewed suggestion(s) withdrawn` : ""}${archived ? `; ${archived} archived/deleted branch store(s) skipped` : ""}`,
		};
	});
	return result ?? { kind: "error", text: "handoff project: refresh busy" };
}

async function cmdProjectReview(h: AgentHandoff): Promise<{ kind: "success"; text: string } | { kind: "error"; text: string }> {
	const candidates = h.store.readProjectCandidates();
	const pending = candidates.filter((c) => c.status === "suggested");
	if (pending.length === 0) return { kind: "error", text: "handoff project: no suggestions awaiting review" };
	// No interactive confirm from a plugin command; auto-accept all pending
	// suggestions here. Users who want manual review should inspect them via
	// `/handoff project status` and apply/forget individually with
	// `/handoff project add` / `/handoff project forget`.
	let added = 0;
	let failed = 0;
	const failureReasons: string[] = [];
	for (const candidate of pending) {
		const result = h.store.applyProjectCandidate(candidate);
		candidate.status = result.applied ? "accepted" : "rejected";
		if (result.applied) added++;
		else { failed++; failureReasons.push(`${candidate.statement}: ${result.reason ?? "unknown reason"}`); }
	}
	h.store.saveProjectCandidates(candidates);
	h.injector.invalidate();
	return {
		kind: "success",
		text: `handoff project review: ${added} applied, ${pending.length - added} rejected${failed ? `, ${failed} could not be applied\n${failureReasons.join("\n")}` : ""}`,
	};
}

function parseProjectFact(text: string): { section: ProjectSection; statement: string } {
	for (const section of PROJECT_SECTIONS) {
		const prefix = `${section}:`;
		if (text.toLowerCase().startsWith(prefix.toLowerCase())) return { section, statement: text.slice(prefix.length).trim() };
	}
	return { section: "Conventions", statement: text };
}

function cmdProjectAdd(h: AgentHandoff, text: string): { kind: "success"; text: string } | { kind: "error"; text: string } {
	if (!text) return { kind: "error", text: "usage: /handoff project add [Section:] <fact>" };
	const { section, statement } = parseProjectFact(text);
	if (!statement) return { kind: "error", text: "handoff project: fact is empty" };
	if (h.store.appendProjectKnowledge(section, statement)) { h.injector.invalidate(); return { kind: "success", text: `handoff project: added under ${section}` }; }
	if (h.store.readProjectKnowledge().length >= PROJECT_KNOWLEDGE_CAP_CHARS)
		return { kind: "error", text: "handoff project: knowledge is at its 16k limit — replace or forget stale facts first" };
	return { kind: "error", text: "handoff project: already present — no change" };
}

function cmdProjectForget(h: AgentHandoff, text: string): { kind: "success"; text: string } | { kind: "error"; text: string } {
	if (!text) return { kind: "error", text: "usage: /handoff project forget <substring>" };
	const { removed, candidates } = h.store.removeProjectKnowledge(text);
	if (removed) { h.injector.invalidate(); return { kind: "success", text: `handoff project: removed ${removed}` }; }
	if (candidates.length > 1) return { kind: "error", text: `handoff project: ambiguous match — nothing removed:\n${candidates.join("\n")}` };
	return { kind: "error", text: `handoff project: no knowledge matches "${text}"` };
}

async function cmdReset(h: AgentHandoff, _inv: { signal: AbortSignal }): Promise<{ kind: "success"; text: string } | { kind: "error"; text: string }> {
	try {
		await h.agent.whenIdle();
	} catch { /* best-effort */ }
	await runExclusive(h, async () => clearHandoff(h));
	return { kind: "success", text: "handoff: clear. Fresh handoff.md ready for the next task." };
}

function cmdPause(h: AgentHandoff): { kind: "success"; text: string } {
	if (h.paused) return { kind: "success", text: "handoff: already paused — /handoff resume to start recording again" };
	h.paused = true;
	if (h.activeAbort) h.activeAbort.abort(new Error("handoff: paused"));
	return { kind: "success", text: "handoff: paused for this session — this conversation is not recorded until /handoff resume. The existing handoff is still read by the agent, and work buffered before now is kept." };
}

function cmdResume(h: AgentHandoff): { kind: "success"; text: string } {
	if (!h.paused) return { kind: "success", text: "handoff: already recording" };
	h.paused = false;
	return { kind: "success", text: "handoff: recording again — nothing from the paused stretch was written." };
}

// ---------------------------------------------------------------------------
// write-handoff skill body
// ---------------------------------------------------------------------------

const WRITE_HANDOFF_SKILL = `Write a handoff document summarising the current conversation so a fresh agent can continue the work.

The handoff extension already auto-maintains one for this project (read it first). It lives **outside the project**, in a per-project, per-git-branch directory under \`~/.agent/agent-handoff/\` named after the project root's absolute path (the git repo/worktree top-level, or the working directory outside git) and the current branch — run \`/handoff status\` to print the exact path, then read \`<store>/handoff.md\`.

Do **not** overwrite that file — the extension owns it. If the automatic document is already accurate, say so and stop; otherwise run \`/handoff flush\` to refresh it from the latest events, or write your manual version to a path the user chooses.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs) or already present in handoff.md — reference them by path or URL instead.

Standing, branch-independent rules and preferences ("deploys go through ops/deploy.sh", "the staging DB is read-only") do not belong in the document at all — record them in the shared project memory with the \`handoff\` tool (action \`pin\`), where they survive a clear and branch switches. Never pin task progress; the document records that.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
`;
