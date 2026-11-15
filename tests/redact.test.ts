import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact";

/**
 * Redaction is the only place a secret can escape into handoff.md, which is
 * written to disk and fed to the summarizer model. Two failure modes matter and
 * they pull in opposite directions:
 *
 *   - a missed format leaks a live credential (fail-open, unacceptable)
 *   - an over-broad pattern destroys ordinary prose, diffs and hashes, which
 *     degrades every handoff it touches (fail-noisy, also unacceptable)
 *
 * Every token below is synthetic. `leaks()` asserts the literal secret is gone;
 * `keeps()` asserts a near-miss survives untouched.
 */

const leaks = (secret: string, text = `klucz: ${secret}`) => expect(redact(text)).not.toContain(secret);
const keeps = (text: string) => expect(redact(text)).toBe(text);

/**
 * Tokens are assembled at runtime from harmless fragments. A literal that looks
 * like a live credential is refused by GitHub push protection — which would
 * block this very test from landing — and the assertion only needs the shape.
 */
const tok = (...parts: string[]) => parts.join("");

describe("vendor-prefixed tokens", () => {
	test("openai / anthropic / deepseek sk-", () => {
		leaks(tok("sk-proj-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"));
		leaks(tok("sk-ant-", "api03abcdefghijklmnopqrstuvwxyz0123456789"));
		leaks(tok("sk-", "0123456789abcdef0123456789abcdef"));
	});
	test("groq gsk_", () => leaks(tok("gsk_", "abcdefghijklmnopqrstuvwxyz0123456789")));
	test("huggingface hf_", () => leaks(tok("hf_", "abcdefghijklmnopqrstuvwxyz0123456789")));
	test("perplexity pplx-", () => leaks(tok("pplx-", "abcdef0123456789abcdef0123456789")));
	test("npm token", () => leaks(tok("npm_", "abcdefghijklmnopqrstuvwxyz0123456789")));
	test("stripe live and restricted keys", () => {
		leaks(tok("sk", "_live_", "abcdefghijklmnopqrstuvwx"));
		leaks(tok("rk", "_test_", "abcdefghijklmnopqrstuvwx"));
	});
	test("google oauth refresh token", () => leaks(tok("1//0", "abcdefghijklmnopqrstuvwxyzABCDEFG")));
	test("github / slack / gcp / jwt", () => {
		leaks(tok("ghp_", "abcdefghijklmnopqrstuvwxyz0123"));
		leaks(tok("xoxb-", "1234567890-abcdefghij"));
		leaks(tok("AIza", "SyA1234567890abcdefghijklmnopqrstuv"));
		leaks(tok("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcdefghijklmnop"));
	});
	test("aws access key id", () => leaks(tok("AKIA", "IOSFODNN7EXAMPLE")));
});

describe("contextual secrets", () => {
	test("aws secret access key next to its name", () => {
		const secret = tok("wJalrXUtnFEMI/", "K7MDENG/bPxRfiCYEXAMPLEKEY");
		leaks(secret, `aws_secret_access_key = ${secret}`);
	});
	test("password in prose, English and Polish", () => {
		const secret = tok("tajne", "haslo123");
		leaks(secret, `the password is ${secret} and it rotates`);
		leaks(secret, `hasło to ${secret}, zmieniamy co miesiąc`);
	});
	test("env / yaml assignment forms", () => {
		leaks(tok("super", "secretvalue"), `API_KEY=${tok("super", "secretvalue")}`);
		leaks(tok("hunter2", "hunter2"), `password: "${tok("hunter2", "hunter2")}"`);
	});
});

describe("near misses stay intact", () => {
	test("prose without secrets is untouched", () => {
		keeps("The handoff records progress, decisions, constraints and next steps.");
	});
	test("short identifiers and hashes survive", () => {
		keeps("commit 4eeb1b0 fixed the collector");
		keeps("the token budget is 200000, not a secret");
	});
	test("a path containing 'key' is not a secret", () => {
		keeps("edited src/keyboard-handler.ts and docs/keys.md");
	});
	test("a 40-char git sha is not treated as an AWS key", () => {
		keeps("0123456789abcdef0123456789abcdef01234567");
	});
});
