// Reports the cache-guard `cache` pane token through pi-herdr's event-bus bridge (`herdr:token`),
// so herdr's agents sidebar can show which sessions are doomed to a cache miss. pi-herdr does the
// herdr work (and only in an interactive pi inside herdr); without it nothing listens. The opencode
// and Codex ports keep their own socket reporter (core.ts stays shared verbatim).
import { HERDR_TOKEN } from "./core.ts";

export interface EventBus {
  emit(channel: string, data: unknown): void;
}

/** Reports the token when it changes; the first report (even "nothing") always goes out. */
export class HerdrReporter {
  private last: string | undefined | null = null;
  private readonly events: EventBus | undefined;

  // No parameter properties: Node's type stripping runs these sources too.
  constructor(events: EventBus | undefined) {
    this.events = events;
  }

  report(value: string | undefined): void {
    if (!this.events || value === this.last) return;
    this.last = value;
    this.events.emit("herdr:token", { key: HERDR_TOKEN, value });
  }

  /** pi-herdr became active after a report: send the current value again. */
  resend(): void {
    if (this.events && typeof this.last === "string") this.events.emit("herdr:token", { key: HERDR_TOKEN, value: this.last });
  }

  /** Clears the token (session end) and forgets what was reported. */
  clear(): Promise<boolean> {
    const had = typeof this.last === "string";
    this.last = null;
    if (this.events && had) this.events.emit("herdr:token", { key: HERDR_TOKEN, value: undefined });
    return Promise.resolve(true);
  }
}
