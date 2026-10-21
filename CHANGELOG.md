# Changelog

Versioning: MAJOR.MINOR.SECURITY. MAJOR is a major change and resets everything (2.0.0). MINOR counts updates and non-security bug fixes. SECURITY goes up by 1 for each release that contains security fixes and does not reset when MINOR goes up.
Example: 1.0.0, 1.1.0, 1.2.1 (updates plus a security fix), 1.2.2 (security fix only), 1.3.2 (updates only), 2.0.0 (major change).

The mod and the extension share one version number from 0.2.0.

## Extension 0.2.0 - 2026-10-21

### Other Changes

- Repository URL in `package.json` corrected to `https://github.com/KharimMchatta/ai-model-autoroute`. No behaviour change.

## Mod 0.2.0 - 2026-10-21

### Other Changes

- The mid-window lift (Sonnet to Opus once Claude has replied) is turned off. A window that already has an assistant reply now passes straight through: no classifier call, no switch, no decision logged. Repeat runs of the lift measured 7.4% to 8.1% wrong lifts on follow-up messages against a 5% gate; its earlier 4.5% pass was the outlier. The code stays in `hooks/classifier.ts` and `hooks/register.ts` (a comment at the guard says how to re-enable it).
- The fresh-window switch is unchanged.

## Mod 0.1.0 - 2026-10-21

### Features

- First release. On a fresh window's first typed prompt, asks Sonnet 5.5 (effort medium) whether the task routes to Opus 5.5 or Sonnet 5.5, switches with `/model` when it differs, and resends the prompt. Works in both directions. A 1M-context window switches to the 1M variant.
- Leaves the model unchanged (fails open) on Fable and Haiku windows, prompts with attachments, unclear labels, and any error or timeout.
- Mid-window lift: once Claude had replied, a Sonnet window could be lifted to Opus. (Turned off in 0.2.0.)
- Command `/ai-model-autoroute on|off|status|check <text>`.
- State files `~/.claude/ama/state.json` (missing means on, invalid means off) and `~/.claude/ama/decisions.json` (last 50 decisions, metadata only, no prompt text).

## Extension 0.1.0 - 2026-10-21

### Features

- VS Code extension `kharimmchatta.ama`: a status bar item, `AMA on`, `AMA off` or `AMA ?` (state file invalid), with a tooltip showing the state and the last decision.
- Panel on click (or `AMA: Open AI Model Autoroute`): one on/off switch, a state chip, the last 10 decisions, and the two commands.
- Command `AMA: Refresh now`. The view refreshes every 5 seconds while the window is focused.
- Talks to the mod only through the two state files; it never talks to Claude Code.

### Other Changes

- MIT licence. Plain CommonJS, no dependencies, no build step. Build pinned to `@vscode/vsce@4.0.0`. VS Code 1.94 or newer.
- Test suite in `vscode/test/`, run with `node test/run-tests.js`.
