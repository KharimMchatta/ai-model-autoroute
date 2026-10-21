// AMA (AI Model Autoroute): on/off switch and live view for the ai-model-autoroute Claude Code mod.
// The only link to the mod is two JSON files in the state dir (state.json written here and by the mod's
// slash command, decisions.json written by the mod only). Nothing is sent anywhere. MIT licensed.
// Structure copied from the TokenTrace extension (status item, panel, nonce and CSP fill, focus-gated timer).

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stateLib = require('./lib/state');
const decisionsLib = require('./lib/decisions');
const validate = require('./lib/validate');
const format = require('./lib/format');

const REFRESH_MS = 5000;
const FOCUS_FLOOR_MS = 10000; // a focus flicker never starts a read more than once per 10 s

let statusItem = null;
let panel = null;
let panelTemplate = null;
let extensionUri = null;
let extensionPath = null;
let timer = null;
let disposed = true;
let lastFocusRun = 0;

const model = { state: { kind: 'on', enabled: true, updatedAt: null, updatedBy: null }, decisions: [], writeError: false };

function readAll() {
  model.state = stateLib.readState(stateLib.stateDir());
  const d = decisionsLib.readDecisions(stateLib.stateDir());
  if (d.status !== 'torn') model.decisions = d.decisions; // a torn read keeps the last good list, quietly
}

function postState() {
  if (!panel) return;
  const view = Object.assign(format.panelView(model.state, model.decisions), { writeError: model.writeError });
  Promise.resolve(panel.webview.postMessage({ type: 'state', state: view })).then(undefined, () => {});
}

function render() {
  if (disposed) return;
  try {
    if (statusItem) {
      const v = format.statusView(model.state);
      statusItem.text = v.text;
      statusItem.backgroundColor = v.background ? new vscode.ThemeColor(v.background) : undefined;
      const md = new vscode.MarkdownString(format.tooltipMarkdown(model.state, model.decisions));
      md.isTrusted = false;
      md.supportHtml = false;
      statusItem.tooltip = md;
    }
    postState();
  } catch (err) {
    console.error('[ama] render failed', err);
  }
}

function tick() {
  try { readAll(); } catch (err) { console.error('[ama] read failed', err); }
  render();
}

function focusedTick() {
  if (vscode.window.state.focused) tick();
}

function startTimer() {
  stopTimer();
  timer = setInterval(focusedTick, REFRESH_MS);
  if (timer.unref) timer.unref();
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------- panel

function panelHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const uri = (file) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)).toString();
  return panelTemplate
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{cssUri\}\}/g, uri('panel.css'))
    .replace(/\{\{jsUri\}\}/g, uri('panel.js'));
}

function onPanelMessage(raw) {
  const msg = validate.validateMessage(raw);
  if (!msg) return; // anything outside the allowlist is ignored
  switch (msg.type) {
    case 'ready':
    case 'refresh': tick(); break;
    case 'toggle': {
      const ok = stateLib.writeState(stateLib.stateDir(), msg.enabled);
      model.writeError = !ok;
      tick();
      break;
    }
    default: break;
  }
}

function openPanel() {
  if (panel) {
    panel.reveal(undefined, false);
  } else {
    panel = vscode.window.createWebviewPanel('ama.panel', 'AI Model Autoroute', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      retainContextWhenHidden: false,
    });
    panel.webview.html = panelHtml(panel.webview);
    panel.webview.onDidReceiveMessage(onPanelMessage);
    panel.onDidDispose(() => { panel = null; });
  }
  tick();
}

// ---------------------------------------------------------------- lifecycle

function activate(context) {
  disposed = false;
  model.state = { kind: 'on', enabled: true, updatedAt: null, updatedBy: null };
  model.decisions = [];
  model.writeError = false;
  extensionUri = context.extensionUri;
  extensionPath = context.extensionPath;
  lastFocusRun = 0;
  panelTemplate = fs.readFileSync(path.join(extensionPath, 'media', 'panel.html'), 'utf8');

  statusItem = vscode.window.createStatusBarItem('ama.status', vscode.StatusBarAlignment.Right, 98);
  statusItem.name = 'AMA';
  statusItem.command = 'ama.open';
  try { readAll(); } catch (err) { console.error('[ama] read failed', err); }
  render();
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('ama.open', openPanel),
    vscode.commands.registerCommand('ama.refresh', () => tick()),
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused && Date.now() - lastFocusRun >= FOCUS_FLOOR_MS) { lastFocusRun = Date.now(); tick(); }
    }),
    { dispose: () => { stopTimer(); } },
  );
  startTimer();
}

function deactivate() {
  disposed = true;
  stopTimer();
}

module.exports = { activate, deactivate, __tick: () => tick() };
