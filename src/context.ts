// Keeping the context lean with Jev, through Pi's own classifier models:
//
// 1. Trims large tool output as it arrives (`tool_result`), before it enters the context, so the
//    prompt cache is never disturbed: Jev picks the blocks the agent needs for its current step;
//    the rest becomes `[… N lines omitted …]` markers and the full output is saved to a file the
//    agent can read.
// 2. Compaction (`session_before_compact`): Jev sorts every message and tool call into verbatim,
//    summarize or drop. A Jev compaction (the cold-cache menu, `/cache-guard compact`, overflow
//    recovery) writes the summary in code, with no LLM; `/compact` and threshold compaction run
//    Pi's own summarizer on the filtered conversation and append the verbatim items.
//
// Without Jev (not set up, or off) none of this runs and Pi compacts as it always does.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compact } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { agentDir, loadSettings } from "./config.ts";
import { DEFAULT_SETTINGS, type Settings } from "./core.ts";
import { type ClassifierUsage, type JevState, addUsage, askJev, resolveJev } from "./jev.ts";
import {
  type Keep,
  type TrimLimits,
  type Unit,
  batches,
  blocksFor,
  codeSummary,
  keepAnswers,
  keepCounts,
  keepQuestions,
  keepState,
  trimQuestions,
  trimState,
  trimVerdict,
  verbatimSection,
} from "./lean.ts";
import { extractUnits, filterMessages, lastUserMessages, recentTexts } from "./units.ts";

/** Session entries recording each Jev decision (never sent to the model). */
export const DECISION_TYPE = "cache-guard:jev";
/** pi-status-footer folds `lean: …` under this key into its context row. */
export const TRIM_STATUS_KEY = "lean-context";
/** A missing Jev is looked for again at most this often (after a `/login`, say). */
const RECHECK_MS = 60_000;

type Content = { type: string; text?: string; [key: string]: unknown };

export interface JevCompaction {
  /** What the compacted conversation continues toward; default: the instructions or the last requests. */
  goal?: string;
  /** Cancel instead of falling back to Pi's summary when Jev fails, so nothing is spent. */
  strict: boolean;
}

export interface Lean {
  /** Jev as last found; looked for again when it was missing (a login since) and `ctx` is given. */
  jev(ctx?: ExtensionContext): Promise<JevState>;
  /** Look for Jev again: after a login or a settings change. */
  refresh(ctx: ExtensionContext): Promise<JevState>;
  /** Make the next compaction Jev's, written in code. */
  armJevCompaction(options: JevCompaction): void;
  disarm(): void;
  /** Why the last Jev compaction did not happen, if it did not. */
  lastFailure(): string | undefined;
  /** Characters trimmed from tool output this session. */
  savedChars(): number;
}

/** Which tools' output may be trimmed, and from what size. */
export function trimFloor(tool: string, limits: TrimLimits): number | undefined {
  if (tool === "edit" || tool === "write") return undefined;
  if (tool === "read") return limits.readMinChars;
  if (["bash", "grep", "find", "ls"].includes(tool) || tool.startsWith("mcp__")) return limits.minChars;
  if (/web|fetch|search|content/iu.test(tool)) return limits.minChars;
  return undefined;
}

export function trimStatus(savedChars: number): string | undefined {
  return savedChars > 0 ? `lean: −${Math.round(savedChars / 4_000)}k tok` : undefined;
}

export function leanContext(pi: ExtensionAPI): Lean {
  let settings: Settings = DEFAULT_SETTINGS;
  let jevKey = "";
  let jevState: Promise<JevState> = Promise.resolve({ kind: "missing", reason: "not checked yet" });
  let current: JevState | undefined;
  let checkedAt = 0;
  let armed: JevCompaction | undefined;
  let failure: string | undefined;
  let saved = 0;
  const trimmedThisTurn = new Set<string>();

  const keyOf = (s: Settings) => JSON.stringify([s.enabled, s.jev]);
  const refresh = (ctx: ExtensionContext) => {
    jevKey = keyOf(settings);
    checkedAt = Date.now();
    const next = resolveJev(ctx.modelRegistry, { ...settings.jev, enabled: settings.enabled && settings.jev.enabled });
    jevState = next;
    void next.then((state) => {
      if (jevState === next) current = state;
    });
    return next;
  };
  /** New settings, or a Jev that was missing a minute ago (credentials may have arrived): look again. */
  const reload = (ctx: ExtensionContext) => {
    settings = loadSettings(ctx.cwd, ctx.isProjectTrusted());
    if (keyOf(settings) !== jevKey || (current?.kind === "missing" && Date.now() - checkedAt >= RECHECK_MS)) void refresh(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    settings = loadSettings(ctx.cwd, ctx.isProjectTrusted());
    current = undefined;
    saved = 0;
    armed = undefined;
    trimmedThisTurn.clear();
    void refresh(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    reload(ctx);
    trimmedThisTurn.clear();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!settings.enabled || !settings.trim.enabled) return undefined;
    // Nested calls return to a script (codemode), not to the context.
    if ((event as { parentToolCallId?: string }).parentToolCallId) return undefined;
    const floor = trimFloor(event.toolName, settings.trim);
    if (floor === undefined) return undefined;
    const content = event.content as Content[];
    const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (text.length <= floor) return undefined;
    // The agent asked again for something already trimmed this turn: give it everything.
    const key = `${event.toolName}:${JSON.stringify(event.input)}`;
    if (trimmedThisTurn.has(key)) return undefined;
    const jev = await jevState;
    if (jev.kind !== "ready") return undefined;

    const { lines, blocks } = blocksFor(text, settings.trim);
    const texts = recentTexts(ctx.sessionManager.getBranch());
    const state = trimState({ user_request: texts.user, agent_said: texts.assistant, tool: event.toolName, arguments: JSON.stringify(event.input) }, blocks);
    const outcome = await askJev(ctx.modelRegistry, jev.target, settings.jev.timeoutMs, state, trimQuestions(blocks), ctx.signal);
    if (!outcome.ok) return undefined;
    const usage = addUsage(event.usage as ClassifierUsage | undefined, outcome.usage);
    const fullPath = savePath(ctx, event.toolCallId);
    const verdict = trimVerdict(lines, blocks, outcome.answers, settings.trim, fullPath);
    pi.appendEntry(DECISION_TYPE, {
      kind: "trim",
      tool: event.toolName,
      lines: verdict.totalLines,
      kept: verdict.trim ? verdict.keptLines : verdict.totalLines,
      needsAll: verdict.needsAll,
      blocks: blocks.length,
      latencyMs: outcome.latencyMs,
      inputTokens: outcome.usage?.input,
    });
    const passUsage = usage ? { usage: usage as never } : undefined;
    if (!verdict.trim) return passUsage;
    try {
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    } catch {
      return passUsage;
    }
    trimmedThisTurn.add(key);
    saved += text.length - verdict.text.length;
    if (ctx.hasUI) ctx.ui.setStatus(TRIM_STATUS_KEY, trimStatus(saved));
    return {
      content: [...content.filter((b) => b.type !== "text"), { type: "text", text: verdict.text }] as never,
      ...(passUsage ?? {}),
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const request = armed;
    armed = undefined;
    failure = undefined;
    const jevOnly = request !== undefined || event.reason === "overflow";
    const fail = (reason: string) => {
      failure = reason;
      if (request?.strict) return { cancel: true };
      if (jevOnly && ctx.hasUI) ctx.ui.notify(`Jev compaction: ${reason}; using Pi's compaction.`, "warning");
      return undefined;
    };
    if (!settings.enabled || (!jevOnly && !settings.compact.filter)) return undefined;
    const jev = await jevState;
    if (jev.kind === "off" && !request) return undefined;
    if (jev.kind !== "ready") return jevOnly ? fail(jev.kind === "off" ? "Jev is off" : `Jev is not set up (${jev.reason})`) : undefined;
    const prep = event.preparation;
    const main = extractUnits(prep.messagesToSummarize, "U");
    const prefix = extractUnits(prep.turnPrefixMessages, "P");
    const units = [...main, ...prefix];
    if (!units.length) return jevOnly ? fail("nothing for Jev to judge") : undefined;

    const goal = request?.goal?.trim() || event.customInstructions?.trim() || lastUserMessages(event.branchEntries, 2);
    const judged = await judgeUnits(ctx, jev.target, units, goal, event.signal);
    if (!judged.ok) return fail(judged.reason);
    const { keep, usage } = judged;
    const counts = keepCounts(keep);
    pi.appendEntry(DECISION_TYPE, { kind: "compact", jevOnly, units: units.length, ...counts, latencyMs: judged.latencyMs });

    if (jevOnly) {
      const summary = codeSummary({ units, keep, previousSummary: prep.previousSummary, fileOps: prep.fileOps, instructions: event.customInstructions });
      return {
        compaction: {
          summary,
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          details: { cacheGuard: { mode: "jev", ...counts } },
          ...(usage ? { usage: usage as never } : {}),
        },
      };
    }

    const model = ctx.model;
    if (!model) return undefined;
    try {
      const auth = (await ctx.modelRegistry.getApiKeyAndHeaders(model)) as { ok: boolean; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
      if (!auth.ok) return undefined;
      const filtered = {
        ...prep,
        messagesToSummarize: filterMessages(prep.messagesToSummarize, main, keep),
        turnPrefixMessages: filterMessages(prep.turnPrefixMessages, prefix, keep),
      } as typeof prep;
      const result = await compact(filtered, model, auth.apiKey, auth.headers, event.customInstructions, event.signal, undefined, undefined, auth.env);
      const verbatim = verbatimSection(units, keep);
      const resultUsage = (result as { usage?: ClassifierUsage }).usage;
      const total = addUsage(resultUsage, usage);
      return {
        compaction: {
          ...result,
          summary: verbatim ? `${result.summary}\n\n${verbatim}` : result.summary,
          details: { ...(isRecord(result.details) ? result.details : {}), cacheGuard: { mode: "filtered", ...counts } },
          ...(total ? { usage: total as never } : {}),
        },
      };
    } catch {
      return undefined;
    }
  });

  async function judgeUnits(ctx: ExtensionContext, target: { provider: string; model: string }, units: Unit[], goal: string, signal: AbortSignal) {
    const started = Date.now();
    const keep = new Map<string, Keep>();
    let usage: ClassifierUsage | undefined;
    const queue = batches(units);
    let reason: string | undefined;
    const worker = async () => {
      for (let batch = queue.shift(); batch && !reason; batch = queue.shift()) {
        const outcome = await askJev(ctx.modelRegistry, target, settings.compact.timeoutMs, keepState(goal, batch), keepQuestions(batch), signal);
        if (!outcome.ok) {
          reason = outcome.reason;
          return;
        }
        usage = addUsage(usage, outcome.usage);
        keepAnswers(batch, outcome.answers, keep);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, settings.compact.concurrency) }, worker));
    if (reason) return { ok: false as const, reason: `Jev failed (${reason})` };
    return { ok: true as const, keep, usage, latencyMs: Date.now() - started };
  }

  return {
    jev: (ctx) => {
      if (ctx) reload(ctx);
      return jevState;
    },
    refresh: (ctx) => {
      settings = loadSettings(ctx.cwd, ctx.isProjectTrusted());
      return refresh(ctx);
    },
    armJevCompaction: (options) => {
      armed = options;
    },
    disarm: () => {
      armed = undefined;
    },
    lastFailure: () => failure,
    savedChars: () => saved,
  };
}

function savePath(ctx: ExtensionContext, toolCallId: string) {
  const session = ctx.sessionManager.getSessionId?.() ?? "session";
  return path.join(agentDir(), "cache-guard", "tool-output", session.replace(/[^\w.-]/gu, "_"), `${toolCallId.replace(/[^\w.-]/gu, "_")}.txt`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
