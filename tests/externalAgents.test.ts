import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, freePort, startServer, type Server } from './harness.ts'

/**
 * End-to-end tests for External Agents (Webhook Push + MCP Polling Fallback)
 * against the REAL Doop server and a real local HTTP webhook receiver.
 */

interface ReceivedHook {
  event: string
  deliveryId: string
  timestamp: string
  signature: string
  headers: IncomingMessage['headers']
  rawBody: string
  body: Record<string, unknown>
}

// 1×1 transparent PNG for avatar upload testing
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

let server: Server
let owner: Client
let workspaceId: string
let canvasId: string
let frameId: string
let elementId: string
let agentKeyId: string
let agentKeySecret: string
let webhookSecret: string

let hookServer: ReturnType<typeof createServer>
let hookUrl: string
let hookMode: 'ok' | 'fail-twice' | 'fail-always' = 'ok'
let failCounter = 0
const received: ReceivedHook[] = []

function verifySignature(hook: ReceivedHook, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(`${hook.timestamp}.${hook.rawBody}`).digest('hex')}`
  return hook.signature === expected
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 6_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = await fn()
    if (val !== undefined) return val
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error('timed out waiting for condition')
}

async function mcpCall(secret: string, tool: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as {
    result?: { content?: { type: string; text?: string }[]; isError?: boolean }
    error?: { message: string }
  }
  if (json.error) throw new Error(json.error.message)
  const textPart = json.result?.content?.find((c) => c.type === 'text')?.text ?? ''
  return { isError: !!json.result?.isError, raw: textPart, data: textPart ? JSON.parse(textPart) : null }
}

beforeAll(async () => {
  const hookPort = await freePort()
  hookUrl = `http://127.0.0.1:${hookPort}/hook`
  hookServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const entry: ReceivedHook = {
        event: String(req.headers['x-doop-event'] ?? ''),
        deliveryId: String(req.headers['x-doop-delivery'] ?? ''),
        timestamp: String(req.headers['x-doop-timestamp'] ?? ''),
        signature: String(req.headers['x-doop-signature'] ?? ''),
        headers: req.headers,
        rawBody,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      }
      received.push(entry)
      if (hookMode === 'fail-always') {
        res.statusCode = 502
        res.end('bad gateway')
        return
      }
      if (hookMode === 'fail-twice') {
        failCounter++
        if (failCounter <= 2) {
          res.statusCode = 500
          res.end('temporary error')
          return
        }
      }
      res.statusCode = 200
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => hookServer.listen(hookPort, '127.0.0.1', resolve))

  server = await startServer({
    WEBHOOK_ALLOW_PRIVATE_URLS: 'true',
    EXTERNAL_AGENT_RETRY_DELAYS_MS: '25,50,75',
  })

  owner = await new Client(server).signUp('ext-owner@test.dev', 'Rubick')
  workspaceId = ((await (await owner.post('/api/workspaces', { name: 'GoNovus' })).json()) as { id: string }).id

  // Mint an Agent Key to bind to our external agent
  const keyRes = await owner.post('/api/agent-keys', { name: 'Claude Key' })
  expect(keyRes.status).toBe(200)
  const keyJson = (await keyRes.json()) as { id: string; secret: string }
  agentKeyId = keyJson.id
  agentKeySecret = keyJson.secret

  // Create a canvas + frame with a stamped button element
  const canvasRes = await owner.post('/api/canvases', { name: 'External Agent Test', workspaceId })
  expect(canvasRes.status).toBe(200)
  canvasId = ((await canvasRes.json()) as { id: string }).id

  const frameRes = await owner.post(`/api/canvases/${canvasId}/frames`, {
    name: 'Hero Button',
    html: '<!doctype html><html><body><button id="cta" data-doop-id="btncta">Submit</button></body></html>',
    width: 800,
    height: 600,
  })
  expect(frameRes.status).toBe(200)
  frameId = ((await frameRes.json()) as { id: string }).id
  elementId = 'btncta'
}, 70_000)

afterAll(async () => {
  server?.stop()
  await new Promise<void>((resolve) => hookServer?.close(() => resolve()))
})

describe('External Agent registration, discovery, avatar & ping', () => {
  it('registers an external agent, uploads avatar, appears in canvas team & get_canvas, and never leaks secret', async () => {
    const createRes = await owner.post(`/api/agents?workspace=${workspaceId}`, {
      name: 'Claude',
      handle: 'claude',
      color: '#D97706',
      blurb: 'External Claude Code design agent',
      brief: '',
      reviewer: false,
      external: true,
      agentKeyId,
      webhookUrl: hookUrl,
    })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as {
      id: string
      name: string
      external?: boolean
      webhookUrl?: string
      webhookSecret?: string
      hasWebhookSecret?: boolean
      agentKeyId?: string
    }
    expect(created.id).toBe('claude')
    expect(created.name).toBe('Claude')
    expect(created.external).toBe(true)
    expect(created.agentKeyId).toBe(agentKeyId)
    expect(created.webhookUrl).toBe(hookUrl)
    expect(created.hasWebhookSecret).toBe(true)
    expect(created.webhookSecret).toMatch(/^whsec_/)
    webhookSecret = created.webhookSecret!

    // Upload avatar
    const avatarRes = await owner.req(`/api/agents/claude/avatar?workspace=${workspaceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: TINY_PNG,
    })
    expect(avatarRes.status).toBe(200)
    const withAvatar = (await avatarRes.json()) as { avatar?: string }
    expect(withAvatar.avatar).toMatch(/^\/a\/.+\.png$/)

    // List endpoint must NOT leak webhookSecret
    const listRes = await owner.get(`/api/agents?workspace=${workspaceId}`)
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as { id: string; webhookSecret?: string; avatar?: string }[]
    const found = listed.find((a) => a.id === 'claude')
    expect(found).toBeDefined()
    expect(found?.webhookSecret).toBeUndefined()
    expect(found?.avatar).toBe(withAvatar.avatar)

    // Canvas team includes external flag & avatar, strips webhookUrl/agentKeyId/secret
    const canvasRes = await owner.get(`/api/canvases/${canvasId}`)
    expect(canvasRes.status).toBe(200)
    const canvasJson = (await canvasRes.json()) as {
      team: { id: string; external?: boolean; avatar?: string; webhookUrl?: string; agentKeyId?: string }[]
    }
    const teamClaude = canvasJson.team.find((r) => r.id === 'claude')
    expect(teamClaude?.external).toBe(true)
    expect(teamClaude?.avatar).toBe(withAvatar.avatar)
    expect(teamClaude?.webhookUrl).toBeUndefined()
    expect(teamClaude?.agentKeyId).toBeUndefined()

    // MCP get_canvas exposes external: true and avatar
    const mcpCanvas = await mcpCall(agentKeySecret, 'get_canvas', { canvas_id: canvasId })
    const customAgents = (
      mcpCanvas.data as { customAgents?: { mention: string; external?: boolean; avatar?: string }[] }
    ).customAgents
    expect(
      customAgents?.some((a) => a.mention === '@claude' && a.external === true && a.avatar === withAvatar.avatar),
    ).toBe(true)

    // Test ping endpoint sends signed agent.ping
    received.length = 0
    const pingRes = await owner.post(`/api/agents/claude/test?workspace=${workspaceId}`, {})
    expect(pingRes.status).toBe(200)
    const pingJson = (await pingRes.json()) as { ok: boolean; status: number }
    expect(pingJson.ok).toBe(true)
    expect(pingJson.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]!.event).toBe('agent.ping')
    expect(verifySignature(received[0]!, webhookSecret)).toBe(true)
  })
})

describe('External Agent webhook push, claim, reply identity, thread replies, cards & feedback', () => {
  let rootCommentId: string

  it('pushes signed webhook on @claude comment with frame_id & elementId and updates deliveryStatus to delivered', async () => {
    received.length = 0
    hookMode = 'ok'

    const res = await owner.post(`/api/frames/${frameId}/comments`, {
      elementId,
      snippet: '<button id="cta">Submit</button>',
      text: '@claude 把按钮改圆一点',
    })
    expect(res.status).toBe(200)
    const created = (await res.json()) as { id: string; deliveryStatus?: string; targetAgent?: string }
    rootCommentId = created.id
    expect(created.targetAgent).toBe('Claude')

    const hook = await waitFor(() => received.find((r) => r.event === 'agent.comment_mentioned'))
    expect(verifySignature(hook, webhookSecret)).toBe(true)
    expect(hook.deliveryId).toMatch(/^evt_/)
    expect(hook.body.canvas_id).toBe(canvasId)
    expect(hook.body.frame_id).toBe(frameId)
    expect(hook.body.elementId).toBe(elementId)
    expect(hook.body.comment_id).toBe(rootCommentId)
    expect(hook.body.text).toBe('@claude 把按钮改圆一点')
    expect(typeof hook.body.canvas_url).toBe('string')
    expect(typeof hook.body.frame_url).toBe('string')
    expect(typeof hook.body.comment_url).toBe('string')

    // Comment transitions to deliveryStatus === 'delivered'
    const delivered = await waitFor(async () => {
      const r = await mcpCall(agentKeySecret, 'get_comments', { canvas_id: canvasId, frame_id: frameId })
      const comments = r.data as { id: string; deliveryStatus?: string; deliveredAt?: number }[]
      const item = comments.find((c) => c.id === rootCommentId)
      return item?.deliveryStatus === 'delivered' ? item : undefined
    })
    expect(delivered.deliveryStatus).toBe('delivered')
    expect(typeof delivered.deliveredAt).toBe('number')
  })

  it('claims comment and posts reply automatically attributed to bound external agent identity', async () => {
    // Claim without specifying agent_name — resolved from bound API key
    const claimed = await mcpCall(agentKeySecret, 'claim_comment', {
      canvas_id: canvasId,
      comment_id: rootCommentId,
    })
    expect(claimed.isError).toBe(false)
    expect((claimed.data as { claimedBy: string }).claimedBy).toBe('Claude')

    // Reply without specifying agent_name — attributed to Claude!
    received.length = 0
    const replied = await mcpCall(agentKeySecret, 'reply_to_comment', {
      canvas_id: canvasId,
      comment_id: rootCommentId,
      text: '已把按钮圆角改成 12px。',
    })
    expect(replied.isError).toBe(false)
    const replyObj = replied.data as { id: string; from: string; text: string }
    expect(replyObj.from).toBe('Claude')
    expect(replyObj.text).toBe('已把按钮圆角改成 12px。')

    // Self-reply must NOT trigger a webhook back to Claude
    await new Promise((r) => setTimeout(r, 120))
    expect(received).toHaveLength(0)
  })

  it('pushes agent.thread_replied when a human replies in a thread the external agent participated in', async () => {
    received.length = 0
    const res = await owner.post(`/api/comments/${rootCommentId}/replies`, {
      text: '顺便把字号调大一点',
    })
    expect(res.status).toBe(200)

    const hook = await waitFor(() => received.find((r) => r.event === 'agent.thread_replied'))
    expect(verifySignature(hook, webhookSecret)).toBe(true)
    expect(hook.body.thread_id).toBe(rootCommentId)
    expect(hook.body.frame_id).toBe(frameId)
    expect(hook.body.elementId).toBe(elementId)
    expect(hook.body.text).toBe('顺便把字号调大一点')
  })

  it('pushes agent.card_assigned when a board card is queued for the external agent', async () => {
    received.length = 0
    const cardRes = await owner.post(`/api/canvases/${canvasId}/cards`, {
      title: '重绘登录卡片',
      agents: ['claude'],
      scope: { frameId },
    })
    expect(cardRes.status).toBe(200)
    const card = (await cardRes.json()) as { id: string }

    const hook = await waitFor(() => received.find((r) => r.event === 'agent.card_assigned'))
    expect(verifySignature(hook, webhookSecret)).toBe(true)
    expect(hook.body.card_id).toBe(card.id)
    expect(hook.body.text).toBe('重绘登录卡片')
    expect(hook.body.frame_id).toBe(frameId)

    // External agent claims the chat card, then posts its reply & completes it via MCP
    const claimRes = await mcpCall(agentKeySecret, 'claim_card', {
      canvas_id: canvasId,
      card_id: card.id,
    })
    expect(claimRes.isError).toBe(false)
    expect(claimRes.data).toMatchObject({ ok: true, id: card.id, agentName: 'Claude' })

    const completeRes = await mcpCall(agentKeySecret, 'complete_card', {
      canvas_id: canvasId,
      card_id: card.id,
      reply: '已重绘登录卡片并更新对比度。',
    })
    expect(completeRes.isError).toBe(false)
    expect(completeRes.data).toMatchObject({ ok: true, id: card.id, agentName: 'Claude' })
    expect((completeRes.data as { endedAt?: number }).endedAt).toBeTypeOf('number')
  })

  it('pushes agent.feedback_received when human leaves feedback on the external agent task', async () => {
    // External agent announces a task via MCP set_status (identity bound to Claude)
    const statusRes = await mcpCall(agentKeySecret, 'set_status', {
      canvas_id: canvasId,
      agent_name: 'ignored-name',
      status: 'Optimizing hero CTA button',
    })
    expect(statusRes.isError).toBe(false)

    // Read the live task id via WS init (just like the browser UI does)
    const tasks = await new Promise<{ id: string; agentName: string; status: string }[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('ws init timed out'))
      }, 5000)
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'test-client', name: 'Rubick', kind: 'user' })),
      )
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as {
          type: string
          tasks?: { id: string; agentName: string; status: string }[]
        }
        if (msg.type === 'init') {
          clearTimeout(timer)
          ws.close()
          resolve(msg.tasks ?? [])
        }
      })
      ws.on('error', reject)
    })
    const claudeTask = tasks.find((t) => t.agentName === 'Claude' && t.status === 'Optimizing hero CTA button')
    expect(claudeTask).toBeDefined()
    const taskId = claudeTask!.id

    received.length = 0
    const fbRes = await owner.post(`/api/tasks/${taskId}/feedback`, {
      text: '对比度再高一点',
    })
    expect(fbRes.status).toBe(200)

    const hook = await waitFor(() => received.find((r) => r.event === 'agent.feedback_received'))
    expect(verifySignature(hook, webhookSecret)).toBe(true)
    expect(hook.body.task_id).toBe(taskId)
    expect(hook.body.text).toBe('对比度再高一点')
  })
})

describe('Retries, idempotency, failure state, polling fallback (list_mentions) & secret rotation', () => {
  it('retries transient 500s with the same X-Doop-Delivery id and succeeds on the 3rd attempt', async () => {
    received.length = 0
    hookMode = 'fail-twice'
    failCounter = 0

    const res = await owner.post(`/api/frames/${frameId}/comments`, {
      elementId,
      snippet: '<button id="cta">Submit</button>',
      text: '@claude 测试瞬时失败重试',
    })
    expect(res.status).toBe(200)
    const created = (await res.json()) as { id: string }

    await waitFor(() => (received.length >= 3 ? true : undefined))
    const deliveryIds = new Set(received.map((r) => r.deliveryId))
    expect(deliveryIds.size).toBe(1)

    const delivered = await waitFor(async () => {
      const r = await mcpCall(agentKeySecret, 'get_comments', { canvas_id: canvasId, frame_id: frameId })
      const comments = r.data as { id: string; deliveryStatus?: string }[]
      const item = comments.find((c) => c.id === created.id)
      return item?.deliveryStatus === 'delivered' ? item : undefined
    })
    expect(delivered.deliveryStatus).toBe('delivered')
  })

  it('marks comment failed when webhook is unreachable and returns unhandled mention via MCP list_mentions', async () => {
    const deadPort = await freePort()
    const patchRes = await owner.patch(`/api/agents/claude?workspace=${workspaceId}`, {
      webhookUrl: `http://127.0.0.1:${deadPort}/unreachable`,
    })
    expect(patchRes.status).toBe(200)

    const res = await owner.post(`/api/frames/${frameId}/comments`, {
      elementId,
      snippet: '<button id="cta">Submit</button>',
      text: '@claude webhook 挂了时的兜底测试',
    })
    expect(res.status).toBe(200)
    const created = (await res.json()) as { id: string }

    // Wait for retries to exhaust and mark comment as failed with failureReason
    const failedComment = await waitFor(async () => {
      const r = await mcpCall(agentKeySecret, 'get_comments', { canvas_id: canvasId, frame_id: frameId })
      const comments = r.data as { id: string; deliveryStatus?: string; failureReason?: string; failedAt?: number }[]
      const item = comments.find((c) => c.id === created.id)
      return item?.deliveryStatus === 'failed' ? item : undefined
    })
    expect(failedComment.failedAt).toBeTruthy()
    expect(failedComment.failureReason).toBeTruthy()

    // Polling fallback: list_mentions returns this unhandled mention with full metadata
    const poll = await mcpCall(agentKeySecret, 'list_mentions', {})
    expect(poll.isError).toBe(false)
    const pollData = poll.data as {
      agent: { handle: string; name: string }
      mentions: {
        comment_id: string
        frame_id: string
        elementId: string
        text: string
        delivery_status: string
        failure_reason: string
      }[]
    }
    expect(pollData.agent.handle).toBe('claude')
    const hit = pollData.mentions.find((m) => m.comment_id === created.id)
    expect(hit).toBeDefined()
    expect(hit?.frame_id).toBe(frameId)
    expect(hit?.elementId).toBe(elementId)
    expect(hit?.delivery_status).toBe('failed')
    expect(hit?.failure_reason).toBeTruthy()

    // Restore working webhook URL, rotate secret, and retry the failed comment!
    expect((await owner.patch(`/api/agents/claude?workspace=${workspaceId}`, { webhookUrl: hookUrl })).status).toBe(200)
    const rotRes = await owner.post(`/api/agents/claude/rotate-secret?workspace=${workspaceId}`, {})
    expect(rotRes.status).toBe(200)
    const newSecret = ((await rotRes.json()) as { webhookSecret: string }).webhookSecret
    expect(newSecret).toMatch(/^whsec_/)
    expect(newSecret).not.toBe(webhookSecret)

    received.length = 0
    hookMode = 'ok'
    const retryRes = await owner.post(`/api/comments/${created.id}/retry`, {})
    expect(retryRes.status).toBe(200)

    const retriedHook = await waitFor(() => received.find((r) => r.body.comment_id === created.id))
    expect(verifySignature(retriedHook, newSecret)).toBe(true)
    expect(verifySignature(retriedHook, webhookSecret)).toBe(false)

    const recovered = await waitFor(async () => {
      const r = await mcpCall(agentKeySecret, 'get_comments', { canvas_id: canvasId, frame_id: frameId })
      const comments = r.data as { id: string; deliveryStatus?: string }[]
      const item = comments.find((c) => c.id === created.id)
      return item?.deliveryStatus === 'delivered' ? item : undefined
    })
    expect(recovered.deliveryStatus).toBe('delivered')
  })

  it('supports custom encrypted HTTP headers and {"text": "..."} payload format for Claude Code Routines', async () => {
    const patchRes = await owner.patch(`/api/agents/claude?workspace=${workspaceId}`, {
      webhookUrl: hookUrl,
      webhookPayloadFormat: 'text',
      webhookHeaders: {
        Authorization: 'Bearer test-routine-secret-token',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as {
      webhookPayloadFormat?: string
      webhookHeaderNames?: string[]
      webhookHeaders?: unknown
    }
    expect(patched.webhookPayloadFormat).toBe('text')
    expect(patched.webhookHeaderNames).toEqual(['Authorization', 'anthropic-beta', 'anthropic-version', 'Content-Type'])
    // Header values must never be leaked back in API responses
    expect(patched.webhookHeaders).toBeUndefined()

    received.length = 0
    hookMode = 'ok'
    const res = await owner.post(`/api/frames/${frameId}/comments`, {
      elementId,
      snippet: '<button id="cta">Submit</button>',
      text: '@claude 测试 Claude Routine 文本格式推送',
    })
    expect(res.status).toBe(200)
    const created = (await res.json()) as { id: string }

    const hook = await waitFor(() => received.find((r) => r.event === 'agent.comment_mentioned'))
    expect(hook.headers.authorization).toBe('Bearer test-routine-secret-token')
    expect(hook.headers['anthropic-beta']).toBe('experimental-cc-routine-2026-04-01')
    expect(hook.headers['anthropic-version']).toBe('2023-06-01')
    expect(hook.headers['content-type']).toBe('application/json')
    expect(Object.keys(hook.body)).toEqual(['text'])
    const promptText = String(hook.body.text)
    expect(promptText).toContain('@claude 测试 Claude Routine 文本格式推送')
    expect(promptText).toContain(frameId)
    expect(promptText).toContain(elementId)
    expect(promptText).toContain(created.id)
  })
})
