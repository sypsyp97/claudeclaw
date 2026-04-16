/**
 * Coalescer — wraps a `flush` function behind a leading-debounce timer so
 * rapid bursts of `schedule()` calls produce at most one flush per window.
 *
 * Used by Discord/Telegram sinks to cap message-edit rate well below their
 * per-route limits (Discord ~5 edits/5s per channel, Telegram ~1/s per chat).
 *
 * Semantics:
 *
 *   - First `schedule()` arms a timer for `windowMs` ms.
 *   - Further `schedule()` calls while armed do nothing — the existing timer
 *     continues to its deadline and then fires exactly once.
 *   - On fire, `flush()` runs. Exceptions are caught and swallowed so one
 *     failed edit doesn't poison subsequent events.
 *   - `forceFlush()` cancels the timer if armed and runs `flush()` right now.
 *     If nothing is pending, it's a no-op.
 *   - `dispose()` cancels without running.
 */

const DEFAULT_WINDOW_MS = 750;

export interface Coalescer {
  schedule(): void;
  forceFlush(): Promise<void>;
  dispose(): void;
}

export interface CoalescerOptions {
  windowMs?: number;
}

export function createCoalescer(
  flush: () => Promise<void>,
  options: CoalescerOptions = {},
): Coalescer {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function runFlush(): Promise<void> {
    timer = null;
    try {
      await flush();
    } catch {
      // swallow — caller is a status-display channel, never critical path
    }
  }

  return {
    schedule(): void {
      if (timer !== null) return;
      timer = setTimeout(() => {
        void runFlush();
      }, windowMs);
    },

    async forceFlush(): Promise<void> {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      try {
        await flush();
      } catch {
        // swallow — forceFlush is typically called at close(); we don't want
        // a last-edit failure to mask the underlying task result.
      }
    },

    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
