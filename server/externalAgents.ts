import { nanoid } from 'nanoid'
import { env } from './env.ts'
import { store } from './store.ts'
import { canvasLink, commentLink, frameLink } from './links.ts'
import { sign, targetProblem, TIMEOUT_MS } from './webhooks.ts'
import type { ExternalAgentRecord } from './customAgents.ts'
import type { ActorKind, AgentTask, Canvas, ElementComment, Frame, TaskFeedback } from '../shared/types.ts'
import type { WebhookDeliveryResult } from '../shared/webhooks.ts'

/**
 * Outbound webhook push engine for registered External Agents.
 *
 * When a human (or another agent) @mentions an external agent in a comment,
 * replies in a thread it participates in, assigns a board card / advances a
 * pipeline stage to it, or leaves feedback on one of its tasks, Doop POSTs a
 * signed JSON event to the agent's webhook URL with exponential-backoff
 * retries and a stable idempotent `X-Doop-Delivery` event id.
 *
 * For comment triggers, delivery state is written back onto the comment
 * (`deliveryStatus: 'pending' | 'delivered' | 'failed'`) and broadcast live
 * so viewers see "Delivered", "Claimed", or "Failed (reason)" + Retry.
 */

export type ExternalAgentEventType =
  'agent.comment_mentioned' | 'agent.thread_replied' | 'agent.card_assigned' | 'agent.feedback_received' | 'agent.ping'

const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000]
let retryDelaysOverride: number[] | null = null
const USER_AGENT = 'doop-external-agent/1'

export function setExternalAgentRetryDelaysForTest(delays: number[] | null) {
  retryDelaysOverride = delays
}

function retryDelays(): number[] {
  if (retryDelaysOverride) return retryDelaysOverride
  const raw = env.EXTERNAL_AGENT_RETRY_DELAYS_MS
  if (!raw) return DEFAULT_RETRY_DELAYS_MS
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_MS
}

export interface ExternalAgentPayload {
  id: string
  type: ExternalAgentEventType
  at: number
  agent: { handle: string; name: string }
  canvas_id?: string
  canvas_name?: string
  canvas_url?: string
  frame_id?: string | null
  frame_name?: string | null
  frame_url?: string | null
  page_id?: string | null
  comment_id?: string
  thread_id?: string
  elementId?: string | null
  snippet?: string
  text?: string
  author?: { name: string; kind: ActorKind }
  comment_url?: string
  card_id?: string
  pipeline?: string[]
  stage?: number
  scope?: AgentTask['scope'] | null
  task_id?: string
  feedback_id?: string
}

function commentPayload(
  agent: ExternalAgentRecord,
  canvas: Pick<Canvas, 'id' | 'name'>,
  comment: ElementComment,
  type: 'agent.comment_mentioned' | 'agent.thread_replied',
  frame?: Frame,
  actorKind: ActorKind = 'user',
): ExternalAgentPayload {
  const threadId = comment.parentId ?? comment.id
  return {
    id: `evt_${nanoid(12)}`,
    type,
    at: comment.at,
    agent: { handle: agent.handle, name: agent.name },
    canvas_id: canvas.id,
    canvas_name: canvas.name,
    canvas_url: canvasLink(canvas.id),
    frame_id: comment.frameId ?? null,
    frame_name: frame?.name ?? null,
    frame_url: comment.frameId ? frameLink(canvas.id, comment.frameId) : null,
    page_id: comment.pageId ?? frame?.pageId ?? null,
    comment_id: comment.id,
    thread_id: threadId,
    elementId: comment.elementId ?? null,
    snippet: comment.snippet,
    text: comment.text,
    author: { name: comment.from, kind: actorKind },
    comment_url: commentLink(comment),
  }
}

function cardPayload(
  agent: ExternalAgentRecord,
  canvas: Pick<Canvas, 'id' | 'name'>,
  card: AgentTask,
): ExternalAgentPayload {
  const frameId = card.scope?.frameId ?? null
  const frame = frameId ? store.getFrame(frameId) : undefined
  return {
    id: `evt_${nanoid(12)}`,
    type: 'agent.card_assigned',
    at: Date.now(),
    agent: { handle: agent.handle, name: agent.name },
    canvas_id: canvas.id,
    canvas_name: canvas.name,
    canvas_url: canvasLink(canvas.id),
    frame_id: frameId,
    frame_name: frame?.name ?? null,
    frame_url: frameId ? frameLink(canvas.id, frameId) : null,
    page_id: frame?.pageId ?? null,
    card_id: card.id,
    text: card.status,
    author: { name: card.queuedBy ?? 'User', kind: 'user' },
    pipeline: card.pipeline ?? [],
    stage: card.stage ?? 0,
    scope: card.scope ?? null,
  }
}

function feedbackPayload(
  agent: ExternalAgentRecord,
  canvas: Pick<Canvas, 'id' | 'name'>,
  task: AgentTask,
  feedback: TaskFeedback,
): ExternalAgentPayload {
  const frameId = task.frameIds?.[task.frameIds.length - 1] ?? task.scope?.frameId ?? null
  const frame = frameId ? store.getFrame(frameId) : undefined
  return {
    id: `evt_${nanoid(12)}`,
    type: 'agent.feedback_received',
    at: feedback.at,
    agent: { handle: agent.handle, name: agent.name },
    canvas_id: canvas.id,
    canvas_name: canvas.name,
    canvas_url: canvasLink(canvas.id),
    frame_id: frameId,
    frame_name: frame?.name ?? null,
    frame_url: frameId ? frameLink(canvas.id, frameId) : null,
    page_id: frame?.pageId ?? null,
    task_id: task.id,
    feedback_id: feedback.id,
    text: feedback.text,
    author: { name: feedback.from, kind: 'user' },
  }
}

function shouldRetry(result: WebhookDeliveryResult): boolean {
  if (result.ok) return false
  if (result.status === null) return true
  return result.status >= 500 || result.status === 408 || result.status === 429
}

function formatTextPayload(payload: ExternalAgentPayload): string {
  if (payload.type === 'agent.ping') {
    return payload.text ?? `Ping from Doop to @${payload.agent.handle}`
  }
  const lines: string[] = [
    `[Doop ${payload.type}] @${payload.agent.handle} (${payload.agent.name})`,
    ...(payload.author ? [`From: ${payload.author.name}`] : []),
    ...(payload.canvas_id
      ? [
          `Canvas: ${payload.canvas_name ?? payload.canvas_id} (${payload.canvas_id}) ${payload.canvas_url ?? ''}`.trim(),
        ]
      : []),
    ...(payload.frame_id
      ? [`Frame: ${payload.frame_name ?? payload.frame_id} (${payload.frame_id}) ${payload.frame_url ?? ''}`.trim()]
      : []),
    ...(payload.comment_id
      ? [
          `Comment: ${payload.comment_id} (thread: ${payload.thread_id ?? payload.comment_id}) ${payload.comment_url ?? ''}`.trim(),
        ]
      : []),
    ...(payload.elementId ? [`Element: data-doop-id="${payload.elementId}"`] : []),
    ...(payload.card_id
      ? [
          `Card: ${payload.card_id} (stage ${(payload.stage ?? 0) + 1}/${payload.pipeline?.length ?? 1})`,
          'Workflow: call claim_card(canvas_id, card_id) first, perform the canvas work, then call complete_card(canvas_id, card_id, reply) to reply in the canvas chat.',
        ]
      : []),
    ...(payload.task_id
      ? [`Task: ${payload.task_id}${payload.feedback_id ? ` (feedback: ${payload.feedback_id})` : ''}`]
      : []),
    ...(payload.text ? ['', `Request:\n${payload.text}`] : []),
    ...(payload.snippet ? ['', `Element HTML snippet:\n${payload.snippet}`] : []),
    '',
    'Event JSON:',
    JSON.stringify(payload),
  ]
  return lines.join('\n')
}

function mergeHeaders(base: Record<string, string>, custom: Record<string, string> | null): Record<string, string> {
  if (!custom) return base
  const out: Record<string, string> = { ...base }
  const lowerToKey = new Map<string, string>()
  for (const key of Object.keys(out)) lowerToKey.set(key.toLowerCase(), key)
  for (const [name, value] of Object.entries(custom)) {
    const existing = lowerToKey.get(name.toLowerCase())
    if (existing && existing !== name) delete out[existing]
    out[name] = value
    lowerToKey.set(name.toLowerCase(), name)
  }
  return out
}

async function postOnce(agent: ExternalAgentRecord, payload: ExternalAgentPayload): Promise<WebhookDeliveryResult> {
  if (!agent.webhookUrl) {
    return { ok: false, status: null, error: 'no webhook URL configured' }
  }
  const problem = await targetProblem(agent.webhookUrl)
  if (problem) {
    return { ok: false, status: null, error: problem }
  }
  const body =
    agent.webhookPayloadFormat === 'text'
      ? JSON.stringify({ text: formatTextPayload(payload) })
      : JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-Doop-Event': payload.type,
    'X-Doop-Delivery': payload.id,
    'X-Doop-Timestamp': String(timestamp),
  }
  if (agent.webhookSecret) {
    baseHeaders['X-Doop-Signature'] = sign(agent.webhookSecret, timestamp, body)
  }
  const headers = mergeHeaders(baseHeaders, agent.webhookHeaders)
  try {
    const res = await fetch(agent.webhookUrl, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    void res.body?.cancel()
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status }
    }
    const err = res.status >= 300 && res.status < 400 ? `redirect refused (HTTP ${res.status})` : `HTTP ${res.status}`
    return { ok: false, status: res.status, error: err }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, status: null, error: message || 'request failed' }
  }
}

async function deliverWithRetries(
  agent: ExternalAgentRecord,
  payload: ExternalAgentPayload,
  callbacks?: {
    onDelivered?: () => void
    onFailed?: (reason: string) => void
  },
): Promise<WebhookDeliveryResult> {
  const delays = retryDelays()
  let last: WebhookDeliveryResult = { ok: false, status: null, error: 'delivery failed' }
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      const wait = delays[attempt - 1] ?? 0
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, wait).unref()
        })
      }
    }
    last = await postOnce(agent, payload)
    if (last.ok) {
      callbacks?.onDelivered?.()
      return last
    }
    if (!shouldRetry(last)) break
  }
  const reason = last.error ?? (last.status ? `HTTP ${last.status}` : 'webhook unreachable')
  callbacks?.onFailed?.(reason)
  return last
}

export function dispatchExternalComment(
  canvasId: string,
  comment: ElementComment,
  type: 'agent.comment_mentioned' | 'agent.thread_replied',
  agent: ExternalAgentRecord,
  options?: {
    frame?: Frame
    actorKind?: ActorKind
    trackStatus?: boolean
    onDelivered?: (commentId: string) => void
    onFailed?: (commentId: string, reason: string) => void
  },
): void {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return
  const payload = commentPayload(agent, canvas, comment, type, options?.frame, options?.actorKind ?? 'user')
  void deliverWithRetries(agent, payload, {
    onDelivered: options?.trackStatus === false ? undefined : () => options?.onDelivered?.(comment.id),
    onFailed: options?.trackStatus === false ? undefined : (reason) => options?.onFailed?.(comment.id, reason),
  }).catch((err) => {
    console.error(`[external-agents] comment delivery failed for @${agent.handle}:`, err)
  })
}

export function dispatchExternalCard(canvasId: string, card: AgentTask, agent: ExternalAgentRecord): void {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return
  const payload = cardPayload(agent, canvas, card)
  void deliverWithRetries(agent, payload).catch((err) => {
    console.error(`[external-agents] card delivery failed for @${agent.handle}:`, err)
  })
}

export function dispatchExternalFeedback(
  canvasId: string,
  task: AgentTask,
  feedback: TaskFeedback,
  agent: ExternalAgentRecord,
): void {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return
  const payload = feedbackPayload(agent, canvas, task, feedback)
  void deliverWithRetries(agent, payload).catch((err) => {
    console.error(`[external-agents] feedback delivery failed for @${agent.handle}:`, err)
  })
}

export async function sendExternalAgentPing(agent: ExternalAgentRecord): Promise<WebhookDeliveryResult> {
  const payload: ExternalAgentPayload = {
    id: `evt_${nanoid(12)}`,
    type: 'agent.ping',
    at: Date.now(),
    agent: { handle: agent.handle, name: agent.name },
    text: `Ping from Doop to @${agent.handle}`,
  }
  return postOnce(agent, payload)
}
