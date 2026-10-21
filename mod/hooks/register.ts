import type { EngineInterface, ModelUsage, PromptSubmitInput, Register } from 'claude-code'

import {
  CLASSIFIER_EFFORT,
  CLASSIFIER_MODEL,
  DISPLAY,
  type Kind,
  type Label,
  MID_SYSTEM,
  SYSTEM,
  family,
  parseLabel,
  routeMessage,
  targetAlias,
} from './classifier'

// AMA, AI Model Autoroute. On a fresh window's first prompt, asks Sonnet which
// model the task routes to (Opus or Sonnet). Mid-window routing (the lift from
// Sonnet to Opus) is off: such prompts pass through. When the answer differs
// from the current model, holds the prompt, runs /model, and resends it. Every
// doubt (an error, a timeout, an unclear label) lets the prompt through
// unchanged. State and decisions live in files shared with the VS Code panel:
// state.json and decisions.json in the AMA state folder.

const TIMEOUT_MS = 15000
const KEEP = 50

type Decision = {
  label?: Label
  reason: string
  ms: number
  usage?: ModelUsage
  raw?: string
}

type StateRead = { kind: 'on' | 'off' | 'invalid' | 'nodir' }

async function classify($: EngineInterface, text: string, kind: Kind): Promise<Decision> {
  const startedAt = await $.clock.now()
  const elapsed = async () => (await $.clock.now()) - startedAt
  try {
    const r = await $.model.complete({
      model: CLASSIFIER_MODEL,
      effort: CLASSIFIER_EFFORT,
      system: kind === 'mid' ? MID_SYSTEM : SYSTEM,
      prompt: routeMessage(text),
      maxTokens: 4096,
      timeoutMs: TIMEOUT_MS,
    })
    if (!r.isAnswered) {
      const reason = r.reason === 'api-error' ? `api-error ${r.status ?? 'none'} ${r.error}` : r.reason
      return { reason, ms: await elapsed(), usage: r.usage }
    }
    const parsed = parseLabel(r.text)
    // Mid-window the only labels are OPUS and STAY: SONNET counts as unclear.
    const label = kind === 'mid' && parsed === 'SONNET' ? undefined : parsed
    return label
      ? { label, reason: 'answered', ms: await elapsed(), usage: r.usage, raw: r.text }
      : { reason: 'unclear label', ms: await elapsed(), usage: r.usage, raw: r.text }
  } catch (err) {
    return { reason: `refused: ${String(err)}`, ms: await elapsed() }
  }
}

function tokens(usage?: ModelUsage): string {
  if (!usage) return 'no usage'
  return `in ${usage.input_tokens}, cache write ${usage.cache_creation_input_tokens}, cache read ${usage.cache_read_input_tokens}, out ${usage.output_tokens}`
}

function isPersonTyped(e: PromptSubmitInput): boolean {
  return e.origin.kind === 'composer' || e.origin.kind === 'sdk'
}

// The state folder: AMA_STATE_DIR when set, else $HOME/.claude/ama, else none.
async function stateDir($: EngineInterface): Promise<string | undefined> {
  try {
    const dir = await $.env.get('AMA_STATE_DIR')
    if (dir) return dir
    const home = await $.env.get('HOME')
    return home ? `${home}/.claude/ama` : undefined
  } catch {
    return undefined
  }
}

// state.json missing means on; unreadable, invalid, wrong version or a
// non-boolean `enabled` means off; no state folder at all means off.
async function readState($: EngineInterface): Promise<StateRead> {
  const dir = await stateDir($)
  if (!dir) return { kind: 'nodir' }
  try {
    const file = `${dir}/state.json`
    if (!(await $.fs.exists(file))) return { kind: 'on' }
    const data = JSON.parse(await $.fs.read(file)) as { version?: unknown; enabled?: unknown }
    if (data === null || typeof data !== 'object' || data.version !== 1 || typeof data.enabled !== 'boolean') {
      return { kind: 'invalid' }
    }
    return { kind: data.enabled ? 'on' : 'off' }
  } catch {
    return { kind: 'invalid' }
  }
}

async function writeState($: EngineInterface, enabled: boolean): Promise<boolean> {
  const dir = await stateDir($)
  if (!dir) return false
  try {
    const at = new Date(await $.clock.now()).toISOString()
    const body = { version: 1, enabled, updatedAt: at, updatedBy: 'command' }
    await $.fs.write(`${dir}/state.json`, JSON.stringify(body, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

type Entry = {
  at: string
  kind: Kind
  label: 'OPUS' | 'SONNET' | 'STAY' | 'none'
  from: string
  to: string
  switched: boolean
  ms: number
  inputTokens: number | null
  outputTokens: number | null
  reason: string
}

async function readEntries($: EngineInterface): Promise<Entry[]> {
  const dir = await stateDir($)
  if (!dir) return []
  try {
    const file = `${dir}/decisions.json`
    if (!(await $.fs.exists(file))) return []
    const data = JSON.parse(await $.fs.read(file)) as { version?: unknown; decisions?: unknown }
    if (data === null || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.decisions)) return []
    return data.decisions as Entry[]
  } catch {
    return []
  }
}

// Never holds prompt text; any failure is ignored (fail open).
async function logDecision($: EngineInterface, kind: Kind, d: Decision, from: string, to: string, switched: boolean) {
  try {
    const dir = await stateDir($)
    if (!dir) return
    const entry: Entry = {
      at: new Date(await $.clock.now()).toISOString(),
      kind,
      label: d.label ?? 'none',
      from,
      to,
      switched,
      ms: d.ms,
      inputTokens: d.usage ? d.usage.input_tokens : null,
      outputTokens: d.usage ? d.usage.output_tokens : null,
      reason: d.reason,
    }
    const decisions = [...(await readEntries($)), entry].slice(-KEEP)
    await $.fs.write(`${dir}/decisions.json`, JSON.stringify({ version: 1, decisions }, null, 2) + '\n')
  } catch {
    // fail open
  }
}

async function switchAndResend(
  $: EngineInterface,
  target: 'opus' | 'sonnet',
  from: string,
  text: string,
  kind: Kind,
  d: Decision,
) {
  let now = from
  try {
    await $.command.run({ command: 'model', args: targetAlias(target, from) })
    now = await $.session.model()
  } catch (err) {
    $.ui.log(`AMA: /model failed (${String(err)})`)
  }
  const switched = family(now) === target
  await logDecision($, kind, d, from, now, switched)
  $.ui.log(
    switched
      ? `AMA: now on ${DISPLAY[target]} (${now}); resending your message`
      : `AMA: switch to ${DISPLAY[target]} did not take (still ${now}); resending your message unchanged`,
  )
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (r.drop !== undefined) throw new Error(r.drop)
  } catch (err) {
    await $.prompt.fill({ text })
    $.ui.toast(`AMA could not resend your message (${String(err)}). It is back in the prompt box.`)
  }
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ai-model-autoroute',
      description: 'AMA, AI Model Autoroute: on, off, status, check <text>',
      argumentHint: 'on | off | status | check <text>',
    })
    return next(e)
  })

  on('command.run', { command: 'ai-model-autoroute' }, async ($, e) => {
    const [verb = 'status'] = e.args.trim().split(/\s+/)
    const arg = e.args.trim().slice(verb.length).trim()
    if (verb === 'on' || verb === 'off') {
      const ok = await writeState($, verb === 'on')
      return { text: ok ? `AMA is ${verb}.` : `AMA could not write its state file, so it is unchanged.` }
    }
    if (verb === 'status') {
      const s = await readState($)
      const entries = await readEntries($)
      const last = entries.at(-1)
      const word =
        s.kind === 'on' ? 'on' : s.kind === 'off' ? 'off' : s.kind === 'invalid' ? 'off (state file invalid)' : 'off (no state folder)'
      return { text: `AMA is ${word}. Last decision: ${last ? JSON.stringify(last) : 'none yet'}` }
    }
    if (verb === 'check' && arg !== '') {
      const d = await classify($, arg, 'first')
      return { text: `AMA check: ${d.label ?? 'none'} (${d.reason}, ${d.ms} ms, ${tokens(d.usage)})` }
    }
    return { text: 'Usage: /ai-model-autoroute on | off | status | check <text>' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || (e.attachments?.length ?? 0) > 0) return next(e)
    if (!isPersonTyped(e) || e.text.trim() === '') return next(e)
    if ((await readState($)).kind !== 'on') return next(e)

    const current = await $.session.model()
    const from = family(current)
    if (from === 'other') return next(e)

    // A window is fresh until the assistant has replied once: a window that has
    // only run slash commands is still fresh; a resumed window is not.
    const rows = await $.session.messages()
    if (!Array.isArray(rows)) return next(e)
    // Mid-window lift is off: a window with an assistant reply passes through.
    // To re-enable, compute kind as 'mid' here and restore the Sonnet-only check.
    if (rows.some(m => m.role === 'assistant')) return next(e)
    const kind: Kind = 'first'

    const d = await classify($, e.text, kind)
    const label = d.label ?? 'none'
    $.ui.log(`AMA: ${kind} ${label} (${d.reason}, ${d.ms} ms, ${tokens(d.usage)}; origin ${e.origin.kind})`)

    const target = d.label === 'OPUS' ? 'opus' : d.label === 'SONNET' ? 'sonnet' : undefined
    if (target === undefined || target === from) {
      await logDecision($, kind, d, current, current, false)
      return next(e)
    }

    const text = e.text
    $.clock.after(0, () => {
      void switchAndResend($, target, current, text, kind, d)
    })
    return { drop: `AMA: switching to ${DISPLAY[target]}, then resending your message.` }
  }).catch(($, e, next) => next(e))
}
