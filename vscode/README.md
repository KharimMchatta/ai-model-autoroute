# AMA (AI Model Autoroute) for VS Code

The on/off switch and live view for the `ai-model-autoroute` Claude Code mod. The mod switches a fresh Claude window's first message to Opus 5.5 or Sonnet 5.5 by task type; once Claude has replied in a window, the mod leaves it alone. This extension never talks to Claude Code: the only link is two local JSON files.

## What it shows

- Status bar (right): `AMA on`, `AMA off` (warning colour), or `AMA ?` (error colour) when the state file is invalid. The tooltip lists the state and the last decision.
- Panel (click the status item, or run `AMA: Open AI Model Autoroute`): one switch, a state chip, the last 10 decisions, and the two commands `/ai-model-autoroute on` and `/ai-model-autoroute off`.
- The view refreshes every 5 seconds while the window is focused, and at once after a toggle. `AMA: Refresh now` forces a read.

## The contract

State folder: `$AMA_STATE_DIR` if set, otherwise `~/.claude/ama` (created 0700 on first write).

- `state.json`: `{ "version": 1, "enabled": true, "updatedAt": "<ISO>", "updatedBy": "panel" }`. A missing file means ON. An unreadable, oversized (over 64 KB), non-JSON, wrong-version or non-boolean file is INVALID; the mod treats INVALID as OFF, and the toggle rewrites a valid file. Writes are atomic (temp file `wx`, mode 0600, rename).
- `decisions.json`: written by the mod only, read-only here. `{ "version": 1, "decisions": [ { at, kind, label, from, to, switched, ms, inputTokens, outputTokens, reason } ] }`, newest last, at most 50. Every field is validated and invalid entries are dropped. A half-written file is ignored for that refresh.

## Build

Plain CommonJS, no build step, no dependencies.

```
node test/run-tests.js
npx --yes @vscode/vsce@4.0.0 package --no-dependencies
```

This produces `ama-0.2.0.vsix`.

## Install

```
code --install-extension ama-0.2.0.vsix
```

For a reinstall add `--force`, then run `Developer: Reload Window`.

## Undo

```
code --uninstall-extension kharimmchatta.ama
```

State files are left in place; delete `~/.claude/ama` by hand if you want them gone.

MIT licensed.
