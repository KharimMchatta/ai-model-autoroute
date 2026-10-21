// AMA panel script. Values arrive as plain strings and numbers from the extension host and are written
// with textContent only, no HTML parsing, no inline handlers. Messages posted back: ready, refresh, toggle.
'use strict';

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = {
    chip: $('chip'), chipText: $('chip-text'), toggle: $('toggle'), switchState: $('switch-state'), switchSub: $('switch-sub'),
    problem: $('problem'), problemTitle: $('problem-title'), problemText: $('problem-text'), problemHint: $('problem-hint'),
    empty: $('empty'), tableWrap: $('table-wrap'), rows: $('rows'), count: $('dec-count'),
  };
  let current = null;
  let rowsSig = '';
  let busy = false;

  function mk(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function localTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function renderRows(list) {
    const sig = JSON.stringify(list);
    if (sig === rowsSig) return;
    rowsSig = sig;
    el.rows.textContent = '';
    for (const d of list) {
      const tr = document.createElement('tr');
      const cell = (label, child, cls) => {
        const td = document.createElement('td');
        td.setAttribute('data-label', label);
        if (cls) td.className = cls;
        td.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        tr.appendChild(td);
      };
      cell('Time', localTime(d.at));
      cell('When', d.kind === 'first' ? 'First message' : 'Mid-conversation');
      const lab = mk('span', d.label, 'label');
      lab.setAttribute('data-label', d.label);
      cell('Label', lab);
      cell('Model', `${d.from} → ${d.to}`);
      cell('Switched', mk('span', d.switched ? 'Yes' : 'No', d.switched ? 'yes' : 'no'));
      cell('Time taken', `${d.ms} ms`, 'num');
      el.rows.appendChild(tr);
    }
  }

  function render(s) {
    current = s;
    busy = false;
    el.toggle.removeAttribute('aria-busy');
    el.chip.setAttribute('data-kind', s.kind);
    el.chipText.textContent = s.stateLabel;
    el.toggle.disabled = false;
    el.toggle.setAttribute('aria-checked', s.enabled ? 'true' : 'false');
    el.switchState.textContent = s.enabled ? 'On' : 'Off';
    if (s.kind === 'invalid') el.switchSub.textContent = 'Turn on to rewrite the state file.';
    else if (s.kind === 'off') el.switchSub.textContent = 'The mod leaves every window on its own model.';
    else el.switchSub.textContent = 'The mod routes each new window\'s first message.';

    const bad = s.kind === 'invalid' || s.writeError;
    el.problem.hidden = !bad;
    if (s.kind === 'invalid') {
      el.problemTitle.textContent = 'State file invalid';
      el.problemText.textContent = `The mod treats this as off (${s.reason || 'unreadable'}).`;
      el.problemHint.textContent = 'Use the switch to rewrite a valid state file.';
    } else if (s.writeError) {
      el.problemTitle.textContent = 'Could not save the change';
      el.problemText.textContent = 'The state file could not be written, so the setting is unchanged.';
      el.problemHint.textContent = 'Check that the AMA state folder is writable, then try again.';
    }

    const list = Array.isArray(s.decisions) ? s.decisions : [];
    el.empty.hidden = list.length > 0;
    el.tableWrap.hidden = list.length === 0;
    el.count.textContent = list.length ? `Last ${list.length}` : '';
    renderRows(list);
  }

  el.toggle.addEventListener('click', () => {
    if (!current) return;
    if (busy) return; // one change at a time; cleared by the next state message. Not disabled, so keyboard focus stays.
    busy = true;
    el.toggle.setAttribute('aria-busy', 'true');
    vscode.postMessage({ type: 'toggle', enabled: !current.enabled });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.type === 'state' && m.state && typeof m.state === 'object') render(m.state);
  });

  vscode.postMessage({ type: 'ready' });
})();
