import { Router, type Request, type Response } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from './auth.ts'
import * as agentKeys from './agentKeys.ts'
import {
  commitPublishTicket,
  createPublishTicket,
  deleteDesignSystemRelease,
  DesignSystemError,
  getActivePublishTicket,
  getDesignSystemDetailForUser,
  listDesignSystemsForUser,
  publishRelease,
  rollbackDesignSystem,
  stageTicketFile,
  updateDesignSystemMeta,
  type PublishFileInput,
} from './designSystemRegistry.ts'
import { DS_MAX_FILE_BYTES, type PartialManifestInput } from '../shared/designSystems.ts'

/**
 * Authenticated HTTP surface for managing & publishing Design Systems.
 * Accepts EITHER:
 *  - a browser session cookie (Web UI in Workspace -> Libraries), OR
 *  - a Doop Agent Key (`Authorization: Bearer dpk_...`) for CI / CLI scripts.
 */
export const designSystemsRouter = Router()

interface DsAuthedRequest extends Request {
  dsUserId?: string
  dsImpersonatedBy?: string
}

designSystemsRouter.use(async (req: DsAuthedRequest, res: Response, next) => {
  try {
    const authHeader = req.headers.authorization
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const secret = authHeader.slice(7).trim()
      const verified = await agentKeys.verifyAgentKey(secret)
      if (!verified) return res.status(401).json({ error: 'invalid agent key' })
      req.dsUserId = verified.userId
      return next()
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) return res.status(401).json({ error: 'unauthorized' })
    req.dsUserId = session.user.id
    req.dsImpersonatedBy = (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? undefined
    if (req.dsImpersonatedBy && req.method !== 'GET') {
      return res.status(403).json({ error: 'viewing as another user — read only' })
    }
    next()
  } catch (err) {
    next(err)
  }
})

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof DesignSystemError) {
    return res.status(err.status).json({ error: err.message })
  }
  console.error('[design-systems] request failed', err)
  return res.status(500).json({ error: fallback })
}

designSystemsRouter.get('/', (req: DsAuthedRequest, res) => {
  try {
    const workspaceId = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : undefined
    res.json(listDesignSystemsForUser(req.dsUserId!, workspaceId))
  } catch (err) {
    sendError(res, err, 'failed to list design systems')
  }
})

designSystemsRouter.get('/:name', (req: DsAuthedRequest, res) => {
  try {
    const detail = getDesignSystemDetailForUser(String(req.params.name ?? ''), req.dsUserId!)
    if (!detail) return res.status(404).json({ error: 'design system not found' })
    res.json(detail)
  } catch (err) {
    sendError(res, err, 'failed to load design system')
  }
})

/** Mint a staged upload ticket for CI or CLI scripts (curl -T + POST /commit). */
designSystemsRouter.post('/:name/tickets', (req: DsAuthedRequest, res) => {
  try {
    const body = (req.body ?? {}) as {
      version?: string
      workspaceId?: string
      workspace_id?: string
      files?: string[]
      manifest?: PartialManifestInput
      notes?: string
      overwrite?: boolean
    }
    if (typeof body.version !== 'string') return res.status(400).json({ error: 'version is required' })
    const ticket = createPublishTicket({
      name: String(req.params.name ?? ''),
      version: body.version,
      userId: req.dsUserId!,
      workspaceId: body.workspaceId ?? body.workspace_id,
      expectedFiles: Array.isArray(body.files) ? body.files : undefined,
      manifest: body.manifest,
      notes: body.notes,
      overwrite: body.overwrite,
    })
    res.json({ ok: true, ...ticket })
  } catch (err) {
    sendError(res, err, 'failed to create publish ticket')
  }
})

/** Direct JSON publish for smaller bundles or automated scripts (up to 10 MB body). */
designSystemsRouter.post('/:name/releases', async (req: DsAuthedRequest, res) => {
  try {
    const body = (req.body ?? {}) as {
      version?: string
      workspaceId?: string
      workspace_id?: string
      files?: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>
      manifest?: PartialManifestInput
      notes?: string
      overwrite?: boolean
    }
    if (typeof body.version !== 'string') return res.status(400).json({ error: 'version is required' })
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return res.status(400).json({ error: 'files array is required' })
    }
    const files: PublishFileInput[] = body.files.map((f) => ({
      path: String(f.path ?? ''),
      buffer: Buffer.from(String(f.content ?? ''), f.encoding === 'base64' ? 'base64' : 'utf8'),
    }))
    const result = await publishRelease({
      name: String(req.params.name ?? ''),
      version: body.version,
      userId: req.dsUserId!,
      workspaceId: body.workspaceId ?? body.workspace_id,
      files,
      manifest: body.manifest,
      notes: body.notes,
      overwrite: body.overwrite,
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    sendError(res, err, 'failed to publish design system release')
  }
})

designSystemsRouter.post('/:name/rollback', async (req: DsAuthedRequest, res) => {
  try {
    const version = (req.body as { version?: string } | undefined)?.version
    if (typeof version !== 'string') return res.status(400).json({ error: 'version is required' })
    const summary = await rollbackDesignSystem(String(req.params.name ?? ''), version, req.dsUserId!)
    res.json({ ok: true, designSystem: summary })
  } catch (err) {
    sendError(res, err, 'failed to rollback design system')
  }
})

designSystemsRouter.patch('/:name', async (req: DsAuthedRequest, res) => {
  try {
    const body = (req.body ?? {}) as {
      displayName?: string
      description?: string
      guideMarkdown?: string
      components?: unknown
    }
    const summary = await updateDesignSystemMeta(String(req.params.name ?? ''), req.dsUserId!, {
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      guideMarkdown: typeof body.guideMarkdown === 'string' ? body.guideMarkdown : undefined,
      ...(body.components !== undefined ? { components: body.components as never } : {}),
    })
    res.json({ ok: true, designSystem: summary })
  } catch (err) {
    sendError(res, err, 'failed to update design system')
  }
})

designSystemsRouter.delete('/:name/releases/:version', async (req: DsAuthedRequest, res) => {
  try {
    const deleted = await deleteDesignSystemRelease(
      String(req.params.name ?? ''),
      String(req.params.version ?? ''),
      req.dsUserId!,
    )
    if (!deleted) return res.status(404).json({ error: 'release not found' })
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err, 'failed to delete release')
  }
})

/**
 * Mounted BEFORE express.json(): streaming file upload + atomic commit
 * for staged capability tickets minted by MCP or /api/design-systems/:name/tickets.
 */
export async function handleDesignSystemTicketPut(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token ?? '')
  const relPath = String((req.params as Record<string, string | undefined>)['0'] ?? '')
  const ticket = getActivePublishTicket(token)
  if (!ticket) {
    res.status(410).json({
      error:
        'invalid, expired, or already-committed publish ticket — request a new one via publish_design_system_bundle',
    })
    req.destroy()
    return
  }

  const contentLength = Number(req.headers['content-length'] || 0)
  if (contentLength > DS_MAX_FILE_BYTES) {
    res.status(413).json({ error: `file exceeds the ${DS_MAX_FILE_BYTES / 1024 / 1024} MB single-file limit` })
    req.destroy()
    return
  }

  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer
      total += buf.length
      if (total > DS_MAX_FILE_BYTES) {
        res.status(413).json({ error: `file exceeds the ${DS_MAX_FILE_BYTES / 1024 / 1024} MB single-file limit` })
        req.destroy()
        return
      }
      chunks.push(buf)
    }
    const staged = stageTicketFile(token, relPath, Buffer.concat(chunks))
    res.json({ ok: true, ...staged })
  } catch (err) {
    sendError(res, err, 'failed to stage design system file')
  }
}

export async function handleDesignSystemTicketCommit(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token ?? '')
  try {
    const result = await commitPublishTicket(token)
    res.json({ ok: true, ...result })
  } catch (err) {
    sendError(res, err, 'failed to commit design system release')
  }
}
