import { describe, expect, test } from "vitest";

import {
  ConfirmMemo,
  DEFAULT_SETTINGS,
  claudePrice,
  decideWarm,
  describeMiss,
  formatClock,
  formatDuration,
  mergeSettings,
  missCost,
  warmDeadline,
  warmDelayMs,
  worthWarning,
} from "../src/core.ts";

const opus = { input: 4, cacheRead: 0.2, cacheWrite: 5 };

describe("timing", () => {
  test("refreshes at 90% of the TTL with ten seconds of margin", () => {
    expect(warmDelayMs(300_000)).toBe(270_000);
    expect(warmDelayMs(3_600_000)).toBe(3_240_000);
    expect(warmDelayMs(60_000)).toBe(50_000);
    expect(warmDelayMs(10_000)).toBeUndefined();
  });

  test("idle horizon depends on the tier", () => {
    expect(warmDeadline(0, 300_000, DEFAULT_SETTINGS)).toBe(30 * 60_000);
    expect(warmDeadline(0, 3_600_000, DEFAULT_SETTINGS)).toBe(120 * 60_000);
  });
});

describe("costs", () => {
  test("a miss rewrites the prefix at the tier's write price instead of reading it", () => {
    expect(missCost(1_000_000, opus, 300_000)).toBeCloseTo(4.8);
    expect(missCost(1_000_000, opus, 3_600_000)).toBeCloseTo(7.8); // 2x input, 1h tier
    expect(missCost(1_000_000, { input: 3, cacheRead: 0.3 }, 300_000)).toBeCloseTo(3.45); // 1.25x default
  });

  test("Pi's idle rule warms Opus 5.5 from about 96k tokens", () => {
    expect(decideWarm(90_000, opus, 300_000, true, DEFAULT_SETTINGS).action).toBe("stop");
    expect(decideWarm(100_000, opus, 300_000, true, DEFAULT_SETTINGS).action).toBe("warm");
    expect(decideWarm(12_000, opus, 300_000, false, DEFAULT_SETTINGS).action).toBe("warm");
  });

  test("Claude prices by longest prefix", () => {
    expect(claudePrice("claude-opus-5-5")).toEqual({ input: 4, cacheRead: 0.2 });
    expect(claudePrice("claude-opus-5-20260101")).toEqual({ input: 5, cacheRead: 0.5 });
    expect(claudePrice("claude-fable-5-1[1m]")).toEqual({ input: 10, cacheRead: 0.25 });
    expect(claudePrice("anthropic/claude-sonnet-4-6")).toEqual({ input: 3, cacheRead: 0.3 });
  });
});

describe("warnings", () => {
  test("threshold in dollars when priced, tokens otherwise", () => {
    expect(worthWarning(50_000, 0.24, DEFAULT_SETTINGS)).toBe(false);
    expect(worthWarning(200_000, 0.96, DEFAULT_SETTINGS)).toBe(true);
    expect(worthWarning(150_000, undefined, DEFAULT_SETTINGS)).toBe(true);
    expect(worthWarning(50_000, undefined, DEFAULT_SETTINGS)).toBe(false);
    const off = mergeSettings(DEFAULT_SETTINGS, ['{"warn":{"enabled":false}}']);
    expect(worthWarning(1e6, 10, off)).toBe(false);
  });

  test("describes each cause", () => {
    expect(describeMiss({ kind: "expired", idleMs: 600_000 }, 664_000, 3.19)).toBe(
      "The prompt cache expired 10m ago: this prompt re-caches 664k tokens (~$3.19 at API prices).",
    );
    expect(describeMiss({ kind: "model", from: "claude-opus-5-5", to: "claude-sonnet-5-5" }, 1_200_000, undefined)).toContain(
      "claude-sonnet-5-5 has no cache",
    );
    expect(describeMiss({ kind: "idle", idleMs: 4 * 3_600_000 }, 200_000, undefined)).toContain("Idle 4h");
  });

  test("a blocked prompt goes through when sent again in the window", () => {
    const memo = new ConfirmMemo();
    expect(memo.confirmed("s", "hello", 0, 120_000)).toBe(false);
    memo.arm("s", "hello ", 0);
    expect(memo.confirmed("s", "hello", 60_000, 120_000)).toBe(true);
    expect(memo.confirmed("s", "hello", 60_000, 120_000)).toBe(false); // consumed
    memo.arm("s", "hello", 0);
    expect(memo.confirmed("s", "hello", 200_000, 120_000)).toBe(false); // too late
    memo.arm("s", "hello", 0);
    expect(memo.confirmed("t", "hello", 1, 120_000)).toBe(false); // other session
  });
});

describe("formatting", () => {
  test("clock and durations", () => {
    expect(formatClock(252_000)).toBe("4:12");
    expect(formatClock(3_900_000)).toBe("1h05m");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(3 * 3_600_000 + 20 * 60_000)).toBe("3h20m");
    expect(formatDuration(52 * 3_600_000)).toBe("2d4h");
  });

  test("settings merge objects and ignore bad JSON", () => {
    const s = mergeSettings(DEFAULT_SETTINGS, ['{"warn":{"minCost":2}}', "{nope", '{"warm":{"idleMinutes":{"1h":60}}}']);
    expect(s.warn.minCost).toBe(2);
    expect(s.warn.minTokens).toBe(100_000);
    expect(s.warm.idleMinutes).toEqual({ "5m": 30, "1h": 60 });
  });
});
