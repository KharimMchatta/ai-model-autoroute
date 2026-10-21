// AMA extension tests: state file, atomic write, decisions validation, message allowlist, status bar,
// tooltip, panel view model and the mocked VS Code wiring. Run: node test/run-tests.js
'use strict';

process.env.TZ = 'Africa/Dar_es_Salaam';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stateLib = require('../lib/state');
const decisionsLib = require('../lib/decisions');
const validate = require('../lib/validate');
const format = require('../lib/format');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ama-test-'));
let n = 0;
const fresh = () => path.join(TMP, `d${++n}`);
const mkdir = () => { const d = fresh(); fs.mkdirSync(d, { recursive: true }); return d; };
const mode = (p) => fs.statSync(p).mode & 0o777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const entry = (over = {}) => ({
  at: '2026-10-21T08:15:30.000Z', kind: 'first', label: 'OPUS', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5',
  switched: true, ms: 842, inputTokens: 1200, outputTokens: 18, reason: 'Security review of the auth module', ...over,
});

// ------------------------------------------------------------- state read

test('state: missing file means ON', () => {
  const s = stateLib.readState(fresh());
  assert.equal(s.kind, 'on');
  assert.equal(s.enabled, true);
});

test('state: valid on and off', () => {
  const d = mkdir();
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ version: 1, enabled: false, updatedAt: '2026-10-21T08:00:00.000Z', updatedBy: 'command' }));
  let s = stateLib.readState(d);
  assert.equal(s.kind, 'off'); assert.equal(s.updatedBy, 'command');
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ version: 1, enabled: true, updatedAt: '2026-10-21T08:00:00.000Z', updatedBy: 'panel' }));
  s = stateLib.readState(d);
  assert.equal(s.kind, 'on'); assert.equal(s.enabled, true);
});

test('state: invalid shapes are INVALID', () => {
  const cases = {
    badJson: '{not json',
    empty: '',
    wrongVersion: JSON.stringify({ version: 2, enabled: true }),
    noVersion: JSON.stringify({ enabled: true }),
    stringEnabled: JSON.stringify({ version: 1, enabled: 'true' }),
    numberEnabled: JSON.stringify({ version: 1, enabled: 1 }),
    missingEnabled: JSON.stringify({ version: 1 }),
    array: '[]',
    nullDoc: 'null',
    oversized: JSON.stringify({ version: 1, enabled: true, pad: 'x'.repeat(stateLib.MAX_BYTES) }),
  };
  for (const [name, body] of Object.entries(cases)) {
    const d = mkdir();
    fs.writeFileSync(path.join(d, 'state.json'), body);
    const s = stateLib.readState(d);
    assert.equal(s.kind, 'invalid', name);
    assert.equal(s.enabled, false, name);
  }
});

test('state: a directory or other non-regular file is INVALID', () => {
  const d = mkdir();
  fs.mkdirSync(path.join(d, 'state.json'));
  assert.equal(stateLib.readState(d).kind, 'invalid');
  assert.equal(stateLib.readState(d).reason, 'not a regular file');
  const d2 = mkdir();
  fs.writeFileSync(path.join(d2, 'real.json'), '{}');
  fs.symlinkSync(path.join(d2, 'real.json'), path.join(d2, 'state.json'));
  // statSync follows the link to a regular file holding {} -> invalid contents, still INVALID
  assert.equal(stateLib.readState(d2).kind, 'invalid');
});

test('state: AMA_STATE_DIR honoured, default is ~/.claude/ama', () => {
  const saved = process.env.AMA_STATE_DIR;
  try {
    process.env.AMA_STATE_DIR = '/tmp/some-ama-dir';
    assert.equal(stateLib.stateDir(), '/tmp/some-ama-dir');
    delete process.env.AMA_STATE_DIR;
    assert.equal(stateLib.stateDir(), path.join(os.homedir(), '.claude', 'ama'));
    process.env.AMA_STATE_DIR = '';
    assert.equal(stateLib.stateDir(), path.join(os.homedir(), '.claude', 'ama'));
  } finally { if (saved === undefined) delete process.env.AMA_STATE_DIR; else process.env.AMA_STATE_DIR = saved; }
});

// ------------------------------------------------------------- state write

test('write: creates dir 0700, file 0600, panel marker, no temp left, round trip', () => {
  const d = fresh();
  assert.equal(stateLib.writeState(d, false, new Date('2026-10-21T10:00:00Z')), true);
  assert.equal(mode(d), 0o700);
  assert.equal(mode(path.join(d, 'state.json')), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8')), { version: 1, enabled: false, updatedAt: '2026-10-21T10:00:00.000Z', updatedBy: 'panel' });
  assert.deepEqual(fs.readdirSync(d), ['state.json']);
  assert.equal(stateLib.readState(d).kind, 'off');
  assert.equal(stateLib.writeState(d, true), true);
  assert.equal(stateLib.readState(d).kind, 'on');
  assert.deepEqual(fs.readdirSync(d), ['state.json']);
});

test('write: rewrites an invalid file with a valid one', () => {
  const d = mkdir();
  fs.writeFileSync(path.join(d, 'state.json'), 'garbage');
  assert.equal(stateLib.readState(d).kind, 'invalid');
  assert.equal(stateLib.writeState(d, true), true);
  assert.equal(stateLib.readState(d).kind, 'on');
});

test('write: failure leaves the old file and no temp file', () => {
  const d = mkdir();
  stateLib.writeState(d, true);
  // make the target a directory so rename fails
  fs.rmSync(path.join(d, 'state.json'));
  fs.mkdirSync(path.join(d, 'state.json'));
  assert.equal(stateLib.writeState(d, false), false);
  assert.deepEqual(fs.readdirSync(d), ['state.json']);
  assert.ok(fs.statSync(path.join(d, 'state.json')).isDirectory());
});

// ------------------------------------------------------------- decisions

function writeDecisions(d, decisions) {
  fs.writeFileSync(path.join(d, 'decisions.json'), JSON.stringify({ version: 1, decisions }));
}

test('decisions: missing or wrong-shape file means none', () => {
  assert.deepEqual(decisionsLib.readDecisions(fresh()), { status: 'none', decisions: [] });
  for (const body of [JSON.stringify({ version: 2, decisions: [] }), JSON.stringify({ version: 1, decisions: 'x' }), '[]', 'null']) {
    const d = mkdir();
    fs.writeFileSync(path.join(d, 'decisions.json'), body);
    assert.equal(decisionsLib.readDecisions(d).status, 'none', body);
  }
});

test('decisions: valid entries kept, invalid dropped', () => {
  const d = mkdir();
  writeDecisions(d, [
    entry(),
    entry({ kind: 'sideways' }), entry({ label: 'GPT' }), entry({ at: 'yesterday' }), entry({ switched: 'yes' }),
    entry({ ms: -1 }), entry({ ms: NaN }), entry({ inputTokens: '5' }), entry({ outputTokens: undefined }), entry({ reason: 7 }),
    entry({ from: 'bad id with spaces' }), entry({ to: 5 }), 'string', null, 7, [],
    entry({ label: 'none', from: '', to: '', switched: false, inputTokens: null, outputTokens: null }),
    entry({ kind: 'mid', label: 'STAY' }),
  ]);
  const r = decisionsLib.readDecisions(d);
  assert.equal(r.status, 'ok');
  assert.equal(r.decisions.length, 3);
  assert.deepEqual(r.decisions.map((x) => x.label), ['OPUS', 'none', 'STAY']);
});

test('decisions: cap at 50 newest, reason sanitised and bounded', () => {
  const d = mkdir();
  writeDecisions(d, Array.from({ length: 70 }, (_, i) => entry({ ms: i, reason: i === 69 ? 'a\u0007b\n' + 'x'.repeat(1000) : 'r' })));
  const r = decisionsLib.readDecisions(d);
  assert.equal(r.decisions.length, 50);
  assert.equal(r.decisions[0].ms, 20);
  assert.equal(r.decisions[49].ms, 69);
  assert.ok(r.decisions[49].reason.length <= 300);
  assert.ok(!/[\u0000-\u001f]/.test(r.decisions[49].reason));
});

test('decisions: torn (truncated) file reports torn, not an error', () => {
  const d = mkdir();
  const full = JSON.stringify({ version: 1, decisions: [entry(), entry()] });
  fs.writeFileSync(path.join(d, 'decisions.json'), full.slice(0, Math.floor(full.length / 2)));
  assert.deepEqual(decisionsLib.readDecisions(d), { status: 'torn' });
});

// ------------------------------------------------------------- allowlist

test('allowlist: ready, refresh, toggle pass; everything else is rejected', () => {
  assert.deepEqual(validate.validateMessage({ type: 'ready', extra: 1 }), { type: 'ready' });
  assert.deepEqual(validate.validateMessage({ type: 'refresh', x: {} }), { type: 'refresh' });
  assert.deepEqual(validate.validateMessage({ type: 'toggle', enabled: true, evil: 'x' }), { type: 'toggle', enabled: true });
  assert.deepEqual(validate.validateMessage({ type: 'toggle', enabled: false }), { type: 'toggle', enabled: false });
  for (const bad of [{ type: 'toggle' }, { type: 'toggle', enabled: 'true' }, { type: 'toggle', enabled: 1 }, { type: 'toggle', enabled: null },
    { type: 'range', days: 7 }, { type: 'copyPrompt' }, { type: 'TOGGLE', enabled: true }, { type: 5 }, {}, null, undefined, 'toggle', 5, [], [{ type: 'ready' }]]) {
    assert.equal(validate.validateMessage(bad), null, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------- format

test('format: short model names', () => {
  assert.equal(format.shortModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(format.shortModel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(format.shortModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(format.shortModel('claude-opus-5'), 'Opus 5');
  assert.equal(format.shortModel('something-else'), 'something-else');
  assert.equal(format.shortModel(''), '-');
});

test('format: status bar text and colour per state', () => {
  const on = format.statusView({ kind: 'on' });
  assert.match(on.text, /AMA on$/); assert.equal(on.background, null);
  const off = format.statusView({ kind: 'off' });
  assert.match(off.text, /AMA off$/); assert.equal(off.background, 'statusBarItem.warningBackground');
  const bad = format.statusView({ kind: 'invalid' });
  assert.match(bad.text, /AMA \?$/); assert.equal(bad.background, 'statusBarItem.errorBackground');
});

test('format: tooltip is a Markdown table with state and last decision', () => {
  const md = format.tooltipMarkdown({ kind: 'on' }, [entry({ at: '2026-10-21T08:15:30.000Z' })]);
  const lines = md.split('\n');
  assert.ok(lines.length >= 4 && lines.every((l) => l.startsWith('|')));
  assert.match(md, /\| State \| On \|/);
  assert.match(md, /2026-10-21 11:15, First message, OPUS, switched/); // 08:15Z is 11:15 EAT
  assert.match(format.tooltipMarkdown({ kind: 'invalid', reason: 'x' }, []), /Off \(state file invalid\)/);
  assert.match(format.tooltipMarkdown({ kind: 'on' }, []), /No decisions yet/);
  assert.match(format.tooltipMarkdown({ kind: 'off' }, [entry({ kind: 'mid', label: 'STAY', switched: false })]), /Mid-conversation, STAY, not switched/);
});

test('format: panel view is newest first, at most 10', () => {
  const list = Array.from({ length: 15 }, (_, i) => entry({ ms: i }));
  const v = format.panelView({ kind: 'on', updatedAt: null }, list);
  assert.equal(v.decisions.length, 10);
  assert.equal(v.decisions[0].ms, 14);
  assert.equal(v.decisions[9].ms, 5);
  assert.equal(v.decisions[0].from, 'Sonnet 5.5');
  assert.equal(v.decisions[0].to, 'Opus 5.5');
  assert.equal(v.stateLabel, 'On');
  const inv = format.panelView({ kind: 'invalid', reason: 'not valid JSON' }, []);
  assert.equal(inv.stateLabel, 'Off (state file invalid)');
  assert.equal(inv.enabled, false);
  assert.equal(inv.reason, 'not valid JSON');
});

// ------------------------------------------------------------- static panel checks

test('panel files: strict CSP, no inline script or style, no innerHTML', () => {
  const html = fs.readFileSync(path.join(ROOT, 'media', 'panel.html'), 'utf8');
  assert.match(html, /default-src 'none'; style-src \{\{cspSource\}\}; script-src 'nonce-\{\{nonce\}\}'; img-src \{\{cspSource\}\}; base-uri 'none'; form-action 'none';/);
  assert.ok(!/\sstyle=|\sonclick=|\son[a-z]+=/i.test(html));
  const js = fs.readFileSync(path.join(ROOT, 'media', 'panel.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|document\.write/.test(js));
  assert.match(html, /role="switch"/);
  const all = [html, js, fs.readFileSync(path.join(ROOT, 'media', 'panel.css'), 'utf8'), fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')].join('\n');
  assert.ok(!/—|–/.test(all), 'no em or en dashes');
});

test('package.json: contract fields', () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(p.name, 'ama'); assert.equal(p.publisher, 'kharimmchatta'); assert.equal(p.version, '0.2.0');
  assert.equal(p.private, true); assert.equal(p.license, 'MIT'); assert.equal(p.engines.vscode, '^1.94.0');
  assert.deepEqual(p.activationEvents, ['onStartupFinished']);
  assert.deepEqual(p.contributes.commands.map((c) => c.command), ['ama.open', 'ama.refresh']);
  assert.ok(Array.isArray(p.files) && p.repository && !p.dependencies);
  assert.ok(!fs.existsSync(path.join(ROOT, '.vscodeignore')));
});

// ------------------------------------------------------------- extension wiring (mocked VS Code API)

function vscodeMock() {
  const m = { focused: true, commands: {}, listeners: {}, panels: [], status: null, statusArgs: null };
  const disposable = { dispose() {} };
  m.api = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    Uri: { joinPath: (base, ...parts) => ({ toString: () => ['mock:', ...parts].join('/') }) },
    window: {
      get state() { return { focused: m.focused }; },
      createStatusBarItem: (...a) => { m.statusArgs = a; m.status = { show() { m.shown = (m.shown || 0) + 1; }, dispose() {} }; return m.status; },
      onDidChangeWindowState: (fn) => { m.listeners.windowState = fn; return disposable; },
      createWebviewPanel: (...a) => {
        const p = {
          args: a, posted: [], handlers: {}, revealed: 0, reveal() { p.revealed++; }, dispose() { if (p.handlers.dispose) p.handlers.dispose(); },
          onDidDispose(fn) { p.handlers.dispose = fn; return disposable; },
          webview: {
            cspSource: 'mock-csp-source', html: '', asWebviewUri: (u) => u,
            postMessage(msg) { p.posted.push(msg); return Promise.resolve(true); },
            onDidReceiveMessage(fn) { p.handlers.message = fn; return disposable; },
          },
        };
        m.panels.push(p);
        return p;
      },
    },
    commands: { registerCommand: (id, fn) => { m.commands[id] = fn; return disposable; } },
  };
  return m;
}

function loadExtension(api) {
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? api : realLoad.call(this, request, ...rest); };
  try {
    delete require.cache[require.resolve('../extension')];
    return require('../extension');
  } finally { Module._load = realLoad; }
}

function makeContext() {
  const extPath = path.join(mkdir(), 'ext');
  fs.mkdirSync(path.join(extPath, 'media'), { recursive: true });
  fs.writeFileSync(path.join(extPath, 'media', 'panel.html'),
    '<html><head><meta http-equiv="Content-Security-Policy" content="style-src {{cspSource}}; script-src \'nonce-{{nonce}}\';"><link href="{{cssUri}}"></head><body><script nonce="{{nonce}}" src="{{jsUri}}"></script></body></html>');
  return { extensionUri: {}, extensionPath: extPath, subscriptions: [] };
}

test('extension wiring: status item, panel, toggle round trip, external change, torn decisions, allowlist', async (t) => {
  const dir = fresh();
  const saved = process.env.AMA_STATE_DIR;
  process.env.AMA_STATE_DIR = dir; // proves AMA_STATE_DIR is honoured by the extension
  const m = vscodeMock();
  const ext = loadExtension(m.api);
  const ctx = makeContext();
  try {
    await t.test('activate: status item per contract, missing state shows on', () => {
      ext.activate(ctx);
      assert.deepEqual([m.statusArgs[0], m.statusArgs[1], m.statusArgs[2]], ['ama.status', 2, 98]);
      assert.equal(m.status.name, 'AMA');
      assert.equal(m.status.command, 'ama.open');
      assert.match(m.status.text, /AMA on$/);
      assert.equal(m.status.backgroundColor, undefined);
      assert.equal(m.status.tooltip.isTrusted, false);
      assert.equal(m.status.tooltip.supportHtml, false);
      assert.ok(m.commands['ama.open'] && m.commands['ama.refresh']);
      assert.equal(m.shown, 1, 'status item is shown');
      assert.ok(!fs.existsSync(dir), 'reading never creates the state dir');
    });

    await t.test('open: panel options, placeholders filled, one panel, reveal on second open', () => {
      m.commands['ama.open']();
      const p = m.panels[0];
      assert.equal(p.args[0], 'ama.panel');
      assert.equal(p.args[1], 'AI Model Autoroute');
      assert.equal(p.args[3].enableScripts, true);
      assert.equal(p.args[3].retainContextWhenHidden, false);
      assert.equal(p.args[3].localResourceRoots.length, 1, 'webview limited to media/');
      assert.ok(p.posted.length >= 1 && p.posted[0].type === 'state', 'opening posts the current state at once');
      assert.ok(!/\{\{/.test(p.webview.html));
      assert.match(p.webview.html, /nonce-[0-9a-f]{32}/);
      m.commands['ama.open']();
      assert.equal(m.panels.length, 1);
      assert.equal(p.revealed, 1);
    });

    await t.test('ready posts state once per message', () => {
      const p = m.panels[0];
      p.posted.length = 0;
      p.handlers.message({ type: 'ready' });
      assert.equal(p.posted.length, 1);
      assert.equal(p.posted[0].type, 'state');
      assert.equal(p.posted[0].state.kind, 'on');
    });

    await t.test('toggle off writes state.json and updates status bar and panel at once', () => {
      const p = m.panels[0];
      p.posted.length = 0;
      p.handlers.message({ type: 'toggle', enabled: false });
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).enabled, false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).updatedBy, 'panel');
      assert.match(m.status.text, /AMA off$/);
      assert.equal(m.status.backgroundColor.id, 'statusBarItem.warningBackground');
      assert.equal(p.posted.length, 1);
      assert.equal(p.posted[0].state.kind, 'off');
      assert.equal(mode(path.join(dir, 'state.json')), 0o600);
    });

    await t.test('external write (the mod) is picked up by refresh', () => {
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, enabled: true, updatedAt: new Date().toISOString(), updatedBy: 'command' }));
      m.commands['ama.refresh']();
      assert.match(m.status.text, /AMA on$/);
    });

    await t.test('refresh message from the panel re-reads the state file', () => {
      const p = m.panels[0];
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, enabled: false, updatedAt: new Date().toISOString(), updatedBy: 'command' }));
      p.handlers.message({ type: 'refresh' });
      assert.match(m.status.text, /AMA off$/);
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, enabled: true, updatedAt: new Date().toISOString(), updatedBy: 'command' }));
      p.handlers.message({ type: 'refresh' });
      assert.match(m.status.text, /AMA on$/);
    });

    await t.test('invalid state shows AMA ? with error background; toggle rewrites a valid file', () => {
      const p = m.panels[0];
      fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
      m.commands['ama.refresh']();
      assert.match(m.status.text, /AMA \?$/);
      assert.equal(m.status.backgroundColor.id, 'statusBarItem.errorBackground');
      assert.equal(p.posted[p.posted.length - 1].state.kind, 'invalid');
      p.handlers.message({ type: 'toggle', enabled: true });
      assert.match(m.status.text, /AMA on$/);
      assert.equal(stateLib.readState(dir).kind, 'on');
    });

    await t.test('decisions show in the panel; a torn write keeps the last list quietly', () => {
      const p = m.panels[0];
      writeDecisions(dir, [entry({ ms: 1 }), entry({ ms: 2, kind: 'mid', label: 'SONNET' })]);
      m.commands['ama.refresh']();
      assert.equal(p.posted[p.posted.length - 1].state.decisions.length, 2);
      assert.equal(p.posted[p.posted.length - 1].state.decisions[0].ms, 2);
      assert.match(m.status.tooltip.value, /Mid-conversation, SONNET/);
      const full = fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8');
      fs.writeFileSync(path.join(dir, 'decisions.json'), full.slice(0, 40));
      m.commands['ama.refresh']();
      assert.equal(p.posted[p.posted.length - 1].state.decisions.length, 2, 'kept');
      assert.equal(p.posted[p.posted.length - 1].state.writeError, false);
      fs.rmSync(path.join(dir, 'decisions.json'));
      m.commands['ama.refresh']();
      assert.equal(p.posted[p.posted.length - 1].state.decisions.length, 0, 'removed file clears the list');
    });

    await t.test('allowlist: unknown or malformed messages cause no write and no post', () => {
      const p = m.panels[0];
      const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
      const count = p.posted.length;
      for (const bad of [{ type: 'toggle', enabled: 'false' }, { type: 'toggle' }, { type: 'rm', path: '/' }, 'toggle', null, 42]) p.handlers.message(bad);
      assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
      assert.equal(p.posted.length, count);
    });

    await t.test('write failure reports writeError and leaves state unchanged', () => {
      const p = m.panels[0];
      fs.rmSync(path.join(dir, 'state.json'));
      fs.mkdirSync(path.join(dir, 'state.json'));
      p.handlers.message({ type: 'toggle', enabled: false });
      assert.equal(p.posted[p.posted.length - 1].state.writeError, true);
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
      fs.rmSync(path.join(dir, 'state.json'), { recursive: true });
      p.handlers.message({ type: 'toggle', enabled: true });
      assert.equal(p.posted[p.posted.length - 1].state.writeError, false);
    });

    await t.test('dispose clears the panel so a new open creates another', () => {
      m.panels[0].dispose();
      m.commands['ama.open']();
      assert.equal(m.panels.length, 2);
      const nonce = (h) => /nonce-([0-9a-f]{32})/.exec(h)[1];
      assert.notEqual(nonce(m.panels[0].webview.html), nonce(m.panels[1].webview.html), 'fresh nonce per panel');
    });
  } finally {
    ext.deactivate();
    if (saved === undefined) delete process.env.AMA_STATE_DIR; else process.env.AMA_STATE_DIR = saved;
  }
});

test('focus gating: the refresh timer reads only while the window is focused', async () => {
  const dir = fresh();
  fs.mkdirSync(dir, { recursive: true });
  const saved = process.env.AMA_STATE_DIR;
  process.env.AMA_STATE_DIR = dir;
  const m = vscodeMock();
  const ext = loadExtension(m.api);
  const realSetInterval = global.setInterval;
  let fn = null;
  global.setInterval = (f, ms) => { fn = f; assert.equal(ms, 5000); return { unref() {} }; };
  try {
    ext.activate(makeContext());
  } finally { global.setInterval = realSetInterval; }
  try {
    assert.match(m.status.text, /AMA on$/);
    stateLib.writeState(dir, false);
    m.focused = false; fn();
    assert.match(m.status.text, /AMA on$/, 'unfocused tick does nothing');
    m.focused = true; fn();
    assert.match(m.status.text, /AMA off$/, 'focused tick reads');
  } finally {
    ext.deactivate();
    if (saved === undefined) delete process.env.AMA_STATE_DIR; else process.env.AMA_STATE_DIR = saved;
  }
});

// ------------------------------------------------------------- negative-control additions (2026-10-21)

test('state: size cap boundary, unreadable path, updatedAt and updatedBy validation', () => {
  const pad = (bytes) => { const base = JSON.stringify({ version: 1, enabled: true, pad: '' }); return JSON.stringify({ version: 1, enabled: true, pad: 'x'.repeat(bytes - base.length) }); };
  const d = mkdir();
  fs.writeFileSync(path.join(d, 'state.json'), pad(stateLib.MAX_BYTES));
  assert.equal(fs.statSync(path.join(d, 'state.json')).size, stateLib.MAX_BYTES);
  assert.equal(stateLib.readState(d).kind, 'on', 'exactly the cap is accepted');
  fs.writeFileSync(path.join(d, 'state.json'), pad(stateLib.MAX_BYTES + 1));
  const big = stateLib.readState(d);
  assert.equal(big.kind, 'invalid'); assert.equal(big.reason, 'file too large');
  // a state "dir" that is really a file: stat fails with ENOTDIR, which is not "missing"
  const f = path.join(mkdir(), 'plain');
  fs.writeFileSync(f, 'x');
  const un = stateLib.readState(f);
  assert.equal(un.kind, 'invalid'); assert.equal(un.reason, 'unreadable');
  const w = (over) => { const dd = mkdir(); fs.writeFileSync(path.join(dd, 'state.json'), JSON.stringify({ version: 1, enabled: true, ...over })); return stateLib.readState(dd); };
  assert.equal(w({ updatedAt: '2026-10-21T08:00:00.000Z', updatedBy: 'panel' }).updatedAt, '2026-10-21T08:00:00.000Z');
  assert.equal(w({ updatedAt: 'not a date' }).updatedAt, null);
  assert.equal(w({ updatedAt: 12345 }).updatedAt, null);
  assert.equal(w({ updatedAt: 'Wed Oct 21 2026 08:00:00 GMT+0300 (East Africa Time)' }).updatedAt, null, 'parseable but over 40 chars is dropped');
  assert.equal(w({ updatedBy: 'panel' }).updatedBy, 'panel');
  assert.equal(w({ updatedBy: 'command' }).updatedBy, 'command');
  assert.equal(w({ updatedBy: 'evil' }).updatedBy, null);
  assert.equal(w({ updatedBy: { x: 1 } }).updatedBy, null);
});

test('write: atomic (new inode, hard link keeps old content), enabled coerced to a boolean', () => {
  const d = mkdir();
  stateLib.writeState(d, true);
  const file = path.join(d, 'state.json');
  const ino = fs.statSync(file).ino;
  fs.linkSync(file, path.join(d, 'keep.json'));
  const before = fs.readFileSync(file, 'utf8');
  stateLib.writeState(d, false);
  assert.notEqual(fs.statSync(file).ino, ino, 'temp file renamed over the target, not written in place');
  assert.equal(fs.readFileSync(path.join(d, 'keep.json'), 'utf8'), before, 'old content untouched until the rename');
  stateLib.writeState(d, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, true);
  stateLib.writeState(d, '');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, false);
});

test('decisions: strict field checks and exact output shape', () => {
  const d = mkdir();
  writeDecisions(d, [
    entry({ at: 'Oct 21 2026 08:15' }), entry({ at: '2026-13-45T99:99:99Z' }), entry({ at: ['2026-10-21T08:15:30.000Z'] }), entry({ at: 5 }),
    entry({ from: 'a'.repeat(81) }), entry({ ms: 3.6e6 + 1 }), entry({ inputTokens: -5 }), entry({ outputTokens: -1 }),
    entry({ reason: 'a\u007fb' }),
  ]);
  const r = decisionsLib.readDecisions(d);
  assert.equal(r.status, 'ok');
  assert.equal(r.decisions.length, 1, 'only the DEL-containing reason survives, sanitised');
  assert.equal(r.decisions[0].reason, 'a b');
  const ok = decisionsLib.cleanEntry({ ...entry({ ms: 12.6 }), extra: 'x', secret: { a: 1 } });
  assert.deepEqual(Object.keys(ok).sort(), ['at', 'from', 'inputTokens', 'kind', 'label', 'ms', 'outputTokens', 'reason', 'switched', 'to']);
  assert.equal(ok.ms, 13, 'rounded');
  assert.equal(decisionsLib.cleanEntry(entry({ ms: 3.6e6 })).ms, 3.6e6, 'upper bound inclusive');
  assert.equal(decisionsLib.cleanEntry(entry({ from: 'a'.repeat(80) })).from, 'a'.repeat(80));
  for (const bad of [{ ms: NaN }, { ms: Infinity }, { ms: -Infinity }, { inputTokens: Infinity }, { outputTokens: NaN }, { inputTokens: -0.5 }]) {
    assert.equal(decisionsLib.cleanEntry(entry(bad)), null, JSON.stringify(bad));
  }
});

test('decisions: an oversized file means none', () => {
  const d = mkdir();
  const pad = 'x'.repeat(stateLib.MAX_BYTES * 16);
  fs.writeFileSync(path.join(d, 'decisions.json'), JSON.stringify({ version: 1, decisions: [entry()], pad }));
  assert.deepEqual(decisionsLib.readDecisions(d), { status: 'none', decisions: [] });
});

test('allowlist: an array carrying a type property is rejected', () => {
  assert.equal(validate.validateMessage(Object.assign([], { type: 'ready' })), null);
  assert.equal(validate.validateMessage(Object.assign([], { type: 'toggle', enabled: true })), null);
});

test('format: panel view for off and invalid, no free-text leaks, fable names', () => {
  const off = format.panelView({ kind: 'off', updatedAt: null, reason: 'stray' }, []);
  assert.equal(off.kind, 'off'); assert.equal(off.enabled, false); assert.equal(off.reason, '');
  const on = format.panelView({ kind: 'on', updatedAt: null }, [entry()]);
  assert.deepEqual(Object.keys(on.decisions[0]).sort(), ['at', 'from', 'kind', 'label', 'ms', 'switched', 'to']);
  assert.equal(format.shortModel('claude-fable-5-5'), 'Fable 5.5');
  assert.equal(format.stateLabel({ kind: 'off' }), 'Off');
});

// ------------------------------------------------------------- extension lifecycle (mocked VS Code API)

test('lifecycle: focus listener floor, deactivate and re-activate, disposed ticks, quiet failures', async () => {
  const dir = fresh();
  fs.mkdirSync(dir, { recursive: true });
  const saved = process.env.AMA_STATE_DIR;
  process.env.AMA_STATE_DIR = dir;
  const m = vscodeMock();
  const ext = loadExtension(m.api);
  const realSetInterval = global.setInterval, realClearInterval = global.clearInterval, realNow = Date.now, realErr = console.error;
  const timers = [], cleared = [], errors = [];
  global.setInterval = (f, ms) => { const t = { f, ms, unref() {} }; timers.push(t); return t; };
  global.clearInterval = (t) => { cleared.push(t); };
  console.error = (...a) => { errors.push(a); };
  const on = JSON.stringify({ version: 1, enabled: true, updatedAt: '2026-10-21T08:00:00.000Z', updatedBy: 'command' });
  const off = JSON.stringify({ version: 1, enabled: false, updatedAt: '2026-10-21T08:00:00.000Z', updatedBy: 'command' });
  const put = (body) => fs.writeFileSync(path.join(dir, 'state.json'), body);
  let ctx;
  try {
    ctx = makeContext();
    Date.now = () => 100000;
    put(on);
    ext.activate(ctx);
    assert.equal(timers.length, 1);
    assert.deepEqual(errors, [], 'no panel open: rendering is quiet');
    // window-state listener: unfocused never reads
    put(off);
    m.listeners.windowState({ focused: false });
    assert.match(m.status.text, /AMA on$/, 'losing focus does not read');
    m.listeners.windowState({ focused: true });
    assert.match(m.status.text, /AMA off$/, 'gaining focus reads');
    // inside the 10 s floor: no read
    put(on);
    Date.now = () => 105000;
    m.listeners.windowState({ focused: true });
    assert.match(m.status.text, /AMA off$/, 'a focus flicker inside 10 s does not read');
    Date.now = () => 110000;
    m.listeners.windowState({ focused: true });
    assert.match(m.status.text, /AMA on$/, 'after the floor it reads again');
    // second activate without deactivate clears the first timer
    ext.activate(makeContext());
    assert.ok(cleared.includes(timers[0]), 'start clears any previous timer');
    // deactivate stops the timer and re-activation starts a fresh floor
    ext.deactivate();
    assert.ok(cleared.includes(timers[1]), 'deactivate clears the timer');
    put(off);
    m.commands['ama.refresh']();
    assert.match(m.status.text, /AMA on$/, 'a tick after deactivate renders nothing');
    // disposing the subscription also stops the timer
    const ctx2 = makeContext();
    ext.activate(ctx2);
    const t2 = timers[timers.length - 1];
    ctx2.subscriptions.forEach((s) => s.dispose && s.dispose());
    assert.ok(cleared.includes(t2), 'subscription dispose clears the timer');
    ext.deactivate();
    // re-activation: focus floor starts fresh (last focus run was at 110000), stale model is not kept
    writeDecisions(dir, [entry({ ms: 1 }), entry({ ms: 2 })]);
    put(on);
    Date.now = () => 111000;
    ext.activate(makeContext());
    assert.match(m.status.tooltip.value, /First message, OPUS/);
    ext.deactivate();
    fs.writeFileSync(path.join(dir, 'decisions.json'), '{"version":1,"decis');
    Date.now = () => 112000;
    ext.activate(makeContext());
    assert.match(m.status.tooltip.value, /No decisions yet/, 'a fresh activation does not carry the old list into a torn file');
    m.commands['ama.open']();
    const p = m.panels[m.panels.length - 1];
    assert.equal(p.posted[p.posted.length - 1].state.writeError, false);
    put(off);
    m.listeners.windowState({ focused: true });
    assert.match(m.status.text, /AMA off$/, 'floor was reset by activate, so a focus 1 s after the last run reads');
    // a failed webview post never becomes an unhandled rejection
    p.webview.postMessage = () => Promise.reject(new Error('webview gone'));
    m.commands['ama.refresh']();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // a read that throws is logged, not thrown
    const realStat = fs.statSync;
    fs.statSync = () => ({ isFile() { throw new Error('boom'); }, size: 1 });
    try {
      assert.doesNotThrow(() => ext.activate(makeContext()));
      assert.doesNotThrow(() => m.commands['ama.refresh']());
    } finally { fs.statSync = realStat; }
    assert.ok(errors.some((a) => String(a[0]).includes('read failed')), 'read failure is logged');
  } finally {
    ext.deactivate();
    global.setInterval = realSetInterval; global.clearInterval = realClearInterval; Date.now = realNow; console.error = realErr;
    if (saved === undefined) delete process.env.AMA_STATE_DIR; else process.env.AMA_STATE_DIR = saved;
  }
});

// ------------------------------------------------------------- panel script (tiny fake DOM)

function loadPanel() {
  const vm = require('vm');
  class El {
    constructor() { this.attrs = {}; this.children = []; this.listeners = {}; this._t = ''; this.hidden = false; this.disabled = true; this.className = ''; }
    get textContent() { return this._t; }
    set textContent(v) { this._t = String(v); this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(t, f) { this.listeners[t] = f; }
  }
  const ids = ['chip', 'chip-text', 'toggle', 'switch-state', 'switch-sub', 'problem', 'problem-title', 'problem-text', 'problem-hint', 'empty', 'table-wrap', 'rows', 'dec-count'];
  const els = Object.fromEntries(ids.map((i) => [i, new El()]));
  const posted = [];
  let onMessage = null;
  const document = { getElementById: (i) => els[i], createElement: () => new El(), createTextNode: (t) => { const e = new El(); e.textContent = t; return e; } };
  const window = { addEventListener: (t, f) => { if (t === 'message') onMessage = f; } };
  const src = fs.readFileSync(path.join(ROOT, 'media', 'panel.js'), 'utf8');
  vm.runInNewContext(src, { document, window, acquireVsCodeApi: () => ({ postMessage: (x) => posted.push(x) }) });
  return { els, posted, send: (state) => onMessage({ data: { type: 'state', state } }), sendRaw: (data) => onMessage({ data }), click: () => els.toggle.listeners.click() };
}

const viewState = (over = {}) => ({ kind: 'on', enabled: true, stateLabel: 'On', reason: '', updatedAt: null, decisions: [], writeError: false, ...over });
const row = (over = {}) => ({ at: '2026-10-21T08:15:30.000Z', kind: 'first', label: 'OPUS', from: 'Sonnet 5.5', to: 'Opus 5.5', switched: true, ms: 842, ...over });

test('panel script: ready, toggle direction, one change at a time, state rendering', () => {
  const ui = loadPanel();
  assert.equal(JSON.stringify(ui.posted), '[{"type":"ready"}]');
  ui.click();
  assert.equal(ui.posted.length, 1, 'click before any state does nothing');
  ui.send(viewState());
  assert.equal(ui.els.toggle.attrs['aria-checked'], 'true');
  assert.equal(ui.els['switch-state'].textContent, 'On');
  assert.equal(ui.els.problem.hidden, true);
  assert.equal(ui.els.toggle.disabled, false);
  ui.click();
  assert.equal(JSON.stringify(ui.posted[1]), '{"type":"toggle","enabled":false}');
  assert.equal(ui.els.toggle.attrs['aria-busy'], 'true');
  ui.click();
  assert.equal(ui.posted.length, 2, 'second click while a change is pending is ignored');
  ui.send(viewState({ kind: 'off', enabled: false, stateLabel: 'Off' }));
  assert.equal(ui.els.toggle.attrs['aria-checked'], 'false');
  assert.equal(ui.els['switch-state'].textContent, 'Off');
  assert.equal(ui.els.toggle.attrs['aria-busy'], undefined);
  ui.click();
  assert.equal(JSON.stringify(ui.posted[2]), '{"type":"toggle","enabled":true}', 'next state message re-arms the switch');
});

test('panel script: invalid and write-error banners, foreign messages ignored', () => {
  const ui = loadPanel();
  ui.send(viewState({ kind: 'invalid', enabled: false, stateLabel: 'Off (state file invalid)', reason: 'not valid JSON' }));
  assert.equal(ui.els.problem.hidden, false);
  assert.equal(ui.els['problem-title'].textContent, 'State file invalid');
  assert.match(ui.els['problem-text'].textContent, /not valid JSON/);
  assert.equal(ui.els['chip'].attrs['data-kind'], 'invalid');
  assert.match(ui.els['switch-sub'].textContent, /rewrite/);
  ui.send(viewState({ kind: 'on', writeError: true }));
  assert.equal(ui.els.problem.hidden, false);
  assert.equal(ui.els['problem-title'].textContent, 'Could not save the change');
  ui.send(viewState());
  assert.equal(ui.els.problem.hidden, true);
  const chip = ui.els['chip-text'].textContent;
  ui.sendRaw({ type: 'other', state: viewState({ stateLabel: 'HIJACK' }) });
  ui.sendRaw({ type: 'state' });
  ui.sendRaw({ type: 'state', state: 'text' });
  ui.sendRaw(null);
  assert.equal(ui.els['chip-text'].textContent, chip, 'only well-formed state messages render');
});

test('panel script: decision rows, empty state, no redraw when unchanged', () => {
  const ui = loadPanel();
  ui.send(viewState());
  assert.equal(ui.els.empty.hidden, false);
  assert.equal(ui.els['table-wrap'].hidden, true);
  ui.send(viewState({ decisions: undefined }));
  assert.equal(ui.els.empty.hidden, false, 'a missing list is treated as empty');
  ui.send(viewState({ decisions: [row({ ms: 1 }), row({ ms: 2, switched: false })] }));
  assert.equal(ui.els.empty.hidden, true);
  assert.equal(ui.els['table-wrap'].hidden, false);
  assert.equal(ui.els['dec-count'].textContent, 'Last 2');
  const rows = ui.els.rows.children;
  assert.equal(rows.length, 2);
  const cellText = (tr, label) => { const td = tr.children.find((c) => c.attrs['data-label'] === label); const c = td.children[0]; return c.textContent; };
  assert.equal(cellText(rows[0], 'Switched'), 'Yes');
  assert.equal(cellText(rows[1], 'Switched'), 'No');
  assert.equal(cellText(rows[0], 'Model'), 'Sonnet 5.5 \u2192 Opus 5.5');
  assert.equal(cellText(rows[0], 'Time taken'), '1 ms');
  assert.equal(cellText(rows[0], 'When'), 'First message');
  const first = rows[0];
  ui.send(viewState({ decisions: [row({ ms: 1 }), row({ ms: 2, switched: false })] }));
  assert.strictEqual(ui.els.rows.children[0], first, 'identical list keeps the same DOM rows');
  ui.send(viewState({ decisions: [row({ ms: 9, kind: 'mid' })] }));
  assert.equal(ui.els.rows.children.length, 1, 'old rows are cleared');
  assert.equal(cellText(ui.els.rows.children[0], 'When'), 'Mid-conversation');
});
