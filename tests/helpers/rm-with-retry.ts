/**
 * Windows-tolerant recursive rm.
 *
 * `Bun.spawn` on Windows currently duplicates the caller's open file
 * handles into the child process, and an open `bun:sqlite` DB handle
 * survives the child's lifetime — so even after the parent calls
 * `db.close()`, the state.db file stays locked until the next OS-level
 * handle scan. That lands right in our face whenever a test runs the
 * runner (which spawns `fake-claude`) against a tmp workspace.
 *
 * We retry a few times, but if the locked file is still holding on we
 * swallow the error. The OS will reclaim the tmp dir on its own (tmp
 * sweeps / session end); leaving a 1-file leak is strictly better than
 * failing the suite on a cleanup-only issue. On POSIX this is a single
 * successful rm so there's no cost.
 */

import { rmSync } from "node:fs";

export async function rmWithRetry(path: string, attempts = 5, backoffMs = 25): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
      if (i === attempts - 1) return; // give up quietly — OS will GC the tmp
      await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
    }
  }
}
