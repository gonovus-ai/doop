import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, freePort, startServer, type Server } from './harness.ts'

/**
 * End-to-end tests for the native Doop ↔ SpecFlow integration (Phase 1 + Phase 2):
 * - Connect SpecFlow with User API Key (x-api-key) + verify /v1/identity & /v1/projects
 * - MCP tools: list_specflow_projects, list_specflow_work_items, get_specflow_work_item,
 *   search_specflow_specs, get_specflow_spec (+ glossary), list_specflow_screens, comment_specflow_work_item
 * - Automation `specflow` action step creating a SpecFlow Work Item with Doop canvas resourceLink
 * - Phase 2 inbound Standard Webhooks (`/webhooks/specflow/:id`): signature verification,
 *   replay/duplicate protection, auto-canvas creation in target workspace, dispatch to external `@claude`,
 *   and write-back comment + resourceLink to SpecFlow
 */

let server: Server
let owner: Client
let workspaceId: string
let agentKeySecret: string
let mockSpecFlowServer: ReturnType<typeof createServer>
let mockSpecFlowUrl: string
let mockClaudeServer: ReturnType<typeof createServer>
let mockClaudeUrl: string

const specflowRequests: { method: string; url: string; apiKey: string; body: unknown }[] = []
const claudeHooks: { event: string; body: Record<string, unknown> }[] = []

const SPECFLOW_API_KEY = 'sf_user_test_key_1234567890abcdef'
const SPECFLOW_WHSEC = `whsec_${randomBytes(32).toString('base64')}`

function signStandardWebhook(secret: string, id: string, timestamp: number, body: string) {
  const key = Buffer.from(secret.slice(6), 'base64')
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${sig}`,
  }
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
  const sfPort = await freePort()
  mockSpecFlowUrl = `http://127.0.0.1:${sfPort}`
  mockSpecFlowServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const apiKey = String(req.headers['x-api-key'] ?? '')
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = undefined
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      specflowRequests.push({ method: req.method ?? 'GET', url: req.url ?? '', apiKey, body })

      if (apiKey !== SPECFLOW_API_KEY) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ code: 'API_KEY_INVALID', message: 'Invalid API key' }))
        return
      }

      const url = new URL(req.url ?? '/', mockSpecFlowUrl)
      res.setHeader('Content-Type', 'application/json')

      if (req.method === 'GET' && url.pathname === '/v1/identity') {
        res.end(JSON.stringify({ user: { id: 'sf-user-1' } }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects') {
        const statusParam = url.searchParams.get('status')
        if (statusParam && !['Active', 'Archived', 'Trashed'].includes(statusParam)) {
          res.statusCode = 400
          res.end(JSON.stringify({ code: 'INVALID_REQUEST', message: 'The request does not match the API contract' }))
          return
        }
        res.end(
          JSON.stringify({
            projects: [
              {
                id: 'proj-spf',
                name: 'SpecFlow Core',
                workspaceId: 'sf-ws-1',
                key: 'SPF',
                archivedAt: null,
                trashedAt: null,
              },
            ],
          }),
        )
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects/proj-spf/work-items') {
        res.end(
          JSON.stringify({
            workItems: [{ id: 'wi-70', key: 'SPF-70', title: '原生人机协作讨论工作台', status: 'in_progress' }],
          }),
        )
        return
      }
      if (
        req.method === 'GET' &&
        (url.pathname === '/v1/projects/proj-spf/work-items/wi-70' ||
          url.pathname === '/v1/projects/proj-spf/work-items/SPF-70')
      ) {
        res.end(
          JSON.stringify({
            workItem: {
              id: 'wi-70',
              key: 'SPF-70',
              title: '原生人机协作讨论工作台',
              description: '支持在 Spec 旁展开人机协同讨论流并回写结论。',
            },
          }),
        )
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/projects/proj-spf/work-items') {
        if (!req.headers['idempotency-key']) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Missing idempotency-key' }))
          return
        }
        const b = (body ?? {}) as { title?: string }
        res.statusCode = 201
        res.end(JSON.stringify({ workItem: { id: 'wi-99', key: 'SPF-99', title: b.title ?? 'Untitled' } }))
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/comments')) {
        const ik = String(req.headers['idempotency-key'] ?? '')
        if (!/^[0-9a-f-]{36}$/i.test(ik)) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'UUID idempotency-key required' }))
          return
        }
        res.statusCode = 201
        res.end(JSON.stringify({ comment: { id: 'cmt-1' } }))
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/resource-links')) {
        if (!req.headers['idempotency-key']) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Missing idempotency-key' }))
          return
        }
        res.statusCode = 201
        res.end(JSON.stringify({ link: { id: 'lnk-1' } }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/workspaces/sf-ws-1/spec-search') {
        res.end(JSON.stringify({ items: [{ specId: 'SPF-S12', title: 'Discussion Workbench' }] }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/workspaces/sf-ws-1/specs/SPF-S12') {
        res.end(JSON.stringify({ spec: { id: 'SPF-S12', title: 'Discussion Workbench', state: 'ready' } }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/workspaces/sf-ws-1/specs/SPF-S12/current-revision') {
        res.end(JSON.stringify({ revision: { id: 'rev-1', content: 'Feature: Discussion Workbench' } }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/workspaces/sf-ws-1/glossary') {
        res.end(
          JSON.stringify({
            currentRevision: {
              id: 'g-1',
              entries: [
                { id: 'e-1', canonicalTerm: 'Work Item', definition: 'Trackable unit of work', usageNote: null },
              ],
            },
          }),
        )
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/workspaces/sf-ws-1/screens') {
        res.end(
          JSON.stringify({ screens: [{ id: 'scr-1', name: 'Discussion Panel', description: null, image: null }] }),
        )
        return
      }

      res.statusCode = 404
      res.end(JSON.stringify({ error: `Unhandled mock route: ${req.method} ${url.pathname}` }))
    })
  })
  await new Promise<void>((resolve) => mockSpecFlowServer.listen(sfPort, '127.0.0.1', resolve))

  const claudePort = await freePort()
  mockClaudeUrl = `http://127.0.0.1:${claudePort}/fire`
  mockClaudeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      claudeHooks.push({
        event: String(req.headers['x-doop-event'] ?? ''),
        body: JSON.parse(raw) as Record<string, unknown>,
      })
      res.statusCode = 200
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => mockClaudeServer.listen(claudePort, '127.0.0.1', resolve))

  server = await startServer({
    WEBHOOK_ALLOW_PRIVATE_URLS: 'true',
    EXTERNAL_AGENT_RETRY_DELAYS_MS: '20',
  })

  owner = await new Client(server).signUp('sf-owner@test.dev', 'Rubick')
  workspaceId = ((await (await owner.post('/api/workspaces', { name: 'SpecFlow' })).json()) as { id: string }).id

  // Mint MCP key and register external @claude in the SpecFlow Doop workspace
  const keyRes = await owner.post('/api/agent-keys', { name: 'Claude Key' })
  const keyJson = (await keyRes.json()) as { id: string; secret: string }
  agentKeySecret = keyJson.secret

  const agentRes = await owner.post(`/api/agents?workspace=${workspaceId}`, {
    name: 'Claude',
    handle: 'claude',
    color: '#D97706',
    blurb: 'External Claude agent',
    brief: '',
    reviewer: false,
    external: true,
    agentKeyId: keyJson.id,
    webhookUrl: mockClaudeUrl,
    webhookPayloadFormat: 'text',
  })
  expect(agentRes.status).toBe(200)
}, 70_000)

afterAll(async () => {
  server?.stop()
  await new Promise<void>((resolve) => mockSpecFlowServer?.close(() => resolve()))
  await new Promise<void>((resolve) => mockClaudeServer?.close(() => resolve()))
})

describe('SpecFlow Integration Phase 1: API connection, MCP tools & Automations', () => {
  it('connects SpecFlow with User API key, rejects bad key, and exposes status without leaking token', async () => {
    const bad = await owner.post('/api/integrations/specflow/token', {
      token: 'sf_wrong_key_1234567890',
      baseUrl: mockSpecFlowUrl,
    })
    expect(bad.status).toBe(401)

    const ok = await owner.post('/api/integrations/specflow/token', {
      token: SPECFLOW_API_KEY,
      baseUrl: mockSpecFlowUrl,
    })
    expect(ok.status).toBe(200)
    const status = (await ok.json()) as {
      specflow: { connected: boolean; baseUrl: string; projectCount: number; accessToken?: string }
    }
    expect(status.specflow.connected).toBe(true)
    expect(status.specflow.baseUrl).toBe(mockSpecFlowUrl)
    expect(status.specflow.projectCount).toBe(1)
    expect(status.specflow.accessToken).toBeUndefined()
  })

  it('exposes SpecFlow MCP tools to read projects, work items, specs, glossary, screens and post comments', async () => {
    const projects = await mcpCall(agentKeySecret, 'list_specflow_projects', {})
    expect(projects.isError).toBe(false)
    expect((projects.data as { id: string; workspaceId: string }[])[0]).toMatchObject({
      id: 'proj-spf',
      workspaceId: 'sf-ws-1',
    })

    const wis = await mcpCall(agentKeySecret, 'list_specflow_work_items', { project_id: 'proj-spf' })
    expect(wis.isError).toBe(false)
    expect(JSON.stringify(wis.data)).toContain('SPF-70')

    const wi = await mcpCall(agentKeySecret, 'get_specflow_work_item', {
      project_id: 'proj-spf',
      work_item_id: 'wi-70',
    })
    expect(wi.isError).toBe(false)
    expect(JSON.stringify(wi.data)).toContain('原生人机协作讨论工作台')

    const search = await mcpCall(agentKeySecret, 'search_specflow_specs', {
      workspace_id: 'sf-ws-1',
      query: 'Discussion',
    })
    expect(search.isError).toBe(false)
    expect(JSON.stringify(search.data)).toContain('SPF-S12')

    const spec = await mcpCall(agentKeySecret, 'get_specflow_spec', {
      workspace_id: 'sf-ws-1',
      spec_id: 'SPF-S12',
      include_glossary: true,
    })
    expect(spec.isError).toBe(false)
    expect(JSON.stringify(spec.data)).toContain('Feature: Discussion Workbench')
    expect(JSON.stringify(spec.data)).toContain('Work Item')

    const screens = await mcpCall(agentKeySecret, 'list_specflow_screens', { workspace_id: 'sf-ws-1' })
    expect(screens.isError).toBe(false)
    expect(JSON.stringify(screens.data)).toContain('Discussion Panel')

    specflowRequests.length = 0
    const comment = await mcpCall(agentKeySecret, 'comment_specflow_work_item', {
      project_id: 'proj-spf',
      work_item_id: 'wi-70',
      content: 'Design draft ready on Doop',
      link_title: 'Doop Canvas',
      link_url: 'https://design.tools.gonovus.ai/c/abc',
    })
    expect(comment.isError).toBe(false)
    expect(specflowRequests.some((r) => r.method === 'POST' && r.url.endsWith('/wi-70/comments'))).toBe(true)
    expect(specflowRequests.some((r) => r.method === 'POST' && r.url.endsWith('/wi-70/resource-links'))).toBe(true)
  })

  it('lists projects & screens for automation editor and executes a specflow automation step', async () => {
    const projRes = await owner.get('/api/integrations/specflow/projects')
    expect(projRes.status).toBe(200)
    expect(((await projRes.json()) as { id: string }[])[0]?.id).toBe('proj-spf')

    const scrRes = await owner.get('/api/integrations/specflow/screens?workspaceId=sf-ws-1')
    expect(scrRes.status).toBe(200)
    expect(((await scrRes.json()) as { id: string }[])[0]?.id).toBe('scr-1')

    const canvasId = (
      (await (await owner.post('/api/canvases', { name: 'Approved Flow', workspaceId })).json()) as { id: string }
    ).id
    const autoRes = await owner.post('/api/automations', {
      name: 'Hand off to SpecFlow',
      enabled: true,
      trigger: { type: 'schedule' },
      schedule: { kind: 'daily', weekday: 1, hour: 9, minute: 0, tz: 'UTC' },
      steps: [
        {
          id: 'step-1',
          type: 'specflow',
          canvasId,
          projectId: 'proj-spf',
          title: 'Implement approved design',
          description: 'See Doop link below',
        },
      ],
    })
    expect(autoRes.status).toBe(200)
    const auto = (await autoRes.json()) as { id: string }

    specflowRequests.length = 0
    const runRes = await owner.post(`/api/automations/${auto.id}/run`, {})
    expect(runRes.status).toBe(200)

    const createdReq = await waitFor(() =>
      specflowRequests.find((r) => r.method === 'POST' && r.url === '/v1/projects/proj-spf/work-items'),
    )
    const body = createdReq.body as { title: string; resourceLinks?: { url: string }[] }
    expect(body.title).toBe('Implement approved design')
    expect(body.resourceLinks?.[0]?.url).toContain(`/c/${canvasId}`)
  })
})

describe('SpecFlow Integration Phase 2: Inbound Standard Webhooks delegation → @claude', () => {
  it('verifies Standard Webhooks signature, creates canvas, dispatches to external @claude, deduplicates, and writes back to SpecFlow', async () => {
    const hookSetup = await owner.put('/api/integrations/specflow/webhook', {
      signingSecret: SPECFLOW_WHSEC,
      workspaceId,
      targetAgent: 'claude',
    })
    expect(hookSetup.status).toBe(200)
    const statusJson = (await hookSetup.json()) as {
      specflow: { webhook: { configured: boolean; id: string; endpointUrl: string; targetAgent: string } }
    }
    const hookId = statusJson.specflow.webhook.id
    expect(statusJson.specflow.webhook.configured).toBe(true)
    expect(statusJson.specflow.webhook.targetAgent).toBe('claude')

    const payload = JSON.stringify({
      type: 'work_item.assigned',
      timestamp: new Date().toISOString(),
      data: {
        eventId: 'evt-sf-70',
        workspaceId: 'sf-ws-1',
        projectId: 'proj-spf',
        workItemSystemId: 'wi-70',
        workItemKey: 'SPF-70',
        workItemVersion: 3,
      },
    })

    // Invalid signature is rejected with 401
    const badRes = await fetch(`${server.base}/webhooks/specflow/${hookId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': 'msg_bad',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
      body: payload,
    })
    expect(badRes.status).toBe(401)

    // Valid Standard Webhooks signature triggers canvas creation, @claude push, and SpecFlow comment/link write-back
    claudeHooks.length = 0
    specflowRequests.length = 0
    const ts = Math.floor(Date.now() / 1000)
    const sigHeaders = signStandardWebhook(SPECFLOW_WHSEC, 'msg_sf_70', ts, payload)
    const goodRes = await fetch(`${server.base}/webhooks/specflow/${hookId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sigHeaders },
      body: payload,
    })
    expect(goodRes.status).toBe(200)
    const goodJson = (await goodRes.json()) as { ok: boolean; canvasId: string; cardId: string; targetAgent: string }
    expect(goodJson.ok).toBe(true)
    expect(goodJson.canvasId).toBeTruthy()
    expect(goodJson.cardId).toBeTruthy()
    expect(goodJson.targetAgent).toBe('claude')

    // External @claude received the text-wrapped card assignment webhook!
    const pushed = await waitFor(() => claudeHooks.find((h) => h.event === 'agent.card_assigned'))
    expect(String(pushed.body.text)).toContain('SPF-70')
    expect(String(pushed.body.text)).toContain('原生人机协作讨论工作台')

    // SpecFlow received write-back comment + resource link pointing to the new Doop canvas!
    await waitFor(() =>
      specflowRequests.find((r) => r.method === 'POST' && r.url.endsWith('/SPF-70/comments')) &&
      specflowRequests.find((r) => r.method === 'POST' && r.url.endsWith('/SPF-70/resource-links'))
        ? true
        : undefined,
    )

    // Duplicate delivery with same eventId is idempotently ignored
    const dupRes = await fetch(`${server.base}/webhooks/specflow/${hookId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sigHeaders },
      body: payload,
    })
    expect(dupRes.status).toBe(200)
    expect(((await dupRes.json()) as { duplicate?: boolean }).duplicate).toBe(true)
  })
})
