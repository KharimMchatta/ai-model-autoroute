import type { ModelCompleteResult, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { MID_SYSTEM, SYSTEM, parseLabel, routeMessage, targetAlias } from '../hooks/classifier'

const CAPTION = 'help me write a caption for social media for londa on topic of promotion'
const FIX = 'the payslip PDF download in LOP is broken, fix it'
const SECRET = 'SECRETMARK-9431 please build the LOP leave module'
const USAGE = { input_tokens: 900, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// The two prompts, spelled out so a change to either one is caught.
const EXPECTED_SYSTEM =
  "You route the first message of a work session to a model. Reply with exactly one word: OPUS, SONNET or STAY. No other text.\n\nSONNET only when the message's main task is one of these:\n- writing a social media caption or a community post (Londa Group, H4K-IT);\n- writing in Kharim's own voice: a LinkedIn post, an article, a script, a book chapter;\n- a spreadsheet, a register or a formal email;\n- ingesting a raw source document or updating the wiki.\n\nOPUS when the main task is any other real work: building, fixing or reviewing an app (LOP, ACP, websites, tools), security work, CTF challenges, presentations, training design, business strategy, proposals, HR and compliance documents, decisions and advice, CVs and job applications, research, KAI rules, skills, hooks and tools, video reels.\n\nSTAY when the message gives no clear new task: a status question about earlier work (\"what is remaining\"), \"continue\", an approval (\"we go with your recommendation\"), a pasted block with no new instruction, or when you are unsure.\n\nWhen a message mixes kinds of work, pick the heavier one: OPUS over SONNET.\n"
const EXPECTED_MID_SYSTEM =
  "You route one message from the middle of a work session that is running on Sonnet, the lighter model. Reply with exactly one word: OPUS or STAY. No other text.\n\nOPUS only when the message clearly starts a new piece of heavy work: building, fixing or reviewing an app (LOP, ACP, websites, tools), security work, CTF challenges, presentations, training design, business strategy, proposals, HR and compliance documents, decisions and advice, CVs and job applications, research, KAI rules, skills, hooks and tools, video reels.\n\nSTAY for everything else: a follow-up on the work already under way (\"fix that\", \"make it shorter\", \"continue\"), an approval (\"we go with your recommendation\"), a status question, a pasted block with no new instruction, writing a social media caption or a community post, writing in Kharim's own voice (a LinkedIn post, an article, a script, a book chapter), a spreadsheet, a register or a formal email, ingesting a raw source document or updating the wiki, or when you are unsure.\n"
const DIR = '/home/k/.claude/ama'
const STATE = `${DIR}/state.json`
const DECISIONS = `${DIR}/decisions.json`

type Fail = 'api-error' | 'aborted' | 'empty-reply' | 'deny'

type WorldOptions = {
  model?: string
  // 'fresh': no rows; 'commands': only user rows (slash commands); 'replied': an assistant row exists.
  window?: 'fresh' | 'commands' | 'replied' | 'deny'
  reply?: string
  fail?: Fail
  state?: string // state.json content; undefined means the file is missing
  files?: Record<string, string>
  home?: string | null
  stateDir?: string
  switchTakes?: boolean
  resendFails?: boolean
  writeFails?: boolean
}

function world(on: On, o: WorldOptions = {}) {
  const clock = mock.clock(on)
  const files: Record<string, string> = { ...(o.files ?? {}) }
  if (o.state !== undefined) files[STATE] = o.state
  const home = o.home === undefined ? '/home/k' : o.home
  const w = {
    clock,
    files,
    model: o.model ?? 'claude-opus-5-5[1m]',
    asks: [] as { model: string; effort?: string; system?: string; prompt: string }[],
    commands: [] as string[],
    entered: [] as string[],
    events: [] as { text: string; origin: { kind: string } }[],
    fills: [] as string[],
    logs: [] as string[],
    toasts: [] as string[],
    writes: [] as { path: string; text: string }[],
    json: (path: string) => JSON.parse(files[path] ?? 'null'),
    decisions: () => (JSON.parse(files[DECISIONS] ?? '{"decisions":[]}') as { decisions: Record<string, unknown>[] }).decisions,
  }
  on('env.get', (_$, e) => {
    if (e.name === 'AMA_STATE_DIR') return { value: o.stateDir }
    if (e.name === 'HOME') return { value: home ?? undefined }
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) return { deny: 'ENOENT' }
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    if (o.writeFails) return { deny: 'EACCES' }
    files[e.path] = e.text
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.messages', () => {
    const w2 = o.window ?? 'fresh'
    if (w2 === 'deny') return { deny: 'no transcript' }
    const rows =
      w2 === 'fresh'
        ? []
        : w2 === 'commands'
          ? [{ role: 'user' as const, text: '/status', toolUses: [] }]
          : [
              { role: 'user' as const, text: 'earlier request', toolUses: [] },
              { role: 'assistant' as const, text: 'earlier reply', toolUses: [] },
            ]
    return { value: rows }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.model', () => ({ value: w.model }))
  on('model.complete', (_$, e) => {
    w.asks.push({ model: e.model, effort: e.effort, system: e.system, prompt: e.prompt })
    if (o.fail === 'deny') return { deny: 'blocked model' }
    const result: ModelCompleteResult =
      o.fail === 'api-error'
        ? { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request', usage: ZERO }
        : o.fail === 'aborted'
          ? { isAnswered: false, reason: 'aborted', usage: ZERO }
          : o.fail === 'empty-reply'
            ? { isAnswered: false, reason: 'empty-reply', usage: ZERO }
            : { isAnswered: true, text: o.reply ?? 'STAY', usage: USAGE }
    return { value: result }
  })
  on('command.run', { command: 'model' }, (_$, e) => {
    w.commands.push(`model ${e.args}`)
    if (o.switchTakes !== false) {
      const big = e.args.endsWith('[1m]') ? '[1m]' : ''
      w.model = e.args.startsWith('sonnet') ? `claude-sonnet-5-5${big}` : `claude-opus-5-5${big}`
    }
    return { text: '' }
  })
  on('prompt.submit', (_$, e) => {
    if (o.resendFails && e.origin.kind === 'plugin') return { drop: 'host limit reached' }
    w.entered.push(e.text)
    w.events.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('prompt.fill', (_$, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

const typed = (text: string) => ({ text, origin: { kind: 'sdk' as const }, wait: false })

const typedCommand = (args: string) => ({
  command: 'ai-model-autoroute',
  args,
  origin: { kind: 'sdk' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

async function settle(w: { clock: { settle: () => Promise<void> } }) {
  await w.clock.settle()
  await w.clock.settle()
}

const SONNET = 'claude-sonnet-5-5'

describe('fresh window switches', () => {
  test('Opus window, caption: switches to Sonnet (1M kept), resends, logs kind first', async ($, on) => {
    const w = world(on, { reply: 'SONNET' })
    const r = await $.prompt.submit(typed(CAPTION))
    expect(r.drop).toContain('Sonnet 5.5')
    await settle(w)
    expect(w.commands).toEqual(['model sonnet[1m]'])
    expect(w.entered).toEqual([CAPTION])
    expect(w.asks).toEqual([{ model: 'sonnet', effort: 'medium', system: SYSTEM, prompt: routeMessage(CAPTION) }])
    expect(w.logs.some(l => l.includes('AMA: now on Sonnet 5.5'))).toBe(true)
    const d = w.decisions()
    expect(d.length).toBe(1)
    expect(d[0]).toMatchObject({
      kind: 'first',
      label: 'SONNET',
      from: 'claude-opus-5-5[1m]',
      to: 'claude-sonnet-5-5[1m]',
      switched: true,
      inputTokens: 900,
      outputTokens: 3,
      reason: 'answered',
    })
  })

  test('Sonnet window, app fix: switches to Opus and resends the prompt', async ($, on) => {
    const w = world(on, { model: SONNET, reply: 'OPUS' })
    const r = await $.prompt.submit(typed(FIX))
    expect(r.drop).toContain('Opus 5.5')
    await settle(w)
    expect(w.commands).toEqual(['model opus'])
    expect(w.entered).toEqual([FIX])
    expect(w.asks[0]?.system).toBe(SYSTEM)
  })

  test('window with only slash commands is still fresh: caption on Opus switches to Sonnet', async ($, on) => {
    const w = world(on, { reply: 'SONNET', window: 'commands' })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.commands).toEqual(['model sonnet[1m]'])
    expect(w.entered).toEqual([CAPTION])
    expect(w.asks[0]?.system).toBe(SYSTEM)
  })

  test('switch that does not take: prompt still resent, log says so, decision not switched', async ($, on) => {
    const w = world(on, { reply: 'SONNET', switchTakes: false })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.entered).toEqual([CAPTION])
    expect(w.logs.some(l => l.includes('did not take'))).toBe(true)
    expect(w.decisions()[0]).toMatchObject({ switched: false, from: 'claude-opus-5-5[1m]', to: 'claude-opus-5-5[1m]' })
  })

  test('resend refused: text goes back into the prompt box with a toast', async ($, on) => {
    const w = world(on, { reply: 'SONNET', resendFails: true })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.entered).toEqual([])
    expect(w.fills).toEqual([CAPTION])
    expect(w.toasts.length).toBe(1)
  })

  test('decision log write fails: switch and resend still happen', async ($, on) => {
    const w = world(on, { reply: 'SONNET', writeFails: true })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.commands).toEqual(['model sonnet[1m]'])
    expect(w.entered).toEqual([CAPTION])
  })
})

describe('mid-window lift is off', () => {
  // A window with an assistant reply is passed through: no classifier call,
  // no /model, no decision logged, the event goes to next unchanged.
  const untouched = (name: string, o: WorldOptions, text = FIX) =>
    test(name, async ($, on) => {
      const w = world(on, { window: 'replied', ...o })
      const r = await $.prompt.submit(typed(text))
      await settle(w)
      expect(r.drop).toBeUndefined()
      expect(w.asks.length).toBe(0)
      expect(w.commands).toEqual([])
      expect(w.entered).toEqual([text])
      expect(w.writes).toEqual([])
      expect(w.decisions()).toEqual([])
    })

  untouched('Sonnet window with an assistant row, heavy prompt, OPUS reply: no lift', { model: SONNET, reply: 'OPUS' })
  untouched('Sonnet 1M window with an assistant row, no lift', { model: `${SONNET}[1m]`, reply: 'OPUS' })
  untouched('Sonnet window with an assistant row, STAY reply: nothing logged', { model: SONNET, reply: 'STAY' }, 'make it shorter')
  untouched('Sonnet window with an assistant row, caption: nothing logged', { model: SONNET, reply: 'SONNET' }, CAPTION)
  untouched('Opus window with an assistant row and a SONNET-worthy prompt', { reply: 'SONNET' }, CAPTION)
  untouched('Opus window with an assistant row, heavy prompt', { reply: 'OPUS' })
  for (const fail of ['api-error', 'aborted', 'empty-reply', 'deny'] as const) {
    untouched(`Sonnet window with an assistant row, classifier ${fail}: never called`, { model: SONNET, fail })
  }

  test('pass-through hands next the same event: same text and origin, no resend', async ($, on) => {
    const w = world(on, { model: SONNET, window: 'replied', reply: 'OPUS' })
    await $.prompt.submit(typed(FIX))
    await settle(w)
    expect(w.events).toEqual([{ text: FIX, origin: { kind: 'sdk' } }])
    expect(w.asks.length).toBe(0)
  })

  test('Sonnet window with only slash commands is still fresh: heavy prompt is classified and lifted', async ($, on) => {
    const w = world(on, { model: SONNET, window: 'commands', reply: 'OPUS' })
    const r = await $.prompt.submit(typed(FIX))
    expect(r.drop).toContain('Opus 5.5')
    await settle(w)
    expect(w.commands).toEqual(['model opus'])
    expect(w.entered).toEqual([FIX])
    expect(w.asks).toEqual([{ model: 'sonnet', effort: 'medium', system: SYSTEM, prompt: routeMessage(FIX) }])
    expect(w.decisions()[0]).toMatchObject({ kind: 'first', label: 'OPUS', switched: true })
  })
})

describe('passes through untouched', () => {
  const passes = (name: string, o: WorldOptions, input: Record<string, unknown>, asks: number) =>
    test(name, async ($, on) => {
      const w = world(on, o)
      const r = await $.prompt.submit({ ...typed(CAPTION), ...input } as Parameters<typeof $.prompt.submit>[0])
      await settle(w)
      expect(r.drop).toBeUndefined()
      expect(w.entered).toEqual([String(input.text ?? CAPTION)])
      expect(w.commands).toEqual([])
      expect(w.asks.length).toBe(asks)
    })

  passes('STAY label', { reply: 'STAY' }, {}, 1)
  passes('label matches the current model', { reply: 'OPUS' }, {}, 1)
  passes('Sonnet window, Sonnet label', { model: SONNET, reply: 'SONNET' }, {}, 1)
  passes('unclear label', { reply: 'I think SONNET' }, {}, 1)
  passes('classifier api-error', { fail: 'api-error' }, {}, 1)
  passes('classifier timeout', { fail: 'aborted' }, {}, 1)
  passes('classifier empty reply', { fail: 'empty-reply' }, {}, 1)
  passes('classifier call refused', { fail: 'deny' }, {}, 1)
  passes('transcript unreadable (deny)', { reply: 'SONNET', window: 'deny' }, {}, 0)
  passes('resumed Opus window (has replies)', { reply: 'SONNET', window: 'replied' }, {}, 0)
  passes('Fable picked', { reply: 'SONNET', model: 'claude-fable-5-1' }, {}, 0)
  passes('Haiku picked', { reply: 'OPUS', model: 'claude-haiku-5-5' }, {}, 0)
  passes('Fable picked, mid-window', { reply: 'OPUS', model: 'claude-fable-5-1', window: 'replied' }, {}, 0)
  passes('Haiku picked, mid-window', { reply: 'OPUS', model: 'claude-haiku-5-5', window: 'replied' }, {}, 0)
  passes('not typed by the person', { reply: 'SONNET' }, { origin: { kind: 'task-notification' } }, 0)
  passes('prompt with an attachment', { reply: 'SONNET' }, { attachments: [{ type: 'image' }] }, 0)
  passes('blank prompt', { reply: 'SONNET' }, { text: '   ' }, 0)
  passes('meta prompt', { reply: 'SONNET' }, { isMeta: true }, 0)
  passes('slash command', { reply: 'SONNET' }, { command: { name: 'review', args: '' } }, 0)
  passes('Sonnet window, STAY label', { model: SONNET, reply: 'STAY' }, {}, 1)
  passes('Sonnet window, unclear label', { model: SONNET, reply: 'maybe' }, {}, 1)
  passes('Sonnet window, classifier api-error', { model: SONNET, fail: 'api-error' }, {}, 1)
  passes('Sonnet window, classifier timeout', { model: SONNET, fail: 'aborted' }, {}, 1)
  passes('Sonnet window, classifier call refused', { model: SONNET, fail: 'deny' }, {}, 1)
  passes('Sonnet mid-window, typed by the system', { model: SONNET, window: 'replied', reply: 'OPUS' }, { origin: { kind: 'task-notification' } }, 0)
  passes('Sonnet mid-window, slash command', { model: SONNET, window: 'replied', reply: 'OPUS' }, { command: { name: 'x', args: '' } }, 0)
  passes('Sonnet mid-window, attachment', { model: SONNET, window: 'replied', reply: 'OPUS' }, { attachments: [{ type: 'image' }] }, 0)
  passes('Sonnet mid-window, blank', { model: SONNET, window: 'replied', reply: 'OPUS' }, { text: ' ' }, 0)
  passes('Sonnet mid-window, meta', { model: SONNET, window: 'replied', reply: 'OPUS' }, { isMeta: true }, 0)
})

describe('state file', () => {
  test('state.json missing means on', async ($, on) => {
    const w = world(on, { reply: 'SONNET' })
    expect(STATE in w.files).toBe(false)
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.asks.length).toBe(1)
    expect(w.commands).toEqual(['model sonnet[1m]'])
  })

  test('enabled:true means on', async ($, on) => {
    const w = world(on, { reply: 'SONNET', state: JSON.stringify({ version: 1, enabled: true }) })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.asks.length).toBe(1)
  })

  const off = (name: string, state: string) =>
    test(name, async ($, on) => {
      const w = world(on, { reply: 'SONNET', state })
      const r = await $.prompt.submit(typed(CAPTION))
      await settle(w)
      expect(r.drop).toBeUndefined()
      expect(w.asks.length).toBe(0)
      expect(w.commands).toEqual([])
      expect(w.entered).toEqual([CAPTION])
      expect(w.writes).toEqual([])
    })

  off('enabled:false means off', JSON.stringify({ version: 1, enabled: false }))
  off('invalid JSON means off, no classifier call', '{not json')
  off('wrong version means off', JSON.stringify({ version: 2, enabled: true }))
  off('missing version means off', JSON.stringify({ enabled: true }))
  off('non-boolean enabled means off', JSON.stringify({ version: 1, enabled: 'yes' }))
  off('JSON null means off', 'null')

  test('AMA_STATE_DIR is honoured for state: its state.json says off', async ($, on) => {
    const w = world(on, {
      reply: 'SONNET',
      stateDir: '/custom/ama',
      files: { '/custom/ama/state.json': JSON.stringify({ version: 1, enabled: false }) },
    })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.asks.length).toBe(0)
  })

  test('the HOME folder is ignored when AMA_STATE_DIR is set', async ($, on) => {
    const w = world(on, { reply: 'SONNET', stateDir: '/custom/ama', state: JSON.stringify({ version: 1, enabled: false }) })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.asks.length).toBe(1)
  })

  test('AMA_STATE_DIR on: decisions go to that folder', async ($, on) => {
    const w = world(on, { reply: 'STAY', stateDir: '/custom/ama' })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(Object.keys(w.files)).toEqual(['/custom/ama/decisions.json'])
  })

  test('HOME and AMA_STATE_DIR both missing means off, nothing logged', async ($, on) => {
    const w = world(on, { reply: 'SONNET', home: null })
    const r = await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(r.drop).toBeUndefined()
    expect(w.asks.length).toBe(0)
    expect(w.writes).toEqual([])
  })
})

describe('commands', () => {
  test('/ai-model-autoroute off writes state.json, then a caption passes without classifying', async ($, on) => {
    const w = world(on, { reply: 'SONNET' })
    const off = await $.command.run(typedCommand('off'))
    expect(off.text).toContain('off')
    expect(w.json(STATE)).toMatchObject({ version: 1, enabled: false, updatedBy: 'command' })
    expect(typeof w.json(STATE).updatedAt).toBe('string')
    const status = await $.command.run(typedCommand('status'))
    expect(status.text).toContain('AMA is off')
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.asks.length).toBe(0)
    expect(w.entered).toEqual([CAPTION])
  })

  test('on writes enabled:true with updatedBy command and switching resumes', async ($, on) => {
    const w = world(on, { reply: 'SONNET', state: JSON.stringify({ version: 1, enabled: false }) })
    await $.command.run(typedCommand('on'))
    expect(w.json(STATE)).toMatchObject({ version: 1, enabled: true, updatedBy: 'command' })
    expect(Object.keys(w.json(STATE)).sort()).toEqual(['enabled', 'updatedAt', 'updatedBy', 'version'])
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.asks.length).toBe(1)
  })

  test('on/off with no state folder reports and writes nothing', async ($, on) => {
    const w = world(on, { home: null })
    const r = await $.command.run(typedCommand('on'))
    expect(r.text).toContain('could not write')
    expect(w.writes).toEqual([])
  })

  test('status shows on when the file is missing', async ($, on) => {
    const a = world(on)
    expect((await $.command.run(typedCommand('status'))).text).toContain('AMA is on.')
    expect(a.writes).toEqual([])
  })

  test('status shows off', async ($, on) => {
    const b = world(on, { state: JSON.stringify({ version: 1, enabled: false }) })
    expect((await $.command.run(typedCommand('status'))).text).toContain('AMA is off.')
    expect(b.writes).toEqual([])
  })

  test('status shows invalid', async ($, on) => {
    world(on, { state: '{broken' })
    expect((await $.command.run(typedCommand('status'))).text).toContain('AMA is off (state file invalid)')
  })

  test('status shows the last decision', async ($, on) => {
    const w = world(on, { reply: 'SONNET' })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    const status = await $.command.run(typedCommand('status'))
    expect(status.text).toContain('"kind":"first"')
    expect(status.text).toContain('"label":"SONNET"')
    expect(status.text).not.toContain(CAPTION)
  })

  test('check classifies with the first-prompt system text', async ($, on) => {
    const w = world(on, { reply: 'OPUS' })
    const r = await $.command.run(typedCommand(`check ${FIX}`))
    expect(r.text).toContain('AMA check: OPUS')
    expect(w.asks[0]?.system).toBe(SYSTEM)
  })
})

describe('decisions log', () => {
  const seed = (n: number) =>
    JSON.stringify({
      version: 1,
      decisions: Array.from({ length: n }, (_, i) => ({
        at: '2026-10-21T00:00:00.000Z',
        kind: 'first',
        label: 'STAY',
        from: 'x',
        to: 'x',
        switched: false,
        ms: i,
        inputTokens: null,
        outputTokens: null,
        reason: `seed-${i}`,
      })),
    })

  test('capped at 50: seed 50, add one, expect 50 with the newest last', async ($, on) => {
    const w = world(on, { reply: 'STAY', files: { [DECISIONS]: seed(50) } })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    const d = w.decisions()
    expect(d.length).toBe(50)
    expect(d[0]?.reason).toBe('seed-1')
    expect(d[49]?.reason).toBe('answered')
    expect(w.json(DECISIONS).version).toBe(1)
  })

  test('below the cap entries are appended, oldest first', async ($, on) => {
    const w = world(on, { reply: 'STAY', files: { [DECISIONS]: seed(3) } })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    const d = w.decisions()
    expect(d.length).toBe(4)
    expect(d[0]?.reason).toBe('seed-0')
    expect(d[3]?.reason).toBe('answered')
  })

  test('entries carry exactly the contract fields', async ($, on) => {
    const w = world(on, { reply: 'STAY' })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(Object.keys(w.decisions()[0] ?? {}).sort()).toEqual(
      ['at', 'from', 'inputTokens', 'kind', 'label', 'ms', 'outputTokens', 'reason', 'switched', 'to'].sort(),
    )
  })

  test('classifier error logs label none with null tokens', async ($, on) => {
    const w = world(on, { fail: 'empty-reply' })
    await $.prompt.submit(typed(CAPTION))
    await settle(w)
    expect(w.decisions()[0]).toMatchObject({ label: 'none', switched: false, reason: 'empty-reply' })
  })

  const broken = (name: string, content: string) =>
    test(name, async ($, on) => {
      const w = world(on, { reply: 'STAY', files: { [DECISIONS]: content } })
      await $.prompt.submit(typed(CAPTION))
      await settle(w)
      expect(w.decisions().length).toBe(1)
      expect(w.json(DECISIONS).version).toBe(1)
    })
  broken('unreadable decisions.json is replaced by a fresh one', '{oops')
  broken('wrong-version decisions.json is replaced', JSON.stringify({ version: 9, decisions: [{ reason: 'old' }] }))
  broken('decisions not an array is replaced', JSON.stringify({ version: 1, decisions: 'x' }))

  const secretCases: [string, WorldOptions][] = [
    ['switch', { reply: 'SONNET' }],
    ['pass', { reply: 'STAY' }],
    ['api error', { fail: 'api-error' }],
    ['refused', { fail: 'deny' }],
    ['switch did not take', { reply: 'SONNET', switchTakes: false }],
    ['resend fails', { reply: 'SONNET', resendFails: true }],
  ]
  for (const [name, o] of secretCases) {
    test(`no written file contains the prompt text: ${name}`, async ($, on) => {
      const w = world(on, o)
      await $.prompt.submit(typed(SECRET))
      await settle(w)
      expect(w.writes.length).toBeGreaterThan(0)
      for (const wr of w.writes) {
        expect(wr.text).not.toContain('SECRETMARK')
        expect(wr.text).not.toContain('LOP leave')
      }
    })
  }
})

describe('classifier helpers', () => {
  test('parseLabel matches the step 1 parser', () => {
    expect(parseLabel('SONNET')).toBe('SONNET')
    expect(parseLabel(' opus.\n')).toBe('OPUS')
    expect(parseLabel('"STAY"')).toBe('STAY')
    expect(parseLabel('I think SONNET')).toBeUndefined()
    expect(parseLabel('')).toBeUndefined()
  })

  test('routeMessage keeps the first 4000 code points', () => {
    const long = 'a'.repeat(3999) + 'é' + 'b'.repeat(10)
    expect(routeMessage(long)).toBe('Message to route:\n<<<\n' + 'a'.repeat(3999) + 'é' + '\n>>>')
  })

  test('targetAlias keeps the 1M window', () => {
    expect(targetAlias('sonnet', 'claude-opus-5-5[1m]')).toBe('sonnet[1m]')
    expect(targetAlias('opus', 'claude-sonnet-5-5')).toBe('opus')
  })

  test('SYSTEM is the step 1 prompt, byte for byte', () => {
    expect(SYSTEM).toBe(EXPECTED_SYSTEM)
  })

  test('MID_SYSTEM is the approved mid-window prompt, byte for byte', () => {
    expect(MID_SYSTEM).toBe(EXPECTED_MID_SYSTEM)
  })

  test('MID_SYSTEM asks for OPUS or STAY only', () => {
    expect(MID_SYSTEM).toContain('exactly one word: OPUS or STAY')
    expect(MID_SYSTEM).not.toContain('SONNET')
  })
})
