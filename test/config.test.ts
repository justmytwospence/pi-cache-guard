import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { loadSettings, sharedConfigDir, userSettingsFile } from "../src/config.ts";

for (const trusted of [false, true]) {
  test("project settings " + (trusted ? "override user settings when trusted" : "cannot override user settings without trust"), () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cache-guard-project-"));
    const shared = path.join(sharedConfigDir(), "cache-guard.json");
    const user = userSettingsFile();
    const save = (file: string, data: unknown) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data));
    };
    try {
      save(shared, { warn: { minCost: 2, minTokens: 123_456 } });
      save(user, { jev: { enabled: false }, trim: { enabled: false }, compact: { filter: false }, warn: { minCost: 3 } });
      save(path.join(cwd, ".agents/cache-guard.json"), {
        jev: { enabled: true }, trim: { enabled: true }, compact: { filter: true }, warn: { minCost: 4 },
      });
      save(path.join(cwd, ".pi/cache-guard.json"), { warn: { minCost: 5 } });
      const settings = loadSettings(cwd, trusted);
      expect(settings.jev.enabled).toBe(trusted);
      expect(settings.trim.enabled).toBe(trusted);
      expect(settings.compact.filter).toBe(trusted);
      expect(settings.warn.minCost).toBe(trusted ? 5 : 3);
      expect(settings.warn.minTokens).toBe(123_456);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(shared, { force: true });
      rmSync(user, { force: true });
    }
  });
}
