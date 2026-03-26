---
name: "cbrowse"
description: "Use when a task requires controlling a live browser through the cBrowse MCP tools, including navigation, clicking, typing, scrolling, and page inspection."
---

# cBrowse

Use this skill when the task clearly requires live browser control rather than static code analysis.

## Preconditions

The local cBrowse stack must be available:

1. The extension-side bridge client is installed in the browser extension.
2. The local relay is running.
3. The MCP server is configured in Codex.

## Tooling expectations

Prefer these MCP tools:

- `browser_view`
- `browser_navigate`
- `browser_click`
- `browser_input`
- `browser_press_key`
- `browser_scroll`
- `browser_move_mouse`

## Working style

1. Inspect the page state with `browser_view` before acting when the target is uncertain.
2. Prefer selector-based targets when available.
3. Fall back to index or viewport coordinates only when the page metadata makes that necessary.
4. When starting a new browser task, set a short `taskName` and reuse a stable `sessionId` so the dedicated tab group is labeled clearly.
5. After every meaningful action, re-check page state if the next step depends on UI changes.
6. If the bridge is disconnected, stop and report the missing local browser connection.

## Safety

- Do not submit destructive actions unless the user clearly asked for them.
- Treat credentials, payments, and irreversible settings changes as confirmation points.
