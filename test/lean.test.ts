import { expect, test } from "vitest";

import { trimFloor, trimStatus } from "../src/context.ts";
import { DEFAULT_SETTINGS } from "../src/core.ts";
import { type Keep, assemble, batches, blocksFor, codeSummary, keepAnswers, keepQuestions, makeBlocks, prefilter, trimQuestions, trimVerdict } from "../src/lean.ts";
import { extractUnits, filterMessages, lastUserMessages, recentTexts } from "../src/units.ts";

const TRIM = DEFAULT_SETTINGS.trim;
const log = Array.from({ length: 3_000 }, (_, i) => (i === 1_500 ? "FAIL test/parser.test.ts > parses empty input" : `  ✓ test ${i} passed`));

test("prefilter keeps head, tail, error lines with context, and a sample within budget", () => {
  const kept = prefilter(log, 20_000);
  expect(kept.slice(0, 40)).toEqual([...Array(40).keys()]);
  expect(kept).toContain(1_499);
  expect(kept).toContain(1_500);
  expect(kept).toContain(1_501);
  expect(kept).toContain(2_999);
  const chars = kept.reduce((sum, i) => sum + (log[i] as string).length + 1, 0);
  expect(chars).toBeLessThanOrEqual(20_000 + 200);
  expect(kept).toEqual([...kept].sort((a, b) => a - b));
});

test("makeBlocks groups candidates into at most maxBlocks blocks", () => {
  const blocks = makeBlocks(log, [...log.keys()], 150);
  expect(blocks).toHaveLength(150);
  expect(blocks[0]?.id).toBe("B001");
  expect(blocks.flatMap((b) => b.lines)).toHaveLength(3_000);
  expect(trimQuestions(blocks)["block::B150"]?.instructions).toMatch(/output\.B150/u);
  // Too large for one request: pre-filtered first.
  expect(blocksFor(log.join("\n"), { ...TRIM, stateBudgetChars: 20_000 }).blocks.flatMap((b) => b.lines).length).toBeLessThan(3_000);
});

test("assemble keeps order, marks omissions and points at the full output", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const blocks = makeBlocks(lines, [...lines.keys()], 10);
  const result = assemble(lines, [blocks[4]!], { ...TRIM, headLines: 2, tailLines: 3 }, "/tmp/full.txt");
  expect(result.keptLines).toBe(15);
  expect(result.text).toContain("line 0\nline 1\n[… 38 lines omitted …]\nline 40");
  expect(result.text).toContain("line 49\n[… 47 lines omitted …]\nline 97");
  expect(result.text).toMatch(/Full output: \/tmp\/full\.txt \(read it with offset\/limit\)/u);
});

test("trimVerdict: trims only when the agent wants parts and most can go", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const blocks = makeBlocks(lines, [...lines.keys()], 10);
  const keepOne = Object.fromEntries(blocks.map((b, i) => [`block::${b.id}`, { type: "bool" as const, probability: i === 4 ? 0.9 : 0.1 }]));
  expect(trimVerdict(lines, blocks, keepOne, TRIM, "/f").trim).toBe(true);
  expect(trimVerdict(lines, blocks, { ...keepOne, needs_all: { type: "bool", probability: 0.9 } }, TRIM, "/f").trim).toBe(false);
  const keepMost = Object.fromEntries(blocks.map((b) => [`block::${b.id}`, { type: "bool" as const, probability: 0.8 }]));
  expect(trimVerdict(lines, blocks, keepMost, TRIM, "/f").trim).toBe(false);
});

test("trimFloor: which tools are trimmed and from what size", () => {
  expect(trimFloor("bash", TRIM)).toBe(12_000);
  expect(trimFloor("read", TRIM)).toBe(50_000);
  expect(trimFloor("mcp__context7__query_docs", TRIM)).toBe(12_000);
  expect(trimFloor("fetch_content", TRIM)).toBe(12_000);
  expect(trimFloor("edit", TRIM)).toBeUndefined();
  expect(trimFloor("todo", TRIM)).toBeUndefined();
  expect(trimStatus(48_000)).toBe("lean: −12k tok");
  expect(trimStatus(0)).toBeUndefined();
});

const messages = [
  { role: "user", content: "Add retries to the HTTP client. Max 3 attempts, exponential backoff." },
  { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking at the client." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/http.ts" } }] },
  { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "export function get() {}" }], isError: false },
  { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }] },
  { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "1 failing: retry.test.ts" }], isError: true },
];

test("extractUnits pairs tool calls with their results", () => {
  const units = extractUnits(messages);
  expect(units.map((u) => [u.id, u.kind])).toEqual([["U001", "user"], ["U002", "assistant"], ["U003", "tool"], ["U004", "tool"]]);
  expect(units[3]?.tool).toMatchObject({ name: "bash", result: "1 failing: retry.test.ts", isError: true });
  expect(units[3]?.text).toBe('bash({"command":"npm test"})\n[error] 1 failing: retry.test.ts');
  expect(keepQuestions(units)["keep::U004"]?.instructions).toMatch(/units\.U004/u);
});

test("keepAnswers: unanswered or unknown answers are summarized", () => {
  const units = extractUnits(messages);
  const keep = keepAnswers(units, {
    "keep::U001": { type: "choice", choice: "verbatim", probabilities: {}, confidence: 1 },
    "keep::U002": { type: "choice", choice: "drop", probabilities: {}, confidence: 1 },
    "keep::U003": { type: "choice", choice: "maybe", probabilities: {}, confidence: 1 },
  });
  expect([...keep.values()]).toEqual(["verbatim", "drop", "summarize", "summarize"]);
});

test("filterMessages drops, clips and removes thinking", () => {
  const units = extractUnits(messages);
  const keep = new Map<string, Keep>([["U001", "verbatim"], ["U002", "drop"], ["U003", "drop"], ["U004", "summarize"]]);
  const out = filterMessages(messages, units, keep) as any[];
  expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
  expect(out[1].content).toEqual([{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }]);
});

test("codeSummary has goal, verbatim, notes and files", () => {
  const units = extractUnits(messages);
  const keep = new Map<string, Keep>([["U001", "verbatim"], ["U002", "drop"], ["U003", "summarize"], ["U004", "verbatim"]]);
  const summary = codeSummary({
    units,
    keep,
    previousSummary: "Earlier: set up the repo.",
    fileOps: { read: new Set(["src/http.ts"]), written: new Set(), edited: new Set(["src/retry.ts"]) },
  });
  expect(summary).toMatch(/^# Compacted with Jev/u);
  expect(summary).toContain("## Earlier summary\n\nEarlier: set up the repo.");
  expect(summary).toContain("- Add retries to the HTTP client. Max 3 attempts, exponential backoff.");
  expect(summary).toContain("**User:** Add retries");
  expect(summary).toContain("**Tool `bash`**");
  expect(summary).toContain("- read {\"path\":\"src/http.ts\"}");
  expect(summary).toContain("Modified: src/retry.ts\nRead: src/http.ts");
  expect(summary).not.toContain("Looking at the client");
});

test("batches respect unit and character limits", () => {
  const many = extractUnits(Array.from({ length: 300 }, (_, i) => ({ role: "user", content: `message ${i} ${"x".repeat(400)}` })));
  const groups = batches(many, 120, 60_000);
  expect(groups.every((g) => g.length <= 120)).toBe(true);
  expect(groups.flat()).toHaveLength(300);
});

test("recentTexts and lastUserMessages read the branch", () => {
  const entry = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
  const branch = [entry("user", "first"), entry("assistant", [{ type: "text", text: "ok" }]), entry("user", "second"), entry("assistant", [{ type: "text", text: "on it" }])];
  expect(recentTexts(branch)).toEqual({ user: "second", assistant: "on it" });
  expect(lastUserMessages(branch, 2)).toBe("first\n---\nsecond");
});
