import { createHmac, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { z } from 'zod'
import { DEFAULT_ROLE_ID, roleById } from '../../shared/agents.ts'
import * as actions from '../actions.ts'
import { isBanned } from '../auth.ts'
import { rosterFor } from '../customAgents.ts'
import { canvasLink } from '../links.ts'
import { store } from '../store.ts'
import { isWorkspaceMember } from '../workspaces.ts'
import { addWorkItemComment, addWorkItemResourceLink, getWorkItem } from './client.ts'
import { getConnection, getWebhookReceiverById, isStandardWebhookSecret } from './connection.ts'

/**
 * Standard Webhooks signature verifier matching SpecFlow's `webhook-signature.ts`:
 *   signed string = `${webhook-id}.${webhook-timestamp}.${rawBody}`
 *   header `webhook-signature` = space-separated `v1,<base64(hmac-sha256(key, signed))>`
 *   secret = `whsec_<base64>`
 */

const DECIMAL_SECONDS = /^[1-9]\d{0,14}$/
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const TOLERANCE_SECONDS = 300
const HMAC_BYTES = 32

export function verifyStandardWebhook(input: {
  headers: Readonly<Record<string, string | string[] | undefined>>
  rawBody: string
  secret: string
  nowSeconds?: number
}): { ok: true; webhookId: string } | { ok: false; reason: string } {
  if (!isStandardWebhookSecret(input.secret)) return { ok: false, reason: 'invalid-secret' }
  const read = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(input.headers)) {
      if (k.toLowerCase() === name) {
        const val = Array.isArray(v) ? v[0] : v
        if (typeof val === 'string' && val.length > 0) return val
      }
    }
    return undefined
  }
  const id = read('webhook-id')
  const sentAt = read('webhook-timestamp')
  const signatures = read('webhook-signature')
  if (!id || !sentAt || !signatures) return { ok: false, reason: 'missing-header' }
  if (id.includes('.')) return { ok: false, reason: 'invalid-id' }
  if (!DECIMAL_SECONDS.test(sentAt)) return { ok: false, reason: 'invalid-timestamp' }
  const ts = Number(sentAt)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp-out-of-tolerance' }

  const key = Buffer.from(input.secret.slice(6), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${sentAt}.${input.rawBody}`, 'utf8').digest()

  let matched = false
  for (const candidate of signatures.split(' ')) {
    const sep = candidate.indexOf(',')
    if (sep === -1 || candidate.slice(0, sep) !== 'v1') continue
    const encoded = candidate.slice(sep + 1)
    if (!CANONICAL_BASE64.test(encoded)) continue
    const received = Buffer.from(encoded, 'base64')
    if (received.length !== HMAC_BYTES) continue
    if (timingSafeEqual(received, expected)) matched = true
  }
  return matched ? { ok: true, webhookId: id } : { ok: false, reason: 'no-matching-signature' }
}

const eventSchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  data: z
    .object({
      eventId: z.string().optional(),
      workspaceId: z.string().optional(),
      projectId: z.string().optional(),
      workItemId: z.string().optional(),
      workItemSystemId: z.string().optional(),
      workItemKey: z.string().optional(),
      commentId: z.string().optional(),
    })
    .passthrough()
    .optional(),
})

const ACTIONABLE_EVENTS = new Set(['work_item.assigned', 'work_item.mentioned', 'work_item.comment_created'])

const MAX_SEEN_IDS = 5_000
const seenDeliveries = new Set<string>()

function rememberDelivery(key: string): boolean {
  if (seenDeliveries.has(key)) return false
  seenDeliveries.add(key)
  if (seenDeliveries.size > MAX_SEEN_IDS) {
    const oldest = seenDeliveries.values().next().value
    if (oldest) seenDeliveries.delete(oldest)
  }
  return true
}

function extractWorkItemSummary(
  raw: Record<string, unknown>,
  fallbackKey: string,
): {
  key: string
  title: string
  description: string
} {
  const item = raw.workItem && typeof raw.workItem === 'object' ? (raw.workItem as Record<string, unknown>) : raw
  const key =
    (typeof item.key === 'string' && item.key) ||
    (typeof item.identifier === 'string' && item.identifier) ||
    fallbackKey
  const title = (typeof item.title === 'string' && item.title.trim()) || key
  const description = typeof item.description === 'string' ? item.description.trim() : ''
  return { key, title, description }
}

export function specflowWebhookRouter() {
  const router = express.Router()

  router.post('/:hookId', express.raw({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
    try {
      const hook = await getWebhookReceiverById(req.params.hookId)
      if (!hook) return res.status(404).json({ error: 'Unknown SpecFlow webhook receiver.' })
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Raw JSON body required.' })

      const rawBody = req.body.toString('utf8')
      const verified = verifyStandardWebhook({
        headers: req.headers,
        rawBody,
        secret: hook.signingSecret,
      })
      if (!verified.ok) {
        return res.status(401).json({ error: `Invalid SpecFlow webhook signature (${verified.reason}).` })
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(rawBody)
      } catch {
        return res.status(400).json({ error: 'Invalid JSON.' })
      }

      const parsed = eventSchema.safeParse(parsedJson)
      if (!parsed.success) return res.status(400).json({ error: 'Invalid SpecFlow event envelope.' })

      const event = parsed.data
      const dedupKey = `${hook.id}:${event.data?.eventId ?? verified.webhookId}`
      if (!rememberDelivery(dedupKey)) {
        return res.json({ ok: true, duplicate: true })
      }

      if (!ACTIONABLE_EVENTS.has(event.type)) {
        return res.json({ ok: true, ignored: event.type })
      }

      if (await isBanned(hook.userId)) {
        return res.status(403).json({ error: 'The Doop account behind this SpecFlow webhook is disabled.' })
      }

      const projectId = event.data?.projectId
      const workItemId = event.data?.workItemId || event.data?.workItemKey || event.data?.workItemSystemId
      const workItemKey =
        event.data?.workItemKey || event.data?.workItemId || event.data?.workItemSystemId || 'SpecFlow'
      if (!projectId || !workItemId) {
        return res.json({ ok: true, ignored: 'missing projectId or workItemId' })
      }

      /* Acknowledge quickly; pull full Work Item details & dispatch to Doop canvas/agent */
      const conn = await getConnection(hook.userId)
      let summary = { key: workItemKey, title: workItemKey, description: '' }
      if (conn) {
        try {
          const full = await getWorkItem(conn.baseUrl, conn.accessToken, projectId, workItemId)
          summary = extractWorkItemSummary(full, workItemKey)
        } catch (err) {
          console.error('[specflow] failed to fetch work item details:', err)
        }
      }

      const workspaceId =
        hook.workspaceId && isWorkspaceMember(hook.workspaceId, hook.userId) ? hook.workspaceId : undefined

      /* Reuse an existing canvas for this workItemKey if one already exists in the target scope */
      const existingCanvases = store.listCanvases(hook.userId, workspaceId ? [workspaceId] : [])
      const prefix = `${summary.key}:`
      const existingMeta = existingCanvases.find(
        (c) =>
          (workspaceId ? c.workspaceId === workspaceId : !c.workspaceId) &&
          (c.name === summary.key || c.name.startsWith(prefix)),
      )
      const canvas =
        (existingMeta ? store.getCanvas(existingMeta.id) : undefined) ??
        store.createCanvas(`${summary.key}: ${summary.title}`.slice(0, 120), hook.userId, workspaceId)

      const roster = rosterFor(canvas)
      const pickedRole = roleById(hook.targetAgent, roster) ?? roleById(DEFAULT_ROLE_ID, roster)
      const roleId = pickedRole?.id ?? DEFAULT_ROLE_ID

      const specflowUrl = conn
        ? `${conn.baseUrl}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(summary.key)}`
        : undefined
      const briefLines = [
        `[${summary.key}] ${summary.title}`,
        ...(summary.description ? [summary.description.slice(0, 600)] : []),
        ...(specflowUrl ? [`SpecFlow: ${specflowUrl}`] : []),
      ]
      const card = actions.addQueuedCard(canvas.id, briefLines.join('\n'), 'SpecFlow', [roleId], undefined, hook.userId)

      const url = canvasLink(canvas.id)

      /* Write back the Doop canvas link to SpecFlow (best-effort, non-blocking for 200 ACK) */
      if (conn) {
        const note = `Doop design canvas ready and dispatched to @${roleId}: ${url}`
        void Promise.allSettled([
          addWorkItemComment(conn.baseUrl, conn.accessToken, projectId, workItemId, note),
          addWorkItemResourceLink(conn.baseUrl, conn.accessToken, projectId, workItemId, `Doop · ${canvas.name}`, url),
        ]).catch(() => {})
      }

      return res.json({
        ok: true,
        canvasId: canvas.id,
        canvasUrl: url,
        cardId: card?.id ?? null,
        targetAgent: roleId,
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
