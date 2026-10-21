// AMA state file: ~/.claude/ama/state.json (or $AMA_STATE_DIR). Shared contract with the ai-model-autoroute mod.
// Missing file = ON. Unreadable, oversized, bad JSON, wrong version or non-boolean enabled = INVALID (the mod treats it as OFF).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 64 * 1024;
const STATE_FILE = 'state.json';
const DECISIONS_FILE = 'decisions.json';

function stateDir() {
  const env = process.env.AMA_STATE_DIR;
  if (typeof env === 'string' && env.length > 0) return env;
  return path.join(os.homedir(), '.claude', 'ama');
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Returns { kind: 'on'|'off'|'invalid', enabled: boolean, updatedAt: string|null, updatedBy: string|null, reason?: string }. */
function readState(dir) {
  const file = path.join(dir, STATE_FILE);
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { kind: 'on', enabled: true, updatedAt: null, updatedBy: null, missing: true };
    return invalid('unreadable');
  }
  if (!st.isFile()) return invalid('not a regular file');
  if (st.size > MAX_BYTES) return invalid('file too large');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return invalid('not valid JSON');
  }
  if (!isObj(data) || data.version !== 1) return invalid('unsupported version');
  if (typeof data.enabled !== 'boolean') return invalid('enabled is not true or false');
  const updatedAt = typeof data.updatedAt === 'string' && data.updatedAt.length <= 40 && !Number.isNaN(Date.parse(data.updatedAt)) ? data.updatedAt : null;
  const updatedBy = data.updatedBy === 'panel' || data.updatedBy === 'command' ? data.updatedBy : null;
  return { kind: data.enabled ? 'on' : 'off', enabled: data.enabled, updatedAt, updatedBy };
}

function invalid(reason) {
  return { kind: 'invalid', enabled: false, updatedAt: null, updatedBy: null, reason };
}

/** Atomic write of state.json with updatedBy "panel". Returns true on success; no temp file is left on failure. */
function writeState(dir, enabled, now = new Date()) {
  const file = path.join(dir, STATE_FILE);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: 1, enabled: !!enabled, updatedAt: now.toISOString(), updatedBy: 'panel' }, null, 2) + '\n';
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* not created, or already gone */ }
    return false;
  }
}

module.exports = { stateDir, readState, writeState, MAX_BYTES, STATE_FILE, DECISIONS_FILE };
