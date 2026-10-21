// Webview message allowlist. Returns a fresh, minimal message object or null; extra fields are dropped.
'use strict';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateMessage(msg) {
  if (!isObj(msg) || typeof msg.type !== 'string') return null;
  switch (msg.type) {
    case 'ready': return { type: 'ready' };
    case 'refresh': return { type: 'refresh' };
    case 'toggle': return typeof msg.enabled === 'boolean' ? { type: 'toggle', enabled: msg.enabled } : null;
    default: return null;
  }
}

module.exports = { validateMessage };
