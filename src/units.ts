// Pi's messages in and out of `lean.ts`: the units Jev judges for a compaction, the filtered
// conversation Pi's summarizer reads, and the agent's current step for a trim.
import { type Keep, type Unit, clip, finishUnits } from "./lean.ts";

type AnyMessage = { role?: string; content?: unknown; [key: string]: unknown };

/** Text of a message's content (string or blocks), without thinking or tool calls. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : []))
    .join("\n");
}

/** Split messages into units, pairing each tool call with its result. */
export function extractUnits(messages: readonly unknown[], prefix = "U"): Unit[] {
  const units: Unit[] = [];
  const byCall = new Map<string, Unit>();
  const id = () => `${prefix}${String(units.length + 1).padStart(3, "0")}`;
  messages.forEach((raw, index) => {
    const message = raw as AnyMessage;
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text) units.push({ id: id(), kind: "user", text, message: index });
    } else if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
      const text = textOf(blocks).trim();
      if (text) units.push({ id: id(), kind: "assistant", text, message: index });
      for (const block of blocks) {
        if (block.type !== "toolCall") continue;
        const callId = String(block.id ?? "");
        const unit: Unit = {
          id: id(),
          kind: "tool",
          text: "",
          tool: { name: String(block.name ?? "tool"), args: JSON.stringify(block.arguments ?? {}), result: "", isError: false, callId },
          message: index,
        };
        units.push(unit);
        byCall.set(callId, unit);
      }
    } else if (message.role === "toolResult") {
      const unit = byCall.get(String(message.toolCallId ?? ""));
      if (unit?.tool) {
        unit.tool.result = textOf(message.content);
        unit.tool.isError = message.isError === true;
      }
    } else {
      const text = (textOf(message.content) || (typeof message.command === "string" ? `$ ${message.command}\n${String(message.output ?? "")}` : "")).trim();
      if (text) units.push({ id: id(), kind: "other", text, message: index });
    }
  });
  return finishUnits(units);
}

/**
 * The messages Pi's summarizer reads: dropped units removed, summarize units clipped, thinking
 * removed. Verbatim units are left as they are (they are also appended to the summary).
 */
export function filterMessages(messages: readonly unknown[], units: readonly Unit[], keep: ReadonlyMap<string, Keep>): unknown[] {
  const byMessage = new Map<number, Unit[]>();
  for (const unit of units) byMessage.set(unit.message, [...(byMessage.get(unit.message) ?? []), unit]);
  const callKeep = new Map<string, Keep>();
  for (const unit of units) if (unit.tool) callKeep.set(unit.tool.callId, keep.get(unit.id) ?? "summarize");
  const out: unknown[] = [];
  messages.forEach((raw, index) => {
    const message = raw as AnyMessage;
    const own = byMessage.get(index) ?? [];
    if (message.role === "user" || (message.role !== "assistant" && message.role !== "toolResult")) {
      const unit = own[0];
      const k = unit ? (keep.get(unit.id) ?? "summarize") : "verbatim";
      if (k === "drop") return;
      if (k === "summarize" && message.role === "user") out.push({ ...message, content: clip(unit?.text ?? "", 1_500) });
      else out.push(message);
      return;
    }
    if (message.role === "assistant") {
      const textUnit = own.find((u) => u.kind === "assistant");
      const k = textUnit ? (keep.get(textUnit.id) ?? "summarize") : "drop";
      const blocks = (Array.isArray(message.content) ? message.content : []) as Array<Record<string, unknown>>;
      const kept: Array<Record<string, unknown>> = [];
      let textDone = false;
      for (const block of blocks) {
        if (block.type === "text") {
          if (k === "drop" || textDone) continue;
          textDone = true;
          kept.push({ type: "text", text: k === "summarize" ? clip(textUnit?.text ?? "", 1_000) : (textUnit?.text ?? "") });
        } else if (block.type === "toolCall") {
          if (callKeep.get(String(block.id ?? "")) !== "drop") kept.push(block);
        }
      }
      if (kept.length) out.push({ ...message, content: kept });
      return;
    }
    const k = callKeep.get(String(message.toolCallId ?? "")) ?? "summarize";
    if (k === "drop") return;
    if (k === "summarize") out.push({ ...message, content: [{ type: "text", text: clip(textOf(message.content), 600) }] });
    else out.push(message);
  });
  return out;
}

interface EntryLike {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/** The latest user message and the assistant's latest text after it, on the branch. */
export function recentTexts(entries: readonly unknown[]): { user: string; assistant: string } {
  let user = "";
  let assistant = "";
  for (let i = entries.length - 1; i >= 0 && (!user || !assistant); i--) {
    const entry = entries[i] as EntryLike;
    if (entry?.type !== "message" || !entry.message) continue;
    const text = textOf(entry.message.content).trim();
    if (!text) continue;
    if (!user && entry.message.role === "user") user = text;
    if (!assistant && !user && entry.message.role === "assistant") assistant = text;
  }
  return { user, assistant };
}

/** The last `count` user messages on the branch, oldest first: the goal when none is given. */
export function lastUserMessages(entries: readonly unknown[], count: number): string {
  const texts: string[] = [];
  for (let i = entries.length - 1; i >= 0 && texts.length < count; i--) {
    const entry = entries[i] as EntryLike;
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = textOf(entry.message.content).trim();
    if (text) texts.unshift(clip(text, 1_500));
  }
  return texts.join("\n---\n");
}
