import express from 'express'
import { z } from 'zod'
import type { ServerExtension } from '../extensions.ts'
import { AutomationPullError } from '../extensions.ts'
import { renderFrame } from '../screenshot.ts'
import { store } from '../store.ts'
import { isWorkspaceMember } from '../workspaces.ts'
import { automationProjects, automationScreens, runSpecFlowAutomationStep } from './automation.ts'
import {
  addWorkItemComment,
  addWorkItemResourceLink,
  getGlossary,
  getSpecWithRevision,
  getWorkItem,
  listProjects,
  listScreens,
  listWorkItems,
  searchSpecs,
  SpecFlowError,
  uploadScreenImage,
} from './client.ts'
import {
  connect,
  connectionStatus,
  deleteWebhookReceiver,
  disconnect,
  getConnection,
  saveWebhookReceiver,
} from './connection.ts'
import { specflowWebhookRouter } from './webhook.ts'

export const specflowExtension: ServerExtension = {
  id: 'specflow',
  webhookRouter: specflowWebhookRouter,
  connectionStatus,
  runAutomationAction: (step, ctx) => {
    if (step.type !== 'specflow') throw new Error('Expected a SpecFlow step')
    return runSpecFlowAutomationStep(step, ctx.ownerId, ctx.context)
  },
  connectRouter: ({ respondWithStatus }) => {
    const router = express.Router()

    router.get('/projects', async (req, res, next) => {
      try {
        res.json(await automationProjects(req.user!.id))
      } catch (error) {
        if (error instanceof SpecFlowError || error instanceof AutomationPullError) {
          return res.status(error instanceof SpecFlowError ? error.status : 409).json({ error: error.message })
        }
        next(error)
      }
    })

    router.get('/screens', async (req, res, next) => {
      const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : ''
      if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required.' })
      try {
        res.json(await automationScreens(req.user!.id, workspaceId))
      } catch (error) {
        if (error instanceof SpecFlowError || error instanceof AutomationPullError) {
          return res.status(error instanceof SpecFlowError ? error.status : 409).json({ error: error.message })
        }
        next(error)
      }
    })

    router.post('/token', async (req, res, next) => {
      const input = z
        .object({
          token: z.string().min(1),
          baseUrl: z.string().optional(),
        })
        .safeParse(req.body)
      if (!input.success) return res.status(400).json({ error: 'Enter a SpecFlow User API key.' })
      try {
        await connect(req.user!.id, input.data.token, input.data.baseUrl)
        await respondWithStatus(req, res)
      } catch (error) {
        if (error instanceof SpecFlowError) return res.status(error.status).json({ error: error.message })
        next(error)
      }
    })

    router.put('/webhook', async (req, res, next) => {
      const input = z
        .object({
          signingSecret: z.string().optional(),
          workspaceId: z.string().nullable().optional(),
          targetAgent: z.string().optional(),
        })
        .safeParse(req.body)
      if (!input.success) return res.status(400).json({ error: 'Invalid SpecFlow webhook settings.' })
      if (input.data.workspaceId && !isWorkspaceMember(input.data.workspaceId, req.user!.id)) {
        return res.status(403).json({ error: 'You are not a member of that Doop workspace.' })
      }
      try {
        await saveWebhookReceiver(req.user!.id, input.data)
        await respondWithStatus(req, res)
      } catch (error) {
        if (error instanceof SpecFlowError) return res.status(error.status).json({ error: error.message })
        next(error)
      }
    })

    router.delete('/webhook', async (req, res, next) => {
      try {
        await deleteWebhookReceiver(req.user!.id)
        await respondWithStatus(req, res)
      } catch (error) {
        next(error)
      }
    })

    router.delete('/', async (req, res, next) => {
      try {
        await disconnect(req.user!.id)
        await respondWithStatus(req, res)
      } catch (error) {
        next(error)
      }
    })

    return router
  },
  registerMcpTools: (server, helpers) => {
    async function withConn<T>(run: (conn: { baseUrl: string; accessToken: string }) => Promise<T>) {
      try {
        const conn = helpers.ownerId ? await getConnection(helpers.ownerId) : undefined
        if (!conn) return helpers.err('Connect SpecFlow on the Integrations page first.')
        return helpers.text(await run({ baseUrl: conn.baseUrl, accessToken: conn.accessToken }))
      } catch (error) {
        return helpers.err(error instanceof SpecFlowError ? error.message : 'SpecFlow request failed.')
      }
    }

    const readAnn = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    const writeAnn = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }

    server.registerTool(
      'list_specflow_projects',
      {
        title: 'List SpecFlow projects',
        description:
          'List accessible SpecFlow projects (including each project’s workspaceId) using the user’s SpecFlow integration.',
        annotations: readAnn,
        inputSchema: {
          status: z
            .enum(['Active', 'Archived', 'Trashed', 'active', 'archived', 'trashed'])
            .optional()
            .describe('Filter projects by lifecycle status (Active, Archived, Trashed)'),
          workspace_id: z.string().optional().describe('Optional SpecFlow workspace ID filter'),
        },
      },
      ({ status, workspace_id }) =>
        withConn((c) => listProjects(c.baseUrl, c.accessToken, { status, workspaceId: workspace_id })),
    )

    server.registerTool(
      'list_specflow_work_items',
      {
        title: 'List SpecFlow work items',
        description: 'List or search work items inside a SpecFlow project.',
        annotations: readAnn,
        inputSchema: {
          project_id: z.string().min(1).describe('SpecFlow project ID (from list_specflow_projects)'),
          search: z.string().optional().describe('Optional keyword search'),
          status: z.string().optional().describe('Optional status filter'),
          limit: z.number().int().min(1).max(100).optional(),
        },
      },
      ({ project_id, search, status, limit }) =>
        withConn((c) => listWorkItems(c.baseUrl, c.accessToken, project_id, { search, status, limit })),
    )

    server.registerTool(
      'get_specflow_work_item',
      {
        title: 'Read a SpecFlow work item',
        description: 'Read a SpecFlow work item’s full title, description, linked specs, and status.',
        annotations: readAnn,
        inputSchema: {
          project_id: z.string().min(1),
          work_item_id: z.string().min(1).describe('Work item ID or key (e.g. SPF-70)'),
        },
      },
      ({ project_id, work_item_id }) =>
        withConn((c) => getWorkItem(c.baseUrl, c.accessToken, project_id, work_item_id)),
    )

    server.registerTool(
      'search_specflow_specs',
      {
        title: 'Search authoritative SpecFlow Specs',
        description: 'Search Specs inside a SpecFlow workspace by keyword.',
        annotations: readAnn,
        inputSchema: {
          workspace_id: z.string().min(1).describe('SpecFlow workspace ID (from list_specflow_projects)'),
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      ({ workspace_id, query, limit }) =>
        withConn((c) => searchSpecs(c.baseUrl, c.accessToken, workspace_id, query, limit)),
    )

    server.registerTool(
      'get_specflow_spec',
      {
        title: 'Read a SpecFlow Spec and Current Revision',
        description:
          'Read an authoritative SpecFlow Spec together with its Ready Current Revision (and optionally the Workspace Glossary).',
        annotations: readAnn,
        inputSchema: {
          workspace_id: z.string().min(1),
          spec_id: z.string().min(1).describe('Stable Spec ID (e.g. SPF-S12)'),
          include_glossary: z.boolean().optional().describe('Also return the Workspace Glossary'),
        },
      },
      ({ workspace_id, spec_id, include_glossary }) =>
        withConn(async (c) => {
          const data = await getSpecWithRevision(c.baseUrl, c.accessToken, workspace_id, spec_id)
          if (!include_glossary) return data
          const glossary = await getGlossary(c.baseUrl, c.accessToken, workspace_id).catch(() => null)
          return { ...data, glossary }
        }),
    )

    server.registerTool(
      'list_specflow_screens',
      {
        title: 'List SpecFlow Product Map screens',
        description: 'List Product Map screens in a SpecFlow workspace.',
        annotations: readAnn,
        inputSchema: {
          workspace_id: z.string().min(1),
        },
      },
      ({ workspace_id }) => withConn((c) => listScreens(c.baseUrl, c.accessToken, workspace_id)),
    )

    server.registerTool(
      'comment_specflow_work_item',
      {
        title: 'Comment on a SpecFlow work item',
        description:
          'Post a design update or Doop canvas link onto a SpecFlow work item, optionally attaching a resource link.',
        annotations: writeAnn,
        inputSchema: {
          project_id: z.string().min(1),
          work_item_id: z.string().min(1),
          content: z.string().min(1).max(20_000),
          link_title: z.string().max(200).optional(),
          link_url: z.string().url().optional(),
        },
      },
      ({ project_id, work_item_id, content, link_title, link_url }) =>
        withConn(async (c) => {
          const comment = await addWorkItemComment(c.baseUrl, c.accessToken, project_id, work_item_id, content)
          let resourceLink: unknown = null
          if (link_url) {
            resourceLink = await addWorkItemResourceLink(
              c.baseUrl,
              c.accessToken,
              project_id,
              work_item_id,
              link_title || 'Doop design canvas',
              link_url,
            )
          }
          return { ok: true, comment, ...(resourceLink ? { resourceLink } : {}) }
        }),
    )

    server.registerTool(
      'sync_frame_to_specflow_screen',
      {
        title: 'Upload a Doop frame screenshot to a SpecFlow screen',
        description: 'Render a Doop frame to a 2x PNG and upload it directly onto a SpecFlow Product Map screen.',
        annotations: writeAnn,
        inputSchema: {
          canvas_id: z.string().min(1),
          frame_id: z.string().min(1),
          workspace_id: z.string().min(1).describe('SpecFlow workspace ID'),
          screen_id: z.string().min(1).describe('SpecFlow screen ID (from list_specflow_screens)'),
        },
      },
      async ({ canvas_id, frame_id, workspace_id, screen_id }) => {
        if (!helpers.canvasFor(canvas_id, 'view')) return helpers.noCanvas(canvas_id)
        const frame = store.getFrame(frame_id)
        if (!frame || frame.canvasId !== canvas_id) return helpers.err(`no frame ${frame_id} on canvas ${canvas_id}`)
        return withConn(async (c) => {
          const png = await renderFrame(frame, 2)
          const safeName = `${frame.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || frame.id}.png`
          return uploadScreenImage(c.baseUrl, c.accessToken, workspace_id, screen_id, safeName, png)
        })
      },
    )
  },
  mcpGuideLines: [
    '- SpecFlow: list_specflow_projects, list_specflow_work_items, get_specflow_work_item, search_specflow_specs, get_specflow_spec, list_specflow_screens, comment_specflow_work_item, and sync_frame_to_specflow_screen connect Doop directly to SpecFlow (requires connecting SpecFlow in Integrations).',
  ],
}
