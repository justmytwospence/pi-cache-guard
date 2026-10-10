import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

import { DECISION_TYPE, leanContext } from "../src/context.ts";
import { userSettingsFile } from "../src/config.ts";
import { JEV_MODELS, resolveJev } from "../src/jev.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  compact: vi.fn(async (preparation: any, _model: unknown, _key: unknown, _headers: unknown, instructions: unknown) => ({
    summary: `LLM summary of ${preparation.messagesToSummarize.length} messages${instructions ? ` (${instructions})` : ""}`,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1_100, cost: { input: 0.004, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.006 } },
  })),
}));

const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

type Answerer = (questions: Record<string, any>, state: any) => any;

/** A Pi model registry with Jev (or without, when `available` is empty). */
function registry(answer: Answerer, available = [{ provider: "typesafe", id: "jev-latest" }]) {
  const calls: Array<{ state: any; questions: Record<string, any> }> = [];
  return {
    calls,
    getAvailableOfType: async () => available,
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id }),
    classify: async (_model: unknown, context: any) => {
      calls.push(context);
      const result = answer(context.questions, context.state);
      if (result && typeof result === "object" && "stopReason" in result) return result;
      return { model: "jev-latest", stopReason: "stop", answers: result, usage: usage(300) };
    },
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
  };
}

function setup(answer: Answerer, available?: Array<{ provider: string; id: string }>) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: Array<{ customType: string; data: any }> = [];
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data: data as any }),
  };
  const lean = leanContext(pi as any);
  const reg = registry(answer, available);
  const notes: string[] = [];
  const status = new Map<string, string | undefined>();
  const ctx: any = {
    cwd: "/nonexistent",
    isProjectTrusted: () => false,
    hasUI: true,
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    modelRegistry: reg,
    ui: { notify: (message: string) => notes.push(message), setStatus: (key: string, text: string | undefined) => status.set(key, text) },
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "Fix the retry test" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Running the tests." }] } },
      ],
      getSessionId: () => "s1",
    },
  };
  const emit = async (name: string, event: any) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
    return result;
  };
  return { lean, reg, ctx, emit, entries, notes, status };
}

const big = Array.from({ length: 2_000 }, (_, i) => (i === 1_000 ? "Error: expected 3 retries, got 1" : `ok ${i} ${"-".repeat(10)}`)).join("\n");
const toolResult = (id = "t1") => ({ type: "tool_result", toolCallId: id, toolName: "bash", input: { command: "npm test" }, content: [{ type: "text", text: big }], isError: true });

const keepErrors: Answerer = (questions, state) =>
  Object.fromEntries(
    Object.keys(questions).map((id) => {
      const block = id.startsWith("block::") ? String(state?.output?.[id.slice(7)] ?? "") : "";
      return [id, { type: "bool", probability: block.includes("Error") ? 0.9 : 0.05 }];
    }),
  );

test("large output is trimmed to the needed blocks and saved in full", async () => {
  const { reg, emit, entries, status } = setup(keepErrors);
  await emit("session_start", { reason: "startup" });
  await emit("before_agent_start", { prompt: "x" });
  const out: any = await emit("tool_result", toolResult());
  const text: string = out.content[0].text;
  expect(text).toContain("Error: expected 3 retries, got 1");
  expect(text).toMatch(/\[… \d+ lines omitted …\]/u);
  expect(text.length).toBeLessThan(big.length / 5);
  const full = /Full output: (\S+)/u.exec(text)?.[1] as string;
  expect(full).toContain("/cache-guard/tool-output/s1/");
  expect(readFileSync(full, "utf8")).toBe(big);
  expect(out.usage.input).toBe(300);
  expect(reg.calls[0]?.state.intent).toMatchObject({ user_request: "Fix the retry test", agent_said: "Running the tests.", tool: "bash" });
  expect(entries[0]).toMatchObject({ customType: DECISION_TYPE, data: { kind: "trim", tool: "bash", lines: 2_000 } });
  expect(status.get("lean-context")).toMatch(/^lean: −\d+k tok$/u);

  // Asking for the same thing again in the same turn returns it in full.
  expect(await emit("tool_result", toolResult("t2"))).toBeUndefined();
  expect(reg.calls).toHaveLength(1);
});

test("no trim when the agent needs it all, when most would be kept, or Jev fails", async () => {
  const needsAll = setup((q, st) => ({ ...keepErrors(q, st), needs_all: { type: "bool", probability: 0.9 } }));
  await needsAll.emit("session_start", {});
  expect(((await needsAll.emit("tool_result", toolResult())) as any).content).toBeUndefined();
  const most = setup((q) => Object.fromEntries(Object.keys(q).map((id) => [id, { type: "bool", probability: id === "needs_all" ? 0 : 0.8 }])));
  await most.emit("session_start", {});
  expect(((await most.emit("tool_result", toolResult())) as any).content).toBeUndefined();
  const down = setup(() => ({ stopReason: "error", errorMessage: "timeout", answers: {} }));
  await down.emit("session_start", {});
  expect(await down.emit("tool_result", toolResult())).toBeUndefined();
});

test("without Jev nothing is trimmed and Jev is never asked", async () => {
  const { reg, emit } = setup(keepErrors, []);
  await emit("session_start", {});
  expect(await emit("tool_result", toolResult())).toBeUndefined();
  expect(reg.calls).toHaveLength(0);
});

test("small output and nested calls pass through without Jev", async () => {
  const { reg, emit } = setup(keepErrors);
  await emit("session_start", {});
  expect(await emit("tool_result", { ...toolResult(), content: [{ type: "text", text: "ok" }] })).toBeUndefined();
  expect(await emit("tool_result", { ...toolResult(), parentToolCallId: "p" })).toBeUndefined();
  expect(reg.calls).toHaveLength(0);
});

const keepFirstDropSecond: Answerer = (questions) =>
  Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "choice", choice: id === "keep::U001" ? "verbatim" : id === "keep::U002" ? "drop" : "summarize", probabilities: {}, confidence: 1 }]));

const compaction = (reason = "manual", customInstructions?: string) => ({
  type: "session_before_compact",
  reason,
  customInstructions,
  willRetry: false,
  branchEntries: [],
  signal: new AbortController().signal,
  preparation: {
    firstKeptEntryId: "e9",
    tokensBefore: 50_000,
    previousSummary: undefined,
    isSplitTurn: false,
    turnPrefixMessages: [],
    messagesToSummarize: [
      { role: "user", content: "Use pnpm, never npm." },
      { role: "assistant", content: [{ type: "text", text: "Exploring." }] },
      { role: "user", content: "Now add a cache." },
    ],
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set(["src/cache.ts"]) },
    settings: {},
  },
});

test("a Jev compaction writes the summary in code, judged against the goal", async () => {
  const { lean, reg, emit, entries } = setup(keepFirstDropSecond);
  await emit("session_start", {});
  lean.armJevCompaction({ goal: "fix the parser", strict: true });
  const out: any = await emit("session_before_compact", compaction());
  expect(reg.calls[0]?.state.current_goal).toBe("fix the parser");
  expect(out.compaction.firstKeptEntryId).toBe("e9");
  expect(out.compaction.summary).toMatch(/^# Compacted with Jev/u);
  expect(out.compaction.summary).toContain("**User:** Use pnpm, never npm.");
  expect(out.compaction.summary).not.toContain("Exploring.");
  expect(out.compaction.summary).toContain("Modified: src/cache.ts");
  expect(out.compaction.usage.input).toBe(300);
  expect(out.compaction.details.cacheGuard).toEqual({ mode: "jev", verbatim: 1, summarize: 1, drop: 1 });
  expect(entries.at(-1)).toMatchObject({ customType: DECISION_TYPE, data: { kind: "compact", jevOnly: true } });
  // Armed for one compaction only: the next /compact filters and lets Pi summarize.
  const next: any = await emit("session_before_compact", compaction("manual", "keep the plan"));
  expect(next.compaction.summary).toMatch(/^LLM summary of 2 messages \(keep the plan\)/u);
  expect(next.compaction.summary).toContain("## Kept verbatim\n\n**User:** Use pnpm, never npm.");
  expect(next.compaction.usage.input).toBe(1_300);
  expect(next.compaction.details.cacheGuard.mode).toBe("filtered");
});

test("strict: a Jev failure cancels the compaction and says why; overflow falls back to Pi", async () => {
  const down = setup(() => ({ stopReason: "error", errorMessage: "Request timed out", answers: {} }));
  await down.emit("session_start", {});
  down.lean.armJevCompaction({ strict: true });
  expect(await down.emit("session_before_compact", compaction())).toEqual({ cancel: true });
  expect(down.lean.lastFailure()).toBe("Jev failed (timed out)");
  expect(await down.emit("session_before_compact", compaction("overflow"))).toBeUndefined();
  expect(down.notes.at(-1)).toBe("Jev compaction: Jev failed (timed out); using Pi's compaction.");
  // A failed /compact filter leaves Pi's compaction alone, quietly.
  const notes = down.notes.length;
  expect(await down.emit("session_before_compact", compaction("threshold"))).toBeUndefined();
  expect(down.notes.length).toBe(notes);

  const none = setup(keepFirstDropSecond, []);
  await none.emit("session_start", {});
  none.lean.armJevCompaction({ strict: true });
  expect(await none.emit("session_before_compact", compaction())).toEqual({ cancel: true });
  expect(none.lean.lastFailure()).toBe("Jev is not set up (no provider with Jev has credentials)");
  expect(await none.emit("session_before_compact", compaction())).toBeUndefined();
});

test("Jev off leaves automatic compaction alone without a fallback warning", async () => {
  writeFileSync(userSettingsFile(), JSON.stringify({ jev: { enabled: false } }));
  try {
    const { lean, reg, emit, entries, notes } = setup(keepFirstDropSecond);
    await emit("session_start", {});
    for (const reason of ["manual", "threshold", "overflow"]) {
      expect(await emit("session_before_compact", compaction(reason))).toBeUndefined();
    }
    expect(reg.calls).toEqual([]);
    expect(entries).toEqual([]);
    expect(notes).toEqual([]);
    expect(lean.lastFailure()).toBeUndefined();
    lean.armJevCompaction({ strict: true });
    expect(await emit("session_before_compact", compaction())).toEqual({ cancel: true });
    expect(lean.lastFailure()).toBe("Jev is off");
  } finally {
    rmSync(userSettingsFile(), { force: true });
  }
});

test("resolveJev: the configured provider, else the most direct one Pi can reach", async () => {
  const asked: Array<string | undefined> = [];
  const available = (...ids: string[]) => ({
    getAvailableOfType: async (_type: string, provider?: string) => {
      asked.push(provider);
      return ids.map((id) => ({ provider: id.split("/")[0]!, id: id.slice(id.indexOf("/") + 1) })).filter((m) => m.provider === provider);
    },
    classify: () => undefined,
  });
  expect(await resolveJev(available("openrouter/~typesafe/jev-latest", "typesafe/jev-latest"), { enabled: true, provider: "", model: "" })).toEqual({
    kind: "ready",
    target: JEV_MODELS[0],
    others: [JEV_MODELS[1]],
  });
  expect(await resolveJev(available("openrouter/~typesafe/jev-latest", "typesafe/jev-latest"), { enabled: true, provider: "openrouter", model: "" })).toMatchObject({
    kind: "ready",
    target: { provider: "openrouter", model: "~typesafe/jev-latest" },
  });
  expect(await resolveJev(available("typesafe/jev-latest"), { enabled: true, provider: "vercel-ai-gateway", model: "" })).toMatchObject({ kind: "missing" });
  expect(await resolveJev(available(), { enabled: true, provider: "", model: "" })).toEqual({ kind: "missing", reason: "no provider with Jev has credentials" });
  expect(await resolveJev(available("typesafe/jev-latest"), { enabled: false, provider: "", model: "" })).toEqual({ kind: "off" });
  expect(await resolveJev({}, { enabled: true, provider: "", model: "" })).toMatchObject({ kind: "missing", reason: expect.stringContaining("classifier") });
  // Only the providers that serve Jev are asked.
  expect(new Set(asked)).toEqual(new Set(["typesafe", "openrouter", "vercel-ai-gateway", "cloudflare-workers-ai", "opencode"]));
});
