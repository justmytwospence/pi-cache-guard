import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import cacheGuard, { modelInfo, statusText } from "../src/index.ts";
import { lastRequest, view } from "../src/clock.ts";
import { HerdrReporter, herdrTarget } from "../src/herdr.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const opus = {
  provider: "anthropic", id: "claude-opus-5-5", promptCache: { short: 300, long: 3600 },
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const sonnet = { ...opus, id: "claude-sonnet-5-5", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } };
const codex = { provider: "openai-codex", id: "gpt-6-astra", cost: { input: 10, output: 40, cacheRead: 1, cacheWrite: 0 } };

function assistant(at: number, prompt: number, model = opus, output = 1_000) {
  return {
    type: "message", timestamp: new Date(at).toISOString(),
    message: { role: "assistant", provider: model.provider, model: model.id, timestamp: at,
      usage: { input: 2, cacheRead: prompt - 2, cacheWrite: 0, output } },
  };
}
const warm = (at: number, cacheRead: number) => ({
  type: "usage", kind: "cache_warm", timestamp: new Date(at).toISOString(), usage: { input: 2, cacheRead, cacheWrite: 0, output: 1 },
});

describe("clock", () => {
  test("warming refreshes move the clock; compaction clears it", () => {
    const entries = [assistant(NOW - 900_000, 600_000), warm(NOW - 600_000, 600_000), warm(NOW - 330_000, 600_000)];
    const last = lastRequest(entries)!;
    expect(last.realAt).toBe(NOW - 900_000);
    expect(last.at).toBe(NOW - 332_000);
    expect(last.tokens).toBe(601_000);
    expect(lastRequest([...entries, { type: "compaction" }])).toBeUndefined();
  });

  test("a warm that missed does not count as a refresh", () => {
    const last = lastRequest([assistant(NOW - 900_000, 600_000), warm(NOW - 600_000, 0)])!;
    expect(last.at).toBe(NOW - 900_000);
  });

  test("views: warm, expired, model switch, no TTL", () => {
    const last = lastRequest([assistant(NOW - 60_000, 600_000)])!;
    expect(statusText(view(last, modelInfo(opus as any, {})!, NOW, 3 * 3_600_000))).toBe("cache 4:00");
    const old = lastRequest([assistant(NOW - 600_000, 600_000)])!;
    expect(view(old, modelInfo(opus as any, {})!, NOW, 3 * 3_600_000).cold).toEqual({ kind: "expired", idleMs: 300_000 });
    expect(statusText(view(old, modelInfo(opus as any, { PI_CACHE_RETENTION: "long" })!, NOW, 3 * 3_600_000))).toBe("cache 50:00");
    expect(statusText(view(last, modelInfo(sonnet as any, {})!, NOW, 3 * 3_600_000))).toBe("cache cold (model)");
    const c = lastRequest([assistant(NOW - 4 * 3_600_000, 200_000, codex as any)])!;
    expect(statusText(view(c, modelInfo(codex as any, {})!, NOW, 3 * 3_600_000))).toBe("cache cold?");
    expect(modelInfo(codex as any, {})!.price).toEqual({ input: 10, cacheRead: 1, cacheWrite: 10 });
  });
});

function harness(entries: unknown[], model: any = opus) {
  return harnessWith(entries, new HerdrReporter("pi", undefined), model);
}

function harnessWith(entries: unknown[], herdr: HerdrReporter, model: any = opus) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const pi = {
    on: (name: string, handler: any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => undefined; },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    getThinkingLevel: () => "high",
    setThinkingLevel: (level: string) => sent.push({ thinking: level }),
    setModel: async (m: any) => { sent.push({ model: m.id }); return true; },
    sendUserMessage: async (content: unknown, options?: any) => {
      if (typeof content === "string" && content.startsWith("/cache-guard ") && options?.expandPromptTemplates) {
        await commands.get("cache-guard").handler(content.slice("/cache-guard ".length), ctx);
      } else sent.push({ session: ctx.sessionManager.getBranch().length ? "old" : "new", content });
    },
  };
  const ui = {
    status: new Map<string, string | undefined>(),
    confirms: [] as string[],
    menus: [] as string[][],
    // Answers to successive selects, each a prefix of the option to pick (undefined: escape).
    answers: [] as Array<string | undefined>,
    answer: "Send anyway" as string | undefined,
    inputs: [] as Array<string | undefined>,
    compactions: [] as any[],
    editor: "",
    notes: [] as string[],
    setStatus: (key: string, text: string | undefined) => ui.status.set(key, text),
    select: async (title: string, options: string[]) => {
      ui.menus.push(options);
      if (title.startsWith("Prompt cache miss")) { ui.confirms.push(title); expect(options[0]).toMatch(/^Send anyway/); }
      const answer = ui.answers.length ? ui.answers.shift() : ui.answer;
      return answer === undefined ? undefined : options.find((option) => option.startsWith(answer));
    },
    input: async () => ui.inputs.shift(),
    getEditorText: () => ui.editor,
    setEditorText: (text: string) => { ui.editor = text; },
    notify: (message: string) => ui.notes.push(message),
  };
  const sent: any[] = [];
  const sessions: any[] = [];
  const ctx: any = {
    cwd: "/nonexistent", hasUI: true, model, ui,
    sessionManager: { getBranch: () => entries, getSessionFile: () => "/sessions/old.jsonl" },
    compact: (options: any) => ui.compactions.push(options),
    modelRegistry: { find: (provider: string, id: string) => ({ ...model, provider, id }) },
    newSession: async (options: any) => {
      sessions.push(options.parentSession);
      ctx.sessionManager.getBranch = () => [];
      await emit("session_start", { type: "session_start", reason: "new" });
      return { cancelled: false };
    },
  };
  cacheGuard(pi as any, { herdr });
  const emit = async (name: string, event: any) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
    return result;
  };
  return { emit, ui, ctx, commands, sent, sessions };
}

const input = (text: string, extra: Record<string, unknown> = {}) => ({ type: "input", text, source: "interactive", ...extra });

describe("extension", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  test("publishes and ticks the status", async () => {
    const h = harness([assistant(NOW - 60_000, 600_000)]);
    await h.emit("session_start", {});
    expect(h.ui.status.get("cache-guard")).toBe("cache 4:00");
    vi.advanceTimersByTime(5_000);
    expect(h.ui.status.get("cache-guard")).toBe("cache 3:55");
    vi.advanceTimersByTime(300_000);
    expect(h.ui.status.get("cache-guard")).toBe("cache cold");
    await h.emit("session_shutdown", {});
    expect(h.ui.status.get("cache-guard")).toBeUndefined();
  });

  test("lets a warm prompt through without asking", async () => {
    const h = harness([assistant(NOW - 60_000, 600_000)]);
    await h.emit("session_start", {});
    expect(await h.emit("input", input("go on"))).toEqual({ action: "continue" });
    expect(h.ui.confirms).toEqual([]);
  });

  test("asks before a cold prompt and keeps it in the editor on No", async () => {
    const h = harness([assistant(NOW - 900_000, 600_000)]);
    await h.emit("session_start", {});
    h.ui.answer = undefined; // escape
    expect(await h.emit("input", input("next step please"))).toEqual({ action: "handled" });
    expect(h.ui.confirms[0]).toContain("expired 10m ago: this prompt re-caches 601k tokens (~$2.88 at API prices)");
    expect(h.ui.editor).toBe("next step please");
    h.ui.answer = "Send anyway";
    expect(await h.emit("input", input("next step please"))).toEqual({ action: "continue" });
  });

  test("small contexts, commands, steering and extension input pass", async () => {
    const small = harness([assistant(NOW - 900_000, 50_000)]);
    await small.emit("session_start", {});
    expect(await small.emit("input", input("hi"))).toEqual({ action: "continue" });
    const h = harness([assistant(NOW - 900_000, 600_000)]);
    await h.emit("session_start", {});
    expect(await h.emit("input", input("/compact"))).toEqual({ action: "continue" });
    expect(await h.emit("input", input("more", { streamingBehavior: "steer" }))).toEqual({ action: "continue" });
    expect(await h.emit("input", input("more", { source: "extension" }))).toEqual({ action: "continue" });
    expect(h.ui.confirms).toEqual([]);
  });

  test("asks before a model switch drops a large cache", async () => {
    const h = harness([assistant(NOW - 10_000, 600_000)], sonnet);
    await h.emit("session_start", {});
    h.ui.answer = undefined; // escape
    expect(await h.emit("input", input("continue"))).toEqual({ action: "handled" });
    expect(h.ui.confirms[0]).toContain("claude-sonnet-5-5 has no cache of this conversation");
  });

  test("the streaming message's start keeps the clock current", async () => {
    const h = harness([assistant(NOW - 290_000, 600_000)]);
    await h.emit("session_start", {});
    await h.emit("message_start", { message: { role: "assistant", timestamp: NOW, provider: "anthropic", model: "claude-opus-5-5" } });
    expect(h.ui.status.get("cache-guard")).toBe("cache 5:00");
  });
});

describe("herdr", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  function reporter() {
    const sent: any[] = [];
    const r = new HerdrReporter("pi", { socketPath: "/s", paneId: "w1:p1" }, async (_t, request) => { sent.push(request.params); return true; });
    return { r, sent };
  }

  test("reports the cache token only when a big cache goes cold, and clears it", async () => {
    const { r, sent } = reporter();
    const entries: unknown[] = [assistant(NOW - 60_000, 600_000)];
    const h = harnessWith(entries, r);
    await h.emit("session_start", {});
    expect(sent.map((p) => p.tokens.cache)).toEqual([null]); // stale token from an earlier session cleared
    vi.advanceTimersByTime(60_000);
    expect(sent.length).toBe(1); // still warm: nothing new
    vi.advanceTimersByTime(200_000);
    expect(sent.at(-1)).toMatchObject({ pane_id: "w1:p1", source: "cache-guard", agent: "pi", tokens: { cache: "cold 601k" }, ttl_ms: 86_400_000 });
    entries.push(assistant(Date.now(), 610_000));
    vi.advanceTimersByTime(1_000);
    expect(sent.at(-1).tokens.cache).toBeNull();
    vi.advanceTimersByTime(400_000);
    expect(sent.at(-1).tokens.cache).toBe("cold 611k");
    await h.emit("session_shutdown", {});
    expect(sent.at(-1).tokens.cache).toBeNull();
  });

  test("small caches never show", async () => {
    const { r, sent } = reporter();
    const h = harnessWith([assistant(NOW - 900_000, 50_000)], r);
    await h.emit("session_start", {});
    vi.advanceTimersByTime(5_000);
    expect(sent.map((p) => p.tokens.cache)).toEqual([null]);
  });

  test("outside herdr nothing is sent", () => {
    expect(herdrTarget({})).toBeUndefined();
    expect(herdrTarget({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toEqual({ socketPath: "/s", paneId: "w1:p1" });
  });
});

describe("choices", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());
  const cold = () => harness([assistant(NOW - 900_000, 600_000)]);

  test("the menu prices each way through", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answer = undefined;
    await h.emit("input", input("next"));
    expect(h.ui.menus[0]).toEqual([
      "Send anyway (~$3.00)",
      "Send, and stop asking in this session",
      "Compact first, then send it (~$2.40)",
      "Start a new session with this prompt (no history, ~$0)",
      "Keep the prompt in the editor",
    ]);
  });

  test("compact with focus on the prompt, then send it", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Compact", "Focus"];
    expect(await h.emit("input", input("fix the parser"))).toEqual({ action: "handled" });
    const compaction = h.ui.compactions[0];
    expect(compaction.customInstructions).toContain("continue with the user's next request");
    expect(compaction.customInstructions).toContain("fix the parser");
    compaction.onComplete({});
    await Promise.resolve();
    expect(h.sent).toEqual([{ session: "old", content: "fix the parser" }]);
  });

  test("compact with written guidance; escape at the guidance keeps the prompt", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Compact", "Write"];
    h.ui.inputs = ["keep the test plan"];
    await h.emit("input", input("go"));
    expect(h.ui.compactions[0].customInstructions).toBe("keep the test plan");
    h.ui.answers = ["Compact", "Write"];
    h.ui.inputs = [undefined];
    expect(await h.emit("input", input("go"))).toEqual({ action: "handled" });
    expect(h.ui.compactions.length).toBe(1);
    expect(h.ui.editor).toBe("go");
  });

  test("a failed compaction puts the prompt back", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Compact", "Default"];
    await h.emit("input", input("go"));
    expect(h.ui.compactions[0].customInstructions).toBeUndefined();
    h.ui.compactions[0].onError(new Error("nope"));
    expect(h.ui.editor).toBe("go");
  });

  test("start fresh carries the prompt into a new linked session", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Start a new session"];
    expect(await h.emit("input", input("new topic"))).toEqual({ action: "handled" });
    await vi.runOnlyPendingTimersAsync();
    expect(h.sessions).toEqual(["/sessions/old.jsonl"]);
    await vi.runOnlyPendingTimersAsync();
    expect(h.sent).toEqual([{ thinking: "high" }, { session: "new", content: "new topic" }]);
  });

  test("stop asking: sends now and later without the menu", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Send, and stop"];
    expect(await h.emit("input", input("a"))).toEqual({ action: "continue" });
    expect(await h.emit("input", input("b"))).toEqual({ action: "continue" });
    expect(h.ui.confirms.length).toBe(1);
  });
});
