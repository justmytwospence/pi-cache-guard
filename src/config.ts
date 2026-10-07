import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_SETTINGS, NAME, type Settings, mergeSettings } from "./core.ts";

/**
 * Shared `~/.config/agents/cache-guard.json`, then `~/.pi/agent/cache-guard.json`, then the
 * project's `.agents/cache-guard.json` and `.pi/cache-guard.json`, each on top of the last (objects
 * merge, other values replace). Unreadable or invalid files are ignored.
 */
export function loadSettings(cwd: string): Settings {
  const files = [
    path.join(sharedConfigDir(), `${NAME}.json`),
    path.join(agentDir(), `${NAME}.json`),
    path.join(cwd, ".agents", `${NAME}.json`),
    path.join(cwd, ".pi", `${NAME}.json`),
  ];
  return mergeSettings(DEFAULT_SETTINGS, files.map((file) => {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    } catch {
      return undefined;
    }
  }));
}

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

/** `$XDG_CONFIG_HOME/agents` (default `~/.config/agents`): settings shared with the other ports. */
export function sharedConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agents");
}
