// Jev through Pi's own classifier models: `ctx.modelRegistry.getAvailableOfType("classifier")`,
// `findOfType` and `classify()`. Pi resolves the credentials (TYPESAFE_API_KEY or `/login typesafe`
// for its `typesafe` provider; OpenRouter, Vercel AI Gateway, Cloudflare and OpenCode serve Jev
// too), applies the timeout and abort signal, and reports token usage. The registry types are
// mirrored structurally, so this type-checks against older Pi type packages as well.
import type { Answer, Question } from "./lean.ts";

export interface ClassifierUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface ClassifierResult {
  model: string;
  answers: Record<string, Answer>;
  usage?: ClassifierUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}

/** The part of Pi's model registry this package uses. */
interface ClassifierRegistry {
  findOfType(type: "classifier", provider: string, modelId: string): unknown;
  getAvailableOfType(type: "classifier", provider?: string): Promise<readonly { provider: string; id: string }[]>;
  classify(
    model: never,
    context: { state: Record<string, unknown>; questions: Record<string, Question> },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ClassifierResult>;
}

export interface JevTarget {
  provider: string;
  model: string;
}

/** The providers Pi lists Jev under, most direct first. */
export const JEV_MODELS: readonly JevTarget[] = [
  { provider: "typesafe", model: "jev-latest" },
  { provider: "openrouter", model: "~typesafe/jev-latest" },
  { provider: "openrouter", model: "typesafe/jev-1.13" },
  { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" },
  { provider: "cloudflare-workers-ai", model: "typesafe/jev" },
  { provider: "opencode", model: "jev-1.13" },
];

/** What `/login` needs for each provider that serves Jev, for the setup hints. */
export const JEV_LOGINS: ReadonlyArray<{ provider: string; label: string }> = [
  { provider: "typesafe", label: "TypeSafe (a TypeSafe API key)" },
  { provider: "openrouter", label: "OpenRouter (an OpenRouter key or account)" },
];

export const label = (t: JevTarget) => `${t.provider}/${t.model}`;

export type JevState =
  | { kind: "ready"; target: JevTarget; others: JevTarget[] }
  | { kind: "missing"; reason: string }
  | { kind: "off" };

/**
 * Which Jev to use: the configured one when its provider has credentials, else the first of
 * `JEV_MODELS` that Pi can reach. Never throws.
 */
export async function resolveJev(registry: unknown, settings: { enabled: boolean; provider: string; model: string }): Promise<JevState> {
  if (!settings.enabled) return { kind: "off" };
  const reg = registry as Partial<ClassifierRegistry> | undefined;
  if (typeof reg?.classify !== "function" || typeof reg.getAvailableOfType !== "function") {
    return { kind: "missing", reason: "this Pi has no classifier models (needs Pi 0.99 or newer)" };
  }
  // Only the providers that serve Jev are asked, so no other provider's credentials are resolved.
  const providers = [...new Set([...(settings.provider ? [settings.provider] : []), ...JEV_MODELS.map((t) => t.provider)])];
  const available: { provider: string; id: string }[] = [];
  for (const provider of providers) {
    try {
      available.push(...(await reg.getAvailableOfType("classifier", provider)));
    } catch {
      // A provider whose credentials fail to resolve does not serve Jev here.
    }
  }
  const has = (t: JevTarget) => available.some((m) => m.provider === t.provider && m.id === t.model);
  const found = JEV_MODELS.filter(has);
  if (settings.provider) {
    const model = settings.model || JEV_MODELS.find((t) => t.provider === settings.provider)?.model || "jev-latest";
    const target = { provider: settings.provider, model };
    if (!has(target)) return { kind: "missing", reason: `${label(target)} is not available (no credentials, or no such classifier)` };
    return { kind: "ready", target, others: found.filter((t) => label(t) !== label(target)) };
  }
  const [first, ...others] = found;
  if (!first) return { kind: "missing", reason: "no provider with Jev has credentials" };
  return { kind: "ready", target: first, others };
}

export type JevOutcome =
  | { ok: true; answers: Record<string, Answer>; usage?: ClassifierUsage; latencyMs: number }
  | { ok: false; reason: string };

/** Ask Jev one request. Never throws: every failure is `{ ok: false, reason }`. */
export async function askJev(
  registry: unknown,
  target: JevTarget,
  timeoutMs: number,
  state: Record<string, unknown>,
  questions: Record<string, Question>,
  signal?: AbortSignal,
): Promise<JevOutcome> {
  const reg = registry as Partial<ClassifierRegistry> | undefined;
  if (typeof reg?.findOfType !== "function" || typeof reg.classify !== "function") {
    return { ok: false, reason: "this Pi has no classifier models (needs Pi 0.99 or newer)" };
  }
  let model: unknown;
  try {
    model = reg.findOfType("classifier", target.provider, target.model);
  } catch {
    model = undefined;
  }
  if (!model) return { ok: false, reason: `no classifier model ${label(target)}` };
  const started = Date.now();
  try {
    const result = await reg.classify(model as never, { state, questions }, { timeoutMs, ...(signal ? { signal } : {}) });
    if (result.stopReason !== "stop") return { ok: false, reason: describe(result.stopReason, result.errorMessage) };
    return { ok: true, answers: result.answers, ...(result.usage ? { usage: result.usage } : {}), latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: describe("error", error instanceof Error ? error.message : String(error)) };
  }
}

/** A one-question request, to check that Jev answers with the credentials Pi has. */
export function probe(registry: unknown, target: JevTarget, timeoutMs = 10_000): Promise<JevOutcome> {
  return askJev(registry, target, timeoutMs, { message: "The tests pass now, thanks." }, {
    approved: { type: "bool", instructions: "Is the user satisfied?", criteria: { true: "Satisfied", false: "Not satisfied" } },
  });
}

function describe(stopReason: string, message: string | undefined) {
  if (stopReason === "aborted") return "cancelled";
  const text = (message ?? "").replace(/\s+/gu, " ");
  if (/No API key/iu.test(text)) return "no credentials";
  if (/\b401\b|unauthori[sz]ed/iu.test(text)) return "invalid API key";
  if (/timed out|timeout/iu.test(text)) return "timed out";
  return text.slice(0, 160) || "unknown error";
}

export function addUsage(a: ClassifierUsage | undefined, b: ClassifierUsage | undefined): ClassifierUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
