# AMA (AI Model Autoroute)

AMA picks the model for a new Claude Code window from the first thing you type. If the task is light writing it can run on Sonnet 5.5; if it is real work it runs on Opus 5.5. You do not click the model picker.

It has two parts that share two small JSON files:

- a **Claude Code mod** (`mod/`, plugin name `ai-model-autoroute`, version 0.2.0): the part that classifies, switches and resends
- a **VS Code extension** (`vscode/`, `kharimmchatta.ama`, version 0.2.0): a status bar item, `AMA on` or `AMA off`, with a panel that switches AMA on and off and shows the last decisions

The extension is optional. The mod works without it.

## What it does

On the **first typed prompt of a fresh window**:

1. AMA holds the prompt and asks Sonnet 5.5 at medium effort one question: does this task route to Opus 5.5 or Sonnet 5.5?
2. If the answer differs from the window's current model, AMA runs `/model` (a 1M-context window switches to the 1M variant), then resends your prompt as you. The switched model reads and answers it.
3. If the answer is the same model, the prompt goes through untouched.

A window is "fresh" until Claude has replied once. Slash commands you run first do not count, so `/ai-model-autoroute status` followed by a caption still routes.

AMA **does nothing, and the model stays as it is** (it fails open) when:

- the window runs Fable or Haiku (anything that is not Opus or Sonnet)
- the prompt has attachments
- the classifier's answer is unclear or says to stay
- anything fails: an API error, an empty reply, a 15-second timeout, a refused switch

If the switch does not take, AMA says so and resends the prompt unchanged. If the resend is refused, your text is put back in the prompt box.

**Once Claude has replied in a window, AMA does nothing.** The mod also contains a mid-window lift from Sonnet to Opus, but it has been off since 0.2.0 (see Limits).

### Commands

| Command | What it does |
|---|---|
| `/ai-model-autoroute on` | Turns AMA on |
| `/ai-model-autoroute off` | Turns AMA off |
| `/ai-model-autoroute status` | Shows on or off, and the last decision |
| `/ai-model-autoroute check <text>` | Runs the classifier on `<text>` and prints the label, time and tokens. It switches nothing. |

### The VS Code extension

- **Status bar** (right side): `AMA on`, `AMA off` (warning colour), or `AMA ?` (error colour) when the state file is invalid. The tooltip shows the state and the last decision.
- **Panel** (click the status item, or run `AMA: Open AI Model Autoroute`): one switch, a state chip, the last 10 decisions, and the two commands.
- The view refreshes every 5 seconds while the window is focused, and at once after a toggle. `AMA: Refresh now` forces a read.
- The extension never talks to Claude Code. It reads and writes the two files below and nothing else.

## State files

Folder: `~/.claude/ama` (or the folder named by `$AMA_STATE_DIR`, if set).

| File | Written by | Content |
|---|---|---|
| `state.json` | the mod's `on`/`off` commands and the extension's panel | `{ "version": 1, "enabled": true, ... }`. A missing file means **on**. An unreadable, oversized (over 64 KB), non-JSON, wrong-version or non-boolean file is **invalid**, and the mod treats invalid as **off**. |
| `decisions.json` | the mod only | The last 50 decisions, newest last. Each has time, kind, label, model before and after, whether it switched, milliseconds, token counts and the reason. **No prompt text.** |

## Privacy

- The classifier call sends **the first 4000 characters of your prompt** to Sonnet, through Claude Code's own model call. That is the only thing that leaves your computer, and it goes where your prompts already go.
- `decisions.json` holds metadata only (see above). Prompt text is never written to disk by AMA.
- The extension makes no network request.

## How it was tested

Numbers from the build record, 2026-10-21, on the author's own prompts:

- **Classifier choice.** 97 real first prompts, labelled blind with the pass rules fixed first. Haiku failed (9 wrong downgrades to Sonnet). Sonnet passed: 0 wrong downgrades, and 83% of the Sonnet-worthy prompts caught through the CLI, 92% (11 of 12) through the mod's own model call.
- **Speed and size.** Measured medians of 375 to 482 input tokens and 1.4 to 1.5 seconds per decision.
- **Mod.** 86 tests, run with negative controls (a deliberately broken copy of each guard must make a test fail; all killed).
- **Extension.** 42 tests after negative controls (153 of 159 mutants killed, 6 argued equivalent); a headed browser run of the panel (85 checks) and a headed run in a real VS Code on an isolated profile (28 checks).
- **Live.** Checked in a real VS Code: Opus to Sonnet and Sonnet to Opus on fresh windows, a fresh Opus window not switched, slash commands first and then a switch, the panel's off state stopping the switch, and the `on` command writing the state file.

## Limits

- **The routing prompt is written for its author's own work.** `SYSTEM` in `mod/hooks/classifier.ts` names the kinds of work that go to Sonnet (social media captions and community posts, writing in the author's own voice, spreadsheets and formal emails, ingesting a source document or updating a wiki) and the kinds that go to Opus (the author's apps, security work, presentations, training, strategy, CVs, and so on). If your work is different, edit that prompt. The mod's tests spell the prompt out, so update `mod/tests/autoroute.test.ts` to match.
- **The mid-window lift is off.** In 0.1.0, a Sonnet window was lifted to Opus when a later message looked like heavy new work. Repeat runs measured 7.4% to 8.1% of follow-up messages wrongly lifted, against a 5% gate (one earlier run had passed at 4.5%). A fix that showed the classifier the previous reply did not pass either, so 0.2.0 turns the lift off. The code is still there.
- **Only Opus 5.5 and Sonnet 5.5** are routed. Fable and Haiku windows are left alone.
- **Tested on macOS**, against the mod API of Claude Code 2.1.300. Other versions may differ.
- The classifier is a model: it can be wrong, and an unlucky label puts a task on the lighter model. `/ai-model-autoroute check <text>` shows what it would say. `/ai-model-autoroute off` turns it off.

## Install

### Before you start

- **Claude Code** with mod support (the `claude plugin` commands). AMA was tested on 2.1.300.
- For the extension: **VS Code** 1.94 or newer.
- AMA is currently tested on macOS only.

### Install the mod from GitHub

1. Add the marketplace. In a Claude Code window, run:

   ```
   /plugin marketplace add KharimMchatta/ai-model-autoroute
   ```

   Or in a terminal: `claude plugin marketplace add KharimMchatta/ai-model-autoroute`.
2. Install the plugin. Pick one scope:

   ```bash
   claude plugin install ai-model-autoroute@ai-model-autoroute --scope project   # this project only
   claude plugin install ai-model-autoroute@ai-model-autoroute --scope user      # every window
   ```

   Project scope means AMA runs only in windows opened on that project.
3. Restart Claude Code, or open a new window.
4. Check it: type `/ai-model-autoroute status`. It should answer `AMA is on. Last decision: none yet`.

### Install the mod from a local clone

1. Download the source:

   ```bash
   git clone https://github.com/KharimMchatta/ai-model-autoroute.git
   ```

2. Add the cloned folder as a marketplace (use your own path):

   ```bash
   claude plugin marketplace add /path/to/ai-model-autoroute
   ```

3. Install and check exactly as in steps 2 to 4 above.

### Install the VS Code extension from a release file

The `.vsix` is attached to each GitHub release; it is not stored in the repository.

1. Open the [Releases page](https://github.com/KharimMchatta/ai-model-autoroute/releases) and download `ama-<version>.vsix`.
2. Either install it from the command line:

   ```bash
   code --install-extension ama-<version>.vsix
   ```

   or in VS Code open the Extensions view (`Cmd+Shift+X` on macOS), click the **...** menu, choose **Install from VSIX...**, and select the file.
3. For a reinstall of the same version add `--force`, then run **Developer: Reload Window**.
4. Look at the right side of the status bar. You should see `AMA on`. Click it to open the panel.

### Build the extension yourself

You need [Node.js](https://nodejs.org/). The extension itself has no dependencies; `npx` fetches the packaging tool.

1. Clone the source (see above) and go to the extension folder:

   ```bash
   cd ai-model-autoroute/vscode
   ```

2. Run the tests, then package:

   ```bash
   node test/run-tests.js
   npx --yes @vscode/vsce@4.0.0 package --no-dependencies
   ```

   This creates `ama-0.2.0.vsix` in that folder.
3. Install it with the steps above.

## Update

- Mod from GitHub: `claude plugin marketplace update ai-model-autoroute`, then `claude plugin update ai-model-autoroute@ai-model-autoroute --scope project` (or `--scope user`), then restart or open a new window.
- Extension: install the newer `.vsix` with `--force` and reload the window.

## Uninstall

1. Remove the mod (use the scope you installed with):

   ```bash
   claude plugin uninstall ai-model-autoroute@ai-model-autoroute --scope project
   ```

2. Remove the extension:

   ```bash
   code --uninstall-extension kharimmchatta.ama
   ```

3. Optional: delete the state folder, which holds `state.json` and `decisions.json`:

   ```bash
   rm -r ~/.claude/ama
   ```

If you added the marketplace and want it gone too: `claude plugin marketplace remove ai-model-autoroute`.

## Development

From the repository root, with the Claude Code CLI (`claude`):

```bash
claude plugin validate .          # the marketplace
claude plugin validate mod        # the plugin
claude plugin test mod            # the mod's tests (86)
cd vscode && node test/run-tests.js   # the extension's tests
```

The mod's files: `mod/hooks/register.ts` (hooks and commands), `mod/hooks/classifier.ts` (the routing prompts and label parser), `mod/tests/autoroute.test.ts`. The extension is plain CommonJS with no dependencies; the contract between the two parts is in `vscode/README.md`.

## License

MIT. See [LICENSE](LICENSE).
