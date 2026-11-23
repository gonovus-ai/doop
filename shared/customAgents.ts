/**
 * Custom agents: specialists a person or a workspace adds to the built-in team
 * (shared/agents.ts). One is an ordinary `AgentRole` with `custom: true`; the
 * resident agent runs it the way it runs the Copywriter, with the agent's
 * instructions as its specialty. A canvas has its workspace's custom agents,
 * or on a personal canvas its owner's, the way it has a font library.
 *
 * The handle (its role id, what people @mention) and the name (the identity it
 * works under in presence, tasks and comment threads) are fixed once it
 * exists: open work points at them. Everything else can change.
 */
import { AGENT_ROLES, DEFAULT_ROLE_ID, mentionsFor, type AgentRole } from './agents.ts'
import { avatarUrl } from './avatar.ts'

export const MAX_CUSTOM_AGENTS = 20
export const MAX_AGENT_NAME = 32
export const MAX_AGENT_BLURB = 80
export const MIN_AGENT_BRIEF = 20
export const MAX_AGENT_BRIEF = 2000
export const MAX_WEBHOOK_URL = 2000
export const MIN_WEBHOOK_SECRET = 8
export const MAX_WEBHOOK_SECRET = 256
export const MAX_WEBHOOK_HEADERS = 20
export const MAX_WEBHOOK_HEADER_NAME = 100
export const MAX_WEBHOOK_HEADER_VALUE = 4096

export const WEBHOOK_PAYLOAD_FORMATS = ['doop', 'text'] as const
export type WebhookPayloadFormat = (typeof WEBHOOK_PAYLOAD_FORMATS)[number]

/** RFC 7230 HTTP header token */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FORBIDDEN_WEBHOOK_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection'])

/** a lowercase word: a letter, then letters and digits */
const HANDLE = /^[a-z][a-z0-9]{1,23}$/
const COLOR = /^#[0-9a-f]{6}$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** The swatches the editor offers; any #rrggbb is accepted. */
export const CUSTOM_AGENT_COLORS = [
  '#E8432E',
  '#2743EE',
  '#8B5CF6',
  '#D98E04',
  '#0E8FA0',
  '#0E9F6E',
  '#DB2777',
  '#475569',
] as const

/** Where a custom agent lives: one workspace, or one person's own canvases. */
export type AgentScope = { workspaceId: string } | { personal: true }

export interface CustomAgent extends AgentRole {
  custom: true
  createdAt: number
  /** true when this agent runs externally via webhook + MCP */
  external?: boolean
  /** optional uploaded /a/<id>.<ext> avatar URL */
  avatar?: string
  /** optional bound agent_keys.id so MCP calls with that key act as this agent */
  agentKeyId?: string
  /** webhook URL for outbound signed event pushes */
  webhookUrl?: string
  /** true when a signing secret is stored (never returned on list/GET) */
  hasWebhookSecret?: boolean
  /** returned ONCE on create or secret rotation; omitted everywhere else */
  webhookSecret?: string
  /** names of configured custom HTTP headers (values are never returned on list/GET) */
  webhookHeaderNames?: string[]
  /** payload body shape: 'doop' (default JSON) or 'text' ({"text": "..."}) */
  webhookPayloadFormat?: WebhookPayloadFormat
}

/** What the editor sends to create an agent. */
export interface CustomAgentInput {
  handle: string
  name: string
  color: string
  blurb: string
  brief: string
  reviewer: boolean
  external?: boolean
  avatar?: string | null
  agentKeyId?: string | null
  webhookUrl?: string | null
  webhookSecret?: string | null
  webhookHeaders?: Record<string, string> | null
  webhookPayloadFormat?: WebhookPayloadFormat | null
}

/** What it sends to change one; the handle and the name stay. */
export type CustomAgentPatch = Partial<
  Pick<
    CustomAgentInput,
    | 'color'
    | 'blurb'
    | 'brief'
    | 'reviewer'
    | 'avatar'
    | 'agentKeyId'
    | 'webhookUrl'
    | 'webhookSecret'
    | 'webhookHeaders'
    | 'webhookPayloadFormat'
  >
>

/** What it sends to change a built-in agent for one team: the same fields,
 *  and whether the agent is switched off. */
export type BuiltInAgentPatch = CustomAgentPatch & { disabled?: boolean }

/** A built-in agent as one team has it: its values with the team's changes
 *  applied, whether it is on, and whether anything differs from how it ships. */
export interface BuiltInAgent extends AgentRole {
  enabled: boolean
  edited: boolean
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** Whether a string is shaped like a custom agent's handle. Code that cannot
 *  see a canvas's agents (an automation step's parser) keeps such an id; the
 *  canvas's roster decides what it names when the work runs. */
export function isAgentHandle(id: string): boolean {
  return HANDLE.test(id)
}

/** A handle no built-in agent answers to already. */
function handleTaken(handle: string): boolean {
  return AGENT_ROLES.some((role) => mentionsFor(role).includes(handle))
}

/** A name a built-in agent or a server job already works under. */
function nameTaken(name: string): boolean {
  const key = name.toLowerCase()
  return AGENT_ROLES.some((role) => role.name.toLowerCase() === key)
}

/** A suggested handle for a name: its letters and digits, lowercased. */
export function handleFor(name: string): string {
  const squashed = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^[0-9]+/, '')
  return squashed.slice(0, 24)
}

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
}

function blurbOf(raw: unknown): Parsed<string> {
  const blurb = text(raw)
  if (!blurb) return { ok: false, error: 'add a one-line description' }
  if (blurb.length > MAX_AGENT_BLURB)
    return { ok: false, error: `keep the description under ${MAX_AGENT_BLURB} characters` }
  return { ok: true, value: blurb }
}

function briefOf(raw: unknown, optional = false): Parsed<string> {
  /* line breaks are kept: instructions read better as a list */
  const brief = typeof raw === 'string' ? raw.trim() : ''
  if (!optional && brief.length < MIN_AGENT_BRIEF)
    return { ok: false, error: 'describe what the agent does in a sentence or two' }
  if (brief.length > MAX_AGENT_BRIEF)
    return { ok: false, error: `keep the instructions under ${MAX_AGENT_BRIEF} characters` }
  return { ok: true, value: brief }
}

function colorOf(raw: unknown): Parsed<string> {
  return typeof raw === 'string' && COLOR.test(raw)
    ? { ok: true, value: raw.toUpperCase() }
    : { ok: false, error: 'pick a colour' }
}

function avatarOf(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'avatar must be an uploaded /a/ image URL' }
  const clean = avatarUrl(raw.trim())
  if (!clean) return { ok: false, error: 'avatar must be an uploaded /a/ image URL' }
  return { ok: true, value: clean }
}

function webhookUrlOf(raw: unknown, required: boolean): Parsed<string | null> {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) {
    return required ? { ok: false, error: 'add a webhook URL for this external agent' } : { ok: true, value: null }
  }
  if (value.length > MAX_WEBHOOK_URL) return { ok: false, error: 'that webhook URL is too long' }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: 'the webhook URL must start with https:// or http://' }
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: 'credentials in the webhook URL are not supported' }
    }
  } catch {
    return { ok: false, error: 'that is not a valid webhook URL' }
  }
  return { ok: true, value }
}

function webhookSecretOf(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'invalid webhook secret' }
  const clean = raw.trim()
  if (!clean) return { ok: true, value: null }
  if (clean.length < MIN_WEBHOOK_SECRET || clean.length > MAX_WEBHOOK_SECRET || CONTROL.test(clean)) {
    return { ok: false, error: `webhook secret must be ${MIN_WEBHOOK_SECRET} to ${MAX_WEBHOOK_SECRET} characters` }
  }
  return { ok: true, value: clean }
}

function agentKeyIdOf(raw: unknown): Parsed<string | null> {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'invalid agent key id' }
  const clean = raw.trim()
  if (!clean) return { ok: true, value: null }
  if (clean.length > 64 || CONTROL.test(clean)) return { ok: false, error: 'invalid agent key id' }
  return { ok: true, value: clean }
}

export function parseWebhookHeaders(raw: unknown): Parsed<Record<string, string> | null> {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'webhook headers must be a JSON object of header names to string values' }
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return { ok: true, value: null }
  if (entries.length > MAX_WEBHOOK_HEADERS) {
    return { ok: false, error: `keep custom webhook headers to ${MAX_WEBHOOK_HEADERS} or fewer` }
  }
  const out: Record<string, string> = {}
  const seenLower = new Set<string>()
  for (const [rawKey, rawVal] of entries) {
    const name = rawKey.trim()
    if (!name || name.length > MAX_WEBHOOK_HEADER_NAME || !HEADER_NAME.test(name)) {
      return { ok: false, error: `invalid webhook header name: ${rawKey}` }
    }
    const lower = name.toLowerCase()
    if (FORBIDDEN_WEBHOOK_HEADERS.has(lower)) {
      return { ok: false, error: `header "${name}" cannot be overridden` }
    }
    if (seenLower.has(lower)) {
      return { ok: false, error: `duplicate webhook header: ${name}` }
    }
    seenLower.add(lower)
    if (typeof rawVal !== 'string') {
      return { ok: false, error: `header "${name}" must have a string value` }
    }
    const val = rawVal.trim()
    if (!val || val.length > MAX_WEBHOOK_HEADER_VALUE || CONTROL.test(val)) {
      return { ok: false, error: `invalid value for webhook header "${name}"` }
    }
    out[name] = val
  }
  return { ok: true, value: out }
}

function webhookPayloadFormatOf(raw: unknown): Parsed<WebhookPayloadFormat> {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: 'doop' }
  if (raw === 'doop' || raw === 'text') return { ok: true, value: raw }
  return { ok: false, error: 'webhook payload format must be "doop" or "text"' }
}

/** Check a new agent against the built-in team; the caller checks it against
 *  the custom agents already in its scope. */
export function parseCustomAgentInput(raw: unknown): Parsed<CustomAgentInput> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const external = input.external === true
  const name = text(input.name)
  if (name.length < 2 || name.length > MAX_AGENT_NAME || CONTROL.test(name) || name.includes('@'))
    return { ok: false, error: `name the agent in 2 to ${MAX_AGENT_NAME} characters, without @` }
  if (nameTaken(name)) return { ok: false, error: `${name} is already on the team` }
  const handle = typeof input.handle === 'string' ? input.handle.trim().replace(/^@+/, '').toLowerCase() : ''
  if (!HANDLE.test(handle))
    return { ok: false, error: 'the handle is 2 to 24 lowercase letters and digits, starting with a letter' }
  if (handleTaken(handle)) return { ok: false, error: `@${handle} already belongs to a built-in agent` }
  const blurb = blurbOf(input.blurb)
  if (!blurb.ok) return blurb
  const brief = briefOf(input.brief, external)
  if (!brief.ok) return brief
  const color = colorOf(input.color)
  if (!color.ok) return color
  const avatar = avatarOf(input.avatar)
  if (!avatar.ok) return avatar
  const agentKeyId = external ? agentKeyIdOf(input.agentKeyId) : { ok: true as const, value: null }
  if (!agentKeyId.ok) return agentKeyId
  const webhookUrl = external ? webhookUrlOf(input.webhookUrl, true) : { ok: true as const, value: null }
  if (!webhookUrl.ok) return webhookUrl
  const webhookSecret = external ? webhookSecretOf(input.webhookSecret) : { ok: true as const, value: null }
  if (!webhookSecret.ok) return webhookSecret
  const webhookHeaders = external ? parseWebhookHeaders(input.webhookHeaders) : { ok: true as const, value: null }
  if (!webhookHeaders.ok) return webhookHeaders
  const webhookPayloadFormat = external
    ? webhookPayloadFormatOf(input.webhookPayloadFormat)
    : { ok: true as const, value: 'doop' as const }
  if (!webhookPayloadFormat.ok) return webhookPayloadFormat
  return {
    ok: true,
    value: {
      handle,
      name,
      color: color.value,
      blurb: blurb.value,
      brief: brief.value,
      reviewer: input.reviewer === true,
      ...(external
        ? {
            external: true,
            ...(avatar.value ? { avatar: avatar.value } : {}),
            ...(agentKeyId.value ? { agentKeyId: agentKeyId.value } : {}),
            ...(webhookUrl.value ? { webhookUrl: webhookUrl.value } : {}),
            ...(webhookSecret.value ? { webhookSecret: webhookSecret.value } : {}),
            ...(webhookHeaders.value ? { webhookHeaders: webhookHeaders.value } : {}),
            webhookPayloadFormat: webhookPayloadFormat.value,
          }
        : {
            ...(avatar.value ? { avatar: avatar.value } : {}),
          }),
    },
  }
}

/** A built-in agent's patch; the default agent cannot be switched off, since
 *  everything addressed to no one (and to an agent that is off) goes to it. */
export function parseBuiltInAgentPatch(roleId: string, raw: unknown): Parsed<BuiltInAgentPatch> {
  if (!AGENT_ROLES.some((role) => role.id === roleId)) return { ok: false, error: 'no such built-in agent' }
  const fields = parseCustomAgentPatch(raw)
  if (!fields.ok) return fields
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (!('disabled' in input)) return fields
  if (input.disabled === true && roleId === DEFAULT_ROLE_ID)
    return { ok: false, error: 'Doop is the default agent and stays on: work addressed to no one goes to it' }
  return { ok: true, value: { ...fields.value, disabled: input.disabled === true } }
}

export function parseCustomAgentPatch(raw: unknown, options?: { external?: boolean }): Parsed<CustomAgentPatch> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const external = options?.external === true
  const patch: CustomAgentPatch = {}
  if ('blurb' in input) {
    const blurb = blurbOf(input.blurb)
    if (!blurb.ok) return blurb
    patch.blurb = blurb.value
  }
  if ('brief' in input) {
    const brief = briefOf(input.brief, external)
    if (!brief.ok) return brief
    patch.brief = brief.value
  }
  if ('color' in input) {
    const color = colorOf(input.color)
    if (!color.ok) return color
    patch.color = color.value
  }
  if ('reviewer' in input) patch.reviewer = input.reviewer === true
  if ('avatar' in input) {
    const avatar = avatarOf(input.avatar)
    if (!avatar.ok) return avatar
    patch.avatar = avatar.value
  }
  if (external && 'agentKeyId' in input) {
    const agentKeyId = agentKeyIdOf(input.agentKeyId)
    if (!agentKeyId.ok) return agentKeyId
    patch.agentKeyId = agentKeyId.value
  }
  if (external && 'webhookUrl' in input) {
    const webhookUrl = webhookUrlOf(input.webhookUrl, true)
    if (!webhookUrl.ok) return webhookUrl
    patch.webhookUrl = webhookUrl.value
  }
  if (external && 'webhookSecret' in input) {
    const webhookSecret = webhookSecretOf(input.webhookSecret)
    if (!webhookSecret.ok) return webhookSecret
    if (webhookSecret.value) patch.webhookSecret = webhookSecret.value
  }
  if (external && 'webhookHeaders' in input) {
    const webhookHeaders = parseWebhookHeaders(input.webhookHeaders)
    if (!webhookHeaders.ok) return webhookHeaders
    patch.webhookHeaders = webhookHeaders.value
  }
  if (external && 'webhookPayloadFormat' in input) {
    const webhookPayloadFormat = webhookPayloadFormatOf(input.webhookPayloadFormat)
    if (!webhookPayloadFormat.ok) return webhookPayloadFormat
    patch.webhookPayloadFormat = webhookPayloadFormat.value
  }
  return { ok: true, value: patch }
}
