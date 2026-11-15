import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const src = readFileSync("/home/coyote/Work/dsh-handoff/src/collector.ts", "utf8");
describe("collector tool results", () => {
  test("reads plain content blocks, not a phantom tool-result block", () => {
    expect(src).toContain("return textParts(content).join");
    expect(src).not.toContain('type === "tool-result"');
  });
  test("takes the call id from the message", () => {
    expect(src).toContain('(message as { toolCallId?: unknown }).toolCallId');
  });
});
