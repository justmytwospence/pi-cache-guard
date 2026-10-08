// pi-cache-guard: asks before a prompt that would re-cache a large conversation, and publishes the
// prompt cache's time left as the `cache-guard` status (pi-status-footer folds it into its context
// row). Keeping the cache warm is Pi's own job: `cacheWarming: "idle"` in settings.json. Its
// refreshes are `cache_warm` usage entries, which this clock reads as cache activity.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { type CacheView, type LastRequest, type ModelInfo, lastRequest, view } from "./clock.ts";
import { loadSettings } from "./config.ts";
import { HerdrReporter } from "./herdr.ts";
import {
  DEFAULT_SETTINGS,
  NAME,
  type Settings,
  describeMiss,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  choiceCosts,
  compactionFocus,
  herdrCacheValue,
  missCost,
  worthWarning,
} from "./core.ts";

const STATUS_KEY = NAME;
const TICK_MS = 1_000;
/** The guidance choices after "Compact first". */
const SUMMARY_DEFAULT = "Default summary";
const SUMMARY_FOCUS = "Focus the summary on this prompt";
const SUMMARY_WRITE = "Write guidance for the summary...";

type ModelLike = NonNullable<ExtensionContext["model"]>;

/** The TTL Pi requests for this model: its `promptCache` lifetime for the active retention tier. */
export function modelInfo(model: ModelLike | undefined, env: NodeJS.ProcessEnv = process.env): ModelInfo | undefined {
  if (!model) return undefined;
  const retention = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
  const seconds = (model as { promptCache?: { short?: number; long?: number } }).promptCache?.[retention];
  const cost = model.cost;
  const price = cost && cost.input > 0
    ? { input: cost.input, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite > 0 ? cost.cacheWrite : cost.input }
    : undefined;
  return { provider: model.provider, id: model.id, ttlMs: seconds === undefined ? undefined : seconds * 1000, price };
}

/** The status text: time left while warm, "cold" once the next request misses. */
export function statusText(v: CacheView | undefined): string | undefined {
  if (!v) return undefined;
  if (v.remainingMs !== undefined) return `cache ${formatClock(v.remainingMs)}`;
  if (v.cold?.kind === "model") return "cache cold (model)";
  if (v.cold) return v.cold.kind === "idle" ? "cache cold?" : "cache cold";
  return undefined;
}

export type Choice = "keep" | "compact" | "fresh" | "send" | "mute";

/**
 * The ways through a cold cache, labelled with what they cost. Keeping the prompt is first, so a
 * reflexive Enter does not spend the re-cache; the rest run from cheapest to dearest.
 */
export function choiceMenu(v: CacheView): Array<{ choice: Choice; label: string }> {
  const costs = v.price ? choiceCosts(v.last.tokens, v.price, v.ttlMs ?? 5 * 60_000) : undefined;
  const about = (cost: number | undefined) => (cost === undefined ? "" : ` (~${formatCost(cost)})`);
  return [
    { choice: "keep", label: "Keep the prompt in the editor" },
    { choice: "fresh", label: "Start a new session with this prompt (no history, ~$0)" },
    { choice: "compact", label: `Compact first, then send it${about(costs?.compact)}` },
    { choice: "send", label: `Send anyway${about(costs?.send)}` },
    { choice: "mute", label: "Send, and stop asking in this session" },
  ];
}

/** The cost of the miss `v` describes, in dollars at list prices, when Pi knows the model's prices. */
export function coldCost(v: CacheView): number | undefined {
  if (!v.cold || !v.price) return undefined;
  return missCost(v.last.tokens, v.price, v.ttlMs ?? 5 * 60_000);
}

export default function cacheGuard(pi: ExtensionAPI, options: { herdr?: HerdrReporter } = {}) {
  // Inside a herdr pane: the `cache` token, so herdr's agents sidebar shows this session when doomed.
  const herdr = options.herdr ?? new HerdrReporter("pi");
  let ctx: ExtensionContext | undefined;
  let settings: Settings = DEFAULT_SETTINGS;
  let sessionOn = true;
  // "Send, and stop asking": the warning is off for this session, the clock and herdr stay on.
  let askOn = true;
  // A held prompt the `/cache-guard fresh` command carries into a new session.
  let pending: { text: string; images?: ImageContent[] } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let shown: string | undefined;
  // Request start of the assistant message streaming now; the branch only has it at message_end.
  let live: { at: number; provider: string; model: string } | undefined;

  const current = (context: ExtensionContext): CacheView | undefined => {
    const info = modelInfo(context.model);
    if (!info) return undefined;
    let last: LastRequest | undefined = lastRequest(context.sessionManager.getBranch());
    if (live && last && live.provider === last.provider && live.model === last.model && live.at > last.at) {
      last = { ...last, at: live.at, realAt: live.at };
    }
    if (!last) return undefined;
    return view(last, info, Date.now(), settings.warn.idleMinutes * 60_000);
  };

  const publish = () => {
    if (!ctx) return;
    const v = sessionOn && settings.enabled ? current(ctx) : undefined;
    const text = statusText(v);
    if (text !== shown) {
      shown = text;
      ctx.ui.setStatus(STATUS_KEY, text);
    }
    herdr.report(v ? herdrCacheValue(v.cold, v.last.tokens, coldCost(v), settings) : undefined);
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (ctx && shown !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
    shown = undefined;
    void herdr.clear();
    ctx = undefined;
    live = undefined;
  };

  pi.on("session_start", (_event, context) => {
    stop();
    ctx = context;
    sessionOn = true;
    askOn = true;
    settings = loadSettings(context.cwd);
    if (!context.hasUI) return;
    publish();
    timer = setInterval(publish, TICK_MS);
    timer.unref?.();
  });
  pi.on("session_shutdown", () => stop());
  // The context or model changed under the clock: drop the streaming message's start time.
  const refresh = (context: ExtensionContext, keepLive: boolean) => {
    if (!ctx) return;
    ctx = context;
    if (!keepLive) live = undefined;
    publish();
  };
  pi.on("model_select", (_event, context) => refresh(context, false));
  pi.on("session_tree", (_event, context) => refresh(context, false));
  pi.on("session_compact", (_event, context) => refresh(context, false));
  pi.on("agent_settled", (_event, context) => refresh(context, true));
  pi.on("message_start", (event, context) => {
    const message = event.message as { role?: string; timestamp?: number; provider?: string; model?: string };
    if (message.role !== "assistant" || typeof message.timestamp !== "number") return;
    live = { at: message.timestamp, provider: String(message.provider ?? ""), model: String(message.model ?? "") };
    if (ctx) {
      ctx = context;
      publish();
    }
  });

  pi.on("input", async (event, context) => {
    if (!sessionOn || !askOn || event.source !== "interactive" || event.streamingBehavior !== undefined || !context.hasUI) {
      return { action: "continue" };
    }
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
    settings = loadSettings(context.cwd);
    const v = current(context);
    if (!v?.cold) return { action: "continue" };
    const cost = coldCost(v);
    if (!worthWarning(v.last.tokens, cost, settings)) return { action: "continue" };
    const menu = choiceMenu(v);
    const label = await context.ui.select(`Prompt cache miss. ${describeMiss(v.cold, v.last.tokens, cost)}`, menu.map((item) => item.label));
    const choice = menu.find((item) => item.label === label)?.choice ?? "keep";
    const keep = () => {
      context.ui.setEditorText(event.text);
      return { action: "handled" as const };
    };
    const content: string | (TextContent | ImageContent)[] = event.images?.length
      ? [{ type: "text", text: event.text }, ...event.images]
      : event.text;
    switch (choice) {
      case "send":
        return { action: "continue" };
      case "mute":
        askOn = false;
        return { action: "continue" };
      case "fresh":
        // Replacing the session is a command's job: run ours once this input has been handled.
        pending = { text: event.text, images: event.images };
        setTimeout(() => void pi.sendUserMessage(`/${NAME} fresh`, { expandPromptTemplates: true }), 0);
        return { action: "handled" };
      case "compact": {
        const how = await context.ui.select("Compact first: what should the summary keep?", [SUMMARY_DEFAULT, SUMMARY_FOCUS, SUMMARY_WRITE]);
        let guidance: string | undefined;
        if (how === SUMMARY_FOCUS) guidance = compactionFocus(event.text);
        else if (how === SUMMARY_WRITE) {
          guidance = await context.ui.input("Guidance for the summary", "what to keep or stress");
          if (guidance === undefined) return keep();
        } else if (how !== SUMMARY_DEFAULT) return keep();
        context.ui.notify("Compacting, then sending your prompt.", "info");
        context.compact({
          customInstructions: guidance?.trim() || undefined,
          onComplete: () => void pi.sendUserMessage(content),
          onError: (error) => {
            context.ui.notify(`Compaction failed (${error.message}); your prompt is back in the editor.`, "warning");
            context.ui.setEditorText(event.text);
          },
        });
        return { action: "handled" };
      }
      default:
        return keep();
    }
  });

  pi.registerCommand(NAME, {
    description: "Prompt cache: status, on, or off (this session)",
    getArgumentCompletions: (prefix) => ["status", "on", "off", "fresh"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, context) => {
      const command = args.trim() || "status";
      if (command === "fresh") {
        // A new session (linked to this one) that starts with the held prompt, or the editor's text.
        const carry = pending ?? (context.ui.getEditorText().trim() ? { text: context.ui.getEditorText() } : undefined);
        pending = undefined;
        if (!carry) {
          context.ui.notify("/cache-guard fresh starts a new session with the prompt in the editor; the editor is empty.", "info");
          return;
        }
        const parentSession = context.sessionManager.getSessionFile();
        const result = await context.newSession({
          parentSession,
          withSession: async (fresh) => {
            await fresh.sendUserMessage(carry.images?.length ? [{ type: "text", text: carry.text }, ...carry.images] : carry.text);
          },
        });
        if (result.cancelled) context.ui.setEditorText(carry.text);
        return;
      }
      if (command === "on" || command === "off") {
        sessionOn = command === "on";
        askOn = sessionOn;
        ctx = context;
        publish();
        context.ui.notify(`cache-guard ${command} for this session`, "info");
        return;
      }
      settings = loadSettings(context.cwd);
      const v = current(context);
      const lines: string[] = [];
      if (!v) {
        lines.push("No cached request on this branch yet (or the context was just compacted).");
      } else {
        const info = modelInfo(context.model);
        lines.push(`Last request: ${v.last.provider}/${v.last.model}, ${formatTokens(v.last.tokens)} tokens, ${formatDuration(Date.now() - v.last.realAt)} ago` +
          (v.last.at > v.last.realAt ? `; refreshed by cache warming ${formatDuration(Date.now() - v.last.at)} ago.` : "."));
        lines.push(info?.ttlMs === undefined
          ? `TTL: not published for ${info?.provider}/${info?.id}; warning after ${settings.warn.idleMinutes}m idle.`
          : `TTL: ${formatDuration(info.ttlMs)} (${process.env.PI_CACHE_RETENTION === "long" ? "PI_CACHE_RETENTION=long" : "short retention"}).`);
        if (v.remainingMs !== undefined) lines.push(`Warm: ${formatClock(v.remainingMs)} left.`);
        if (v.cold) {
          const cost = coldCost(v);
          lines.push(describeMiss(v.cold, v.last.tokens, cost));
          lines.push(worthWarning(v.last.tokens, cost, settings) ? "The next prompt asks before sending." : "Below the warning threshold.");
        }
      }
      lines.push(`Warning: ${sessionOn && settings.enabled && settings.warn.enabled ? `on, from ${formatCost(settings.warn.minCost)} (or ${formatTokens(settings.warn.minTokens)} tokens without prices)` : "off"}. Keep-warm: Pi's cacheWarming setting (/session shows its next decision).`);
      context.ui.notify(lines.join("\n"), "info");
    },
  });
}
