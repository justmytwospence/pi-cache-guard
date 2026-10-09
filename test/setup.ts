// Every test file runs away from the real settings and agent directory, on the default TTL tier.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "cache-guard-agent-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), "cache-guard-config-"));
delete process.env.PI_CACHE_RETENTION;
