/**
 * Denylist-based secret redaction.
 *
 * Runs at three points (per plan):
 *  1. At append (collector) — before excerpts ever touch disk.
 *  2. Before any LLM call — over the documents being sent out.
 *  3. After the LLM call — over the produced documents before writing.
 *
 * This is a denylist, not a guarantee: the summarizer prompts also instruct the
 * model never to emit secrets. Two failure modes pull against each other and
 * both matter — a missed format leaks a live credential, while an over-broad
 * pattern destroys ordinary diffs and prose in every handoff it touches. Each
 * pattern below is therefore anchored to a shape only a secret carries, and the
 * near-miss cases are pinned by tests/redact.test.ts.
 */

const PATTERNS: Array<[RegExp, string]> = [
	// Private key blocks
	[/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----/g, "[REDACTED-PRIVATE-KEY]"],

	// Vendor-prefixed tokens. The longer, more specific prefix comes first so it
	// wins over the generic `sk-` rule beneath it.
	[/\bsk_live_[A-Za-z0-9]{16,}\b/g, "[REDACTED-STRIPE-KEY]"],
	[/\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED-STRIPE-KEY]"],
	[/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED-ANTHROPIC-KEY]"],
	[/\bsk-proj-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED-OPENAI-KEY]"],
	[/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
	[/\bgsk_[A-Za-z0-9]{20,}\b/g, "[REDACTED-GROQ-KEY]"],
	[/\bhf_[A-Za-z0-9]{20,}\b/g, "[REDACTED-HF-TOKEN]"],
	[/\bpplx-[A-Za-z0-9]{16,}\b/g, "[REDACTED-PERPLEXITY-KEY]"],
	[/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED-NPM-TOKEN]"],

	// Cloud and VCS
	[/\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
	[/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED-GH-TOKEN]"],
	[/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, "[REDACTED-GH-TOKEN]"],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED-SLACK-TOKEN]"],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED-GCP-KEY]"],

	// Google OAuth refresh tokens: "1//" plus a long opaque tail. No ordinary
	// path or URL starts that way, so the anchor is unambiguous.
	[/\b1\/\/[A-Za-z0-9_-]{28,}/g, "[REDACTED-GOOGLE-REFRESH]"],

	// Bearer and JWT
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer [REDACTED]"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED-JWT]"],

	// A credential assignment: `password: "hunter2hunter2"`, `api_key=Zx9K…`,
	// `token: tajnehaslo123`. The value must be opaque — 8+ chars, at least one
	// digit, and not a dotted path or dotted identifier — which is what separates
	// a credential from ordinary source and docs (`maxTokens: ctx.maxTokens`,
	// `tokens: docs/tokens.md`, `password: required`). Redacting those would
	// silently destroy every handoff they appear in.
	[/(\b[A-Za-z0-9_.\-]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_.\-]*\b\s*[=:]\s*["']?)(?![A-Za-z0-9_./\-]*\.[A-Za-z0-9])(?=[A-Za-z0-9_/+\-]*\d)[A-Za-z0-9_/+\-]{8,}/gi, "$1[REDACTED]"],

	// Env-style names are unambiguous: an uppercase NAME ending in KEY/TOKEN/
	// SECRET/PASSWORD assigned a value in a `.env` or shell line. No such name
	// appears in ordinary prose, so the value needs no further shape test.
	[/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*["']?)[^\s"',]{8,}/g, "$1[REDACTED]"],

	// The same credential named in prose, English and Polish: "the password is …",
	// "hasło to …". The separator is a word, which is why it needs its own rule.
	[/(\b(?:password|passwd|passphrase|secret|token|api[ -]?key|hasło|haslo|klucz)\s+(?:is|to|=|equals|jest)\s+)["']?(?=[A-Za-z0-9_\-]*\d)[A-Za-z0-9_\-]{8,}/gi, "$1[REDACTED]"],
];

export function redact(text: string): string {
	let out = text;
	for (const [re, replacement] of PATTERNS) {
		out = out.replace(re, replacement);
	}
	return out;
}
