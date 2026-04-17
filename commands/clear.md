---
description: Clear session and start fresh
---

Clear the current Claude session by backing it up so the next turn starts fresh.

Run:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts --clear
```

This will:
1. Rename `session.json` → `session_<index>.backup` (preserving the old session)
2. Leave any running daemon alone — it will create a brand new session on its next turn

Report the output to the user.
