import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { wrapDesignSystemJsxHtml } from '../server/specflowDesignSystem.ts'
import {
  buildDoopDsTag,
  defaultPropsForComponent,
  DS_MAX_FILE_BYTES,
  parseDoopDsProps,
  sanitizeDsFilePath,
  validateDsName,
  validateDsVersion,
} from '../shared/designSystems.ts'
import { buildDoopDsPreviewHtml } from '../shared/doopDsRuntime.ts'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime.ts'

/**
 * End-to-end tests for Doop's Design System Registry against the REAL server:
 * - Workspace-member authorization (non-members & unauthenticated callers rejected)
 * - Ticket-based streaming upload (`PUT /ds-upload/:token/*` + `POST /commit`)
 * - Direct JSON publish via Agent Key (`Authorization: Bearer dpk_...`)
 * - Versioned immutable hosting (`/ds/gonovus/<ver>/*`) + atomic `/latest/*` switch + instant cache eviction
 * - Built-in same-origin React 18 UMD runtime (`/ds/_runtime/react-18/*`)
 * - Rollback + live guide update + non-latest release deletion
 * - Generic JSX compilation (`wrapDesignSystemJsxHtml`) for GoNovus (React 18 UMD) and SpecFlow (React 19)
 */

let server: Server
let owner: Client
let mate: Client
let stranger: Client
let workspaceId: string
let ownerAgentKey: string

const TOKENS_V1 = ':root { --gn-accent: #16a34a; --bg-surface-base: #ffffff; }\n'
const TOKENS_V2 = ':root { --gn-accent: #2563eb; --bg-surface-base: #fafafa; }\n'
const BUNDLE_CSS_V1 = '.gn-btn { background: var(--gn-accent); color: #fff; padding: 8px 14px; }\n'
const BUNDLE_JS_V1 =
  'window.GoNovusA = { version: "0.1.0", Button: function(p){ return window.React.createElement("button", p); } };\n'
const BUNDLE_JS_V2 =
  'window.GoNovusA = { version: "0.2.0", Button: function(p){ return window.React.createElement("button", p); } };\n'

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('ds-owner@test.dev', 'DS Owner')
  mate = await new Client(server).signUp('ds-mate@test.dev', 'DS Mate')
  stranger = await new Client(server).signUp('ds-stranger@test.dev', 'DS Stranger')
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'GoNovus Design' })).json()).id
  expect((await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'ds-mate@test.dev' })).status).toBe(200)
  const keyRes = await owner.post('/api/agent-keys', { name: 'CI Publisher' })
  expect(keyRes.status).toBe(200)
  ownerAgentKey = ((await keyRes.json()) as { secret: string }).secret
}, 70_000)

afterAll(() => server?.stop())

describe('shared validation helpers', () => {
  it('validates names, versions, and file paths strictly', () => {
    expect(validateDsName('gonovus')).toBe('gonovus')
    expect(validateDsName('latest')).toBeNull()
    expect(validateDsName('_runtime')).toBeNull()
    expect(validateDsName('../evil')).toBeNull()

    expect(validateDsVersion('0.1.0')).toBe('0.1.0')
    expect(validateDsVersion('latest')).toBeNull()
    expect(validateDsVersion('1.0/../../etc')).toBeNull()

    expect(sanitizeDsFilePath('tokens.css')).toBe('tokens.css')
    expect(sanitizeDsFilePath('components/bundle.js')).toBe('components/bundle.js')
    expect(sanitizeDsFilePath('fonts/inter.woff2')).toBe('fonts/inter.woff2')
    expect(sanitizeDsFilePath('../secret.js')).toBeNull()
    expect(sanitizeDsFilePath('evil.html')).toBeNull()
    expect(sanitizeDsFilePath('run.sh')).toBeNull()
  })
})

describe('built-in same-origin React 18 UMD runtime', () => {
  it('serves react & react-dom production UMD with immutable caching and CORS', async () => {
    for (const file of ['react-18/react.production.min.js', 'react-18/react-dom.production.min.js']) {
      const res = await fetch(`${server.base}/ds/_runtime/${file}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
      expect(res.headers.get('cache-control')).toContain('immutable')
      const body = await res.text()
      expect(body.length).toBeGreaterThan(5000)
    }
  })
})

describe('workspace authorization & ticket publishing lifecycle', () => {
  it('rejects unauthenticated and non-workspace callers', async () => {
    const anon = await fetch(`${server.base}/api/design-systems/gonovus/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '0.1.0', workspaceId }),
    })
    expect(anon.status).toBe(401)

    const nonMember = await stranger.post('/api/design-systems/gonovus/tickets', {
      version: '0.1.0',
      workspaceId,
      files: ['tokens.css'],
    })
    expect(nonMember.status).toBe(403)
  })

  it('publishes v0.1.0 via staged ticket upload, serves correct Content-Type, and supports >=2MB files', async () => {
    const ticketRes = await mate.post('/api/design-systems/gonovus/tickets', {
      version: '0.1.0',
      workspaceId,
      files: ['tokens.css', 'components/bundle.css', 'components/bundle.js'],
      manifest: {
        displayName: 'GoNovus Design System',
        runtime: { preset: 'react-18-umd', globalName: 'GoNovusA' },
        docs: { guideMarkdown: '# GoNovus Live Guide\nUse `window.GoNovusA.Button`.' },
      },
      notes: 'Initial GoNovus release',
    })
    expect(ticketRes.status).toBe(200)
    const ticket = (await ticketRes.json()) as {
      token: string
      uploadBaseUrl: string
      commitUrl: string
      shellCommand: string
    }
    expect(ticket.shellCommand).toContain('curl -fsS -T')

    // Commit before uploading declared files must fail
    const prematureCommit = await fetch(ticket.commitUrl, { method: 'POST' })
    expect(prematureCommit.status).toBe(400)

    // Oversized file (> 5 MB) must be rejected with 413
    const tooBig = Buffer.alloc(DS_MAX_FILE_BYTES + 1024, 'a')
    const bigRes = await fetch(`${ticket.uploadBaseUrl}/components/bundle.js`, {
      method: 'PUT',
      body: tooBig,
    })
    expect(bigRes.status).toBe(413)

    // Upload a real 2.2 MB JS payload (> 2 MB minimum requirement) + CSS files
    const largeBundleJs = `${BUNDLE_JS_V1}/* ${'x'.repeat(2_200_000)} */\n`
    const put1 = await fetch(`${ticket.uploadBaseUrl}/tokens.css`, { method: 'PUT', body: TOKENS_V1 })
    expect(put1.status).toBe(200)
    const put2 = await fetch(`${ticket.uploadBaseUrl}/components/bundle.css`, { method: 'PUT', body: BUNDLE_CSS_V1 })
    expect(put2.status).toBe(200)
    const put3 = await fetch(`${ticket.uploadBaseUrl}/components/bundle.js`, { method: 'PUT', body: largeBundleJs })
    expect(put3.status).toBe(200)

    const commitRes = await fetch(ticket.commitUrl, { method: 'POST' })
    expect(commitRes.status).toBe(200)
    const committed = (await commitRes.json()) as {
      ok: boolean
      latestUrls: Record<string, string>
      versionedUrls: Record<string, string>
    }
    expect(committed.ok).toBe(true)
    expect(committed.latestUrls['components/bundle.js']).toBe(`${server.base}/ds/gonovus/latest/components/bundle.js`)
    expect(committed.versionedUrls['tokens.css']).toBe(`${server.base}/ds/gonovus/0.1.0/tokens.css`)

    // Verify served files, Content-Type, CORS, and Cache-Control
    const tokLatest = await fetch(`${server.base}/ds/gonovus/latest/tokens.css`)
    expect(tokLatest.status).toBe(200)
    expect(tokLatest.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(tokLatest.headers.get('cache-control')).toContain('max-age=60')
    expect(tokLatest.headers.get('access-control-allow-origin')).toBe('*')
    expect(await tokLatest.text()).toBe(TOKENS_V1)

    const cssPinned = await fetch(`${server.base}/ds/gonovus/0.1.0/components/bundle.css`)
    expect(cssPinned.status).toBe(200)
    expect(cssPinned.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(cssPinned.headers.get('cache-control')).toContain('immutable')

    const jsLatest = await fetch(`${server.base}/ds/gonovus/latest/components/bundle.js`)
    expect(jsLatest.status).toBe(200)
    expect(jsLatest.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    const jsBody = await jsLatest.text()
    expect(jsBody.startsWith(BUNDLE_JS_V1)).toBe(true)
    expect(jsBody.length).toBeGreaterThan(2_200_000)

    // Duplicate version without overwrite must return 409
    const dup = await mate.post('/api/design-systems/gonovus/tickets', {
      version: '0.1.0',
      workspaceId,
      files: ['tokens.css'],
    })
    expect(dup.status).toBe(409)
  })

  it('publishes v0.2.0 via Agent Key Bearer API, immediately updates /latest/, and supports rollback', async () => {
    const pub = await fetch(`${server.base}/api/design-systems/gonovus/releases`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerAgentKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: '0.2.0',
        files: [
          { path: 'tokens.css', content: TOKENS_V2 },
          { path: 'components/bundle.css', content: BUNDLE_CSS_V1 },
          { path: 'components/bundle.js', content: BUNDLE_JS_V2 },
        ],
        notes: 'Blue accent update',
      }),
    })
    expect(pub.status).toBe(200)

    // /latest/ must immediately serve v0.2.0 (cache evicted on publish)
    const latestTok = await fetch(`${server.base}/ds/gonovus/latest/tokens.css`)
    expect(latestTok.status).toBe(200)
    expect(await latestTok.text()).toBe(TOKENS_V2)

    // /0.1.0/ remains immutable
    const oldTok = await fetch(`${server.base}/ds/gonovus/0.1.0/tokens.css`)
    expect(oldTok.status).toBe(200)
    expect(await oldTok.text()).toBe(TOKENS_V1)

    // Rollback latest -> 0.1.0
    const rb = await owner.post('/api/design-systems/gonovus/rollback', { version: '0.1.0' })
    expect(rb.status).toBe(200)
    const afterRb = await fetch(`${server.base}/ds/gonovus/latest/tokens.css`)
    expect(await afterRb.text()).toBe(TOKENS_V1)

    // Cannot delete active latest (0.1.0), CAN delete inactive (0.2.0)
    const delActive = await owner.delete('/api/design-systems/gonovus/releases/0.1.0')
    expect(delActive.status).toBe(409)
    const delOld = await owner.delete('/api/design-systems/gonovus/releases/0.2.0')
    expect(delOld.status).toBe(200)
    const gone = await fetch(`${server.base}/ds/gonovus/0.2.0/tokens.css`)
    expect(gone.status).toBe(404)
  })
})

describe('generic JSX frame compiler for GoNovus & SpecFlow', () => {
  it('wraps GoNovus JSX with same-origin React 18 UMD + window.GoNovusA', async () => {
    const html = await wrapDesignSystemJsxHtml(
      'function App() { return <GoNovusA.Button>Click me</GoNovusA.Button>; }',
      { dsName: 'gonovus', title: 'GoNovus Test' },
    )
    expect(html).toContain('/ds/_runtime/react-18/react.production.min.js')
    expect(html).toContain('/ds/_runtime/react-18/react-dom.production.min.js')
    expect(html).toContain('/ds/gonovus/latest/tokens.css')
    expect(html).toContain('/ds/gonovus/latest/components/bundle.css')
    expect(html).toContain('/ds/gonovus/latest/components/bundle.js')
    expect(html).toContain('const GoNovusA = window["GoNovusA"] || {};')
    expect(html).toContain('window.__doopReady')
  })
})

async function callMcpTool(agentKey: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  expect(res.status).toBe(200)
  const raw = await res.text()
  const jsonText = raw.startsWith('event:')
    ? raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .pop()!
    : raw
  const parsed = JSON.parse(jsonText) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> }
  }
  const text = parsed.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(parsed.result?.isError), text, json: text.startsWith('{') ? JSON.parse(text) : null }
}

describe('MCP tools end-to-end over /mcp', () => {
  it('supports publish_design_system_bundle (inline + ticket), list_design_systems, get_design_system, and workspace auth', async () => {
    const strangerKeyRes = await stranger.post('/api/agent-keys', { name: 'Stranger Key' })
    const strangerKey = ((await strangerKeyRes.json()) as { secret: string }).secret

    // Non-workspace member cannot publish via MCP
    const denied = await callMcpTool(strangerKey, 'publish_design_system_bundle', {
      name: 'gonovus',
      version: '0.3.0',
      files: [{ path: 'tokens.css', content: TOKENS_V1 }],
    })
    expect(denied.isError).toBe(true)

    // Workspace member publishes v0.3.0 inline via MCP
    const pub = await callMcpTool(ownerAgentKey, 'publish_design_system_bundle', {
      name: 'gonovus',
      version: '0.3.0',
      files: [
        { path: 'tokens.css', content: ':root { --gn-accent: #7c3aed; }\n' },
        { path: 'components/bundle.css', content: BUNDLE_CSS_V1 },
        { path: 'components/bundle.js', content: BUNDLE_JS_V2 },
      ],
      notes: 'Published via MCP inline',
    })
    expect(pub.isError).toBe(false)
    expect(pub.json.ok).toBe(true)
    expect(pub.json.version).toBe('0.3.0')

    // list_design_systems includes gonovus @ 0.3.0 + shared react-18-umd runtime
    const listed = await callMcpTool(ownerAgentKey, 'list_design_systems', {})
    expect(listed.isError).toBe(false)
    expect(listed.json.shared_runtimes['react-18-umd'].length).toBe(2)
    expect(
      listed.json.design_systems.some(
        (d: { name: string; latestVersion: string }) => d.name === 'gonovus' && d.latestVersion === '0.3.0',
      ),
    ).toBe(true)

    // get_design_system parses CSS custom properties from tokens.css when tokens.json is absent
    const toks = await callMcpTool(ownerAgentKey, 'get_design_system', {
      ds_name: 'gonovus',
      section: 'tokens',
      query: 'accent',
    })
    expect(toks.isError).toBe(false)
    expect(toks.json.matches['--gn-accent']).toBe('#7c3aed')

    // get_design_system section="guide" returns the live guideMarkdown stored earlier
    const guide = await callMcpTool(ownerAgentKey, 'get_design_system', {
      ds_name: 'gonovus',
      section: 'guide',
    })
    expect(guide.isError).toBe(false)
    expect(guide.json.guide).toContain('GoNovus Live Guide')

    // Ticket mode via MCP mints a ready-to-run curl command
    const ticketCall = await callMcpTool(ownerAgentKey, 'publish_design_system_bundle', {
      name: 'gonovus',
      version: '0.4.0',
      upload_mode: 'ticket',
      files: [{ path: 'tokens.css' }, { path: 'components/bundle.css' }, { path: 'components/bundle.js' }],
    })
    expect(ticketCall.isError).toBe(false)
    expect(ticketCall.json.mode).toBe('ticket')
    expect(ticketCall.json.shell_command).toContain('/ds-upload/')
  })

  it('registers component catalog via set_design_system_catalog, serves manifest.json, lists & inserts <doop-ds> instances', async () => {
    const catalogComponents = [
      {
        exportName: 'Button',
        displayName: 'Button',
        group: 'Actions',
        description: 'Primary or secondary action button',
        props: [
          { name: 'variant', type: 'enum', options: ['primary', 'secondary', 'ghost'], default: 'primary' },
          { name: 'disabled', type: 'boolean', default: false },
          { name: 'children', type: 'text', default: 'Save' },
        ],
        previewSize: { width: 200, height: 64 },
        sampleProps: { variant: 'primary', children: 'Save' },
      },
      {
        exportName: 'Toggle',
        displayName: 'Toggle Switch',
        group: 'Inputs',
        props: [
          { name: 'checked', type: 'boolean', default: true },
          { name: 'label', type: 'text', default: 'Auto sync' },
        ],
        sampleProps: { checked: true, label: 'Auto sync' },
      },
    ]

    // Set component catalog via MCP
    const catRes = await callMcpTool(ownerAgentKey, 'set_design_system_catalog', {
      name: 'gonovus',
      components: catalogComponents,
    })
    expect(catRes.isError).toBe(false)
    expect(catRes.json.ok).toBe(true)
    expect(catRes.json.component_count).toBe(2)

    // Public manifest.json reflects the catalog & runtime with no-cache on latest and immutable on pinned
    const latestManifestRes = await fetch(`${server.base}/ds/gonovus/latest/manifest.json`)
    expect(latestManifestRes.status).toBe(200)
    expect(latestManifestRes.headers.get('cache-control')).toBe('no-cache')
    const latestManifest = (await latestManifestRes.json()) as {
      name: string
      version: string
      runtime: { preset: string; globalName: string; stylesheets: string[]; scripts: string[] }
      components: Array<{ exportName: string; group?: string }>
    }
    expect(latestManifest.name).toBe('gonovus')
    expect(latestManifest.version).toBe('0.3.0')
    expect(latestManifest.runtime.preset).toBe('react-18-umd')
    expect(latestManifest.runtime.globalName).toBe('GoNovusA')
    expect(latestManifest.components.map((c) => c.exportName)).toEqual(['Button', 'Toggle'])

    const pinnedManifestRes = await fetch(`${server.base}/ds/gonovus/0.3.0/manifest.json`)
    expect(pinnedManifestRes.status).toBe(200)
    expect(pinnedManifestRes.headers.get('cache-control')).toContain('immutable')

    // Create a workspace canvas + HTML frame
    const canvasRes = await owner.post('/api/canvases', { name: 'DS Panel Test', workspaceId })
    expect(canvasRes.status).toBe(200)
    const canvas = (await canvasRes.json()) as { id: string }

    const frameRes = await owner.post(`/api/canvases/${canvas.id}/frames`, {
      name: 'Screen 1',
      html: '<!doctype html><html><head></head><body><main id="root"></main></body></html>',
    })
    expect(frameRes.status).toBe(200)
    const frame = (await frameRes.json()) as { id: string }

    // Canvas design systems endpoint returns gonovus with its component catalog
    const canvasDsRes = await owner.get(`/api/canvases/${canvas.id}/design-systems`)
    expect(canvasDsRes.status).toBe(200)
    const canvasDs = (await canvasDsRes.json()) as Array<{
      name: string
      manifest: { components?: Array<{ exportName: string }> }
    }>
    expect(canvasDs.some((d) => d.name === 'gonovus' && d.manifest.components?.length === 2)).toBe(true)

    // MCP list_components exposes hosted DS components with ready-to-paste <doop-ds> usage
    const listAll = await callMcpTool(ownerAgentKey, 'list_components', {
      canvas_id: canvas.id,
      agent_name: 'Tester',
    })
    expect(listAll.isError).toBe(false)
    expect(listAll.json.design_systems[0].name).toBe('gonovus')
    expect(listAll.json.design_systems[0].components).toHaveLength(2)
    expect(listAll.json.design_systems[0].components[0].usage).toContain('<doop-ds ds="gonovus" component="Button"')

    const listFiltered = await callMcpTool(ownerAgentKey, 'list_components', {
      canvas_id: canvas.id,
      query: 'Toggle',
      agent_name: 'Tester',
    })
    expect(listFiltered.isError).toBe(false)
    expect(listFiltered.json.design_systems[0].components).toHaveLength(1)
    expect(listFiltered.json.design_systems[0].components[0].export_name).toBe('Toggle')

    // MCP insert_instance inserts a real <doop-ds> tag with typed props (both explicit ds and shorthand ds:Component)
    const insBtn = await callMcpTool(ownerAgentKey, 'insert_instance', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      ds: 'gonovus',
      component: 'Button',
      props: { variant: 'secondary', children: 'Publish' },
      agent_name: 'Tester',
    })
    expect(insBtn.isError).toBe(false)
    expect(insBtn.json.ok).toBe(true)
    expect(insBtn.json.instance_id).toBeTruthy()

    const insToggle = await callMcpTool(ownerAgentKey, 'insert_instance', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      component: 'gonovus:Toggle',
      version: '0.3.0',
      props: { checked: false },
      agent_name: 'Tester',
    })
    expect(insToggle.isError).toBe(false)
    expect(insToggle.json.ok).toBe(true)

    // Verify frame HTML carries clean <doop-ds> tags with JSON props & pinned version
    const updatedCanvasRes = await owner.get(`/api/canvases/${canvas.id}`)
    const updatedCanvas = (await updatedCanvasRes.json()) as { frames: Array<{ id: string; html: string }> }
    const updatedFrame = updatedCanvas.frames.find((f) => f.id === frame.id)!
    expect(updatedFrame.html).toContain('<doop-ds ds="gonovus" component="Button"')
    expect(updatedFrame.html).toContain('"variant":"secondary"')
    expect(updatedFrame.html).toContain('"children":"Publish"')
    expect(updatedFrame.html).toContain('<doop-ds ds="gonovus" component="Toggle" version="0.3.0"')
    expect(updatedFrame.html).toContain('"checked":false')

    // Verify shared tag/preview helpers
    const tag = buildDoopDsTag({
      ds: 'gonovus',
      component: 'Button',
      props: defaultPropsForComponent(catalogComponents[0] as never),
    })
    expect(tag).toContain('ds="gonovus"')
    expect(parseDoopDsProps('{"checked":true,"count":3}')).toEqual({ checked: true, count: 3 })
    const previewHtml = buildDoopDsPreviewHtml({
      origin: server.base,
      ds: 'gonovus',
      component: 'Button',
      props: { children: 'Save' },
      width: 200,
      height: 64,
    })
    expect(previewHtml).toContain('<doop-ds ds="gonovus" component="Button"')
    expect(previewHtml).toContain('window.__doopDsOrigin=')

    // Ensure FRAME_BOOTSTRAP has valid JS with proper statement separation before embedded IIFEs
    const bootMatch = /<script data-v-boot>([\s\S]*?)<\/script>/.exec(FRAME_BOOTSTRAP)
    expect(bootMatch).toBeTruthy()
    expect(bootMatch![1]).not.toMatch(/window\.addEventListener\([^)]*\)\s*\n\s*\(function/)
    expect(() => new Function(bootMatch![1]!)).not.toThrow()
  })
})
