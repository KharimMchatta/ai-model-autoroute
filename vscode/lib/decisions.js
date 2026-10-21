// decisions.json is written by the mod only. Read-only here; every field is validated and bad entries are dropped.
'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_BYTES, DECISIONS_FILE } = require('./state');

const MAX_ENTRIES = 50;
const LABELS = ['OPUS', 'SONNET', 'STAY', 'none'];
const KINDS = ['first', 'mid'];
const MODEL_RE = /^[A-Za-z0-9._:\[\]-]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const modelOk = (v) => v === '' || (typeof v === 'string' && MODEL_RE.test(v));
const countOk = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** Returns a clean entry or null. */
function cleanEntry(e) {
  if (!isObj(e)) return null;
  if (typeof e.at !== 'string' || !ISO_RE.test(e.at) || Number.isNaN(Date.parse(e.at))) return null;
  if (!KINDS.includes(e.kind) || !LABELS.includes(e.label)) return null;
  if (!modelOk(e.from) || !modelOk(e.to)) return null;
  if (typeof e.switched !== 'boolean') return null;
  if (typeof e.ms !== 'number' || !Number.isFinite(e.ms) || e.ms < 0 || e.ms > 3.6e6) return null;
  if (!countOk(e.inputTokens) || !countOk(e.outputTokens)) return null;
  if (typeof e.reason !== 'string') return null;
  const reason = e.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
  return { at: e.at, kind: e.kind, label: e.label, from: e.from, to: e.to, switched: e.switched, ms: Math.round(e.ms), inputTokens: e.inputTokens, outputTokens: e.outputTokens, reason };
}

/**
 * { status: 'ok', decisions } | { status: 'none', decisions: [] } (missing or invalid file) | { status: 'torn' } (unparseable: keep the last reading).
 */
function readDecisions(dir) {
  const file = path.join(dir, DECISIONS_FILE);
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES * 16) return { status: 'none', decisions: [] };
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'none', decisions: [] };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: 'torn' };
  }
  if (!isObj(data) || data.version !== 1 || !Array.isArray(data.decisions)) return { status: 'none', decisions: [] };
  const out = [];
  for (const e of data.decisions.slice(-MAX_ENTRIES)) {
    const c = cleanEntry(e);
    if (c) out.push(c);
  }
  return { status: 'ok', decisions: out };
}

module.exports = { readDecisions, cleanEntry, MAX_ENTRIES };
