// Status bar text, tooltip and the panel view model.
'use strict';

const MAX_SHOWN = 10;

/** "claude-opus-5-5" -> "Opus 5.5"; anything unrecognised is shown as-is (already pattern-validated). */
function shortModel(id) {
  if (typeof id !== 'string' || id === '') return '-';
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(id);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] !== undefined ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

function statusView(state) {
  if (state.kind === 'invalid') return { text: '$(error) AMA ?', background: 'statusBarItem.errorBackground' };
  if (state.kind === 'off') return { text: '$(circle-slash) AMA off', background: 'statusBarItem.warningBackground' };
  return { text: '$(git-compare) AMA on', background: null };
}

const stateLabel = (s) => (s.kind === 'invalid' ? 'Off (state file invalid)' : s.kind === 'off' ? 'Off' : 'On');
const KIND_LABEL = { first: 'First message', mid: 'Mid-conversation' };

function lastDecisionLine(d) {
  if (!d) return 'No decisions yet';
  const when = new Date(d.at);
  const t = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `${t}, ${KIND_LABEL[d.kind]}, ${d.label}, ${d.switched ? 'switched' : 'not switched'}`;
}

function tooltipMarkdown(state, decisions) {
  const last = decisions.length ? decisions[decisions.length - 1] : null;
  return [
    '| AI Model Autoroute | |',
    '|:--|:--|',
    `| State | ${stateLabel(state)} |`,
    `| Last decision | ${lastDecisionLine(last)} |`,
  ].join('\n');
}

/** What the webview receives: plain strings and numbers only, newest decision first, at most 10. */
function panelView(state, decisions) {
  const rows = decisions.slice(-MAX_SHOWN).reverse().map((d) => ({
    at: d.at, kind: d.kind, label: d.label, from: shortModel(d.from), to: shortModel(d.to), switched: d.switched, ms: d.ms,
  }));
  return {
    kind: state.kind,
    enabled: state.kind === 'on',
    stateLabel: stateLabel(state),
    reason: state.kind === 'invalid' ? state.reason || '' : '',
    updatedAt: state.updatedAt,
    decisions: rows,
  };
}

module.exports = { shortModel, statusView, tooltipMarkdown, panelView, stateLabel, MAX_SHOWN };
