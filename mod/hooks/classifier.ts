// AMA classifier. SYSTEM is the step 1 prompt, unchanged (passed the 2026-10-21
// test; see the README, "How it was tested"); MID_SYSTEM is the
// mid-window prompt: Sonnet window, OPUS or STAY only.

export type Label = 'OPUS' | 'SONNET' | 'STAY'
export type Kind = 'first' | 'mid'
export type Family = 'opus' | 'sonnet' | 'other'

export const CLASSIFIER_MODEL = 'sonnet'
export const CLASSIFIER_EFFORT = 'medium'

export const SYSTEM = "You route the first message of a work session to a model. Reply with exactly one word: OPUS, SONNET or STAY. No other text.\n\nSONNET only when the message's main task is one of these:\n- writing a social media caption or a community post (Londa Group, H4K-IT);\n- writing in Kharim's own voice: a LinkedIn post, an article, a script, a book chapter;\n- a spreadsheet, a register or a formal email;\n- ingesting a raw source document or updating the wiki.\n\nOPUS when the main task is any other real work: building, fixing or reviewing an app (LOP, ACP, websites, tools), security work, CTF challenges, presentations, training design, business strategy, proposals, HR and compliance documents, decisions and advice, CVs and job applications, research, KAI rules, skills, hooks and tools, video reels.\n\nSTAY when the message gives no clear new task: a status question about earlier work (\"what is remaining\"), \"continue\", an approval (\"we go with your recommendation\"), a pasted block with no new instruction, or when you are unsure.\n\nWhen a message mixes kinds of work, pick the heavier one: OPUS over SONNET.\n"

export const MID_SYSTEM = "You route one message from the middle of a work session that is running on Sonnet, the lighter model. Reply with exactly one word: OPUS or STAY. No other text.\n\nOPUS only when the message clearly starts a new piece of heavy work: building, fixing or reviewing an app (LOP, ACP, websites, tools), security work, CTF challenges, presentations, training design, business strategy, proposals, HR and compliance documents, decisions and advice, CVs and job applications, research, KAI rules, skills, hooks and tools, video reels.\n\nSTAY for everything else: a follow-up on the work already under way (\"fix that\", \"make it shorter\", \"continue\"), an approval (\"we go with your recommendation\"), a status question, a pasted block with no new instruction, writing a social media caption or a community post, writing in Kharim's own voice (a LinkedIn post, an article, a script, a book chapter), a spreadsheet, a register or a formal email, ingesting a raw source document or updating the wiki, or when you are unsure.\n"

const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

// The message as step 1 sent it: the first 4000 code points.
export function routeMessage(text: string): string {
  return 'Message to route:\n<<<\n' + Array.from(text).slice(0, 4000).join('') + '\n>>>'
}

// Step 1's parser: the first word, outer punctuation stripped, upper case.
export function parseLabel(raw: string): Label | undefined {
  const first = raw.trim().toUpperCase().split(/\s+/)[0] ?? ''
  let start = 0
  let end = first.length
  while (start < end && PUNCTUATION.includes(first.charAt(start))) start++
  while (end > start && PUNCTUATION.includes(first.charAt(end - 1))) end--
  const word = first.slice(start, end)
  return word === 'OPUS' || word === 'SONNET' || word === 'STAY' ? word : undefined
}

export function family(model: string): Family {
  const id = model.toLowerCase()
  if (id.includes('opus')) return 'opus'
  if (id.includes('sonnet')) return 'sonnet'
  return 'other'
}

// Keeps the context size Kharim picked: a 1M window switches to the 1M variant.
export function targetAlias(target: 'opus' | 'sonnet', current: string): string {
  return /\[1m\]|\b1m\b/i.test(current) ? `${target}[1m]` : target
}

export const DISPLAY: Record<'opus' | 'sonnet', string> = {
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5.5',
}
