import express, { Router, type Request, type Response } from 'express'
import {
  parseBuiltInAgentPatch,
  parseCustomAgentInput,
  parseCustomAgentPatch,
  type AgentScope,
} from '../shared/customAgents.ts'
import { MAX_AVATAR_BYTES } from '../shared/avatar.ts'
import {
  AgentInputError,
  createCustomAgent,
  deleteCustomAgent,
  getExternalAgentRecord,
  isExternalAgentRow,
  listBuiltInAgents,
  listCustomAgents,
  resetBuiltInAgent,
  rotateExternalAgentSecret,
  setCustomAgentAvatar,
  updateBuiltInAgent,
  updateCustomAgent,
} from './customAgents.ts'
import { isWorkspaceMember } from './workspaces.ts'
import { broadcastCustomAgents } from './actions.ts'
import { captureFeature } from './featureEvents.ts'
import { targetProblem } from './webhooks.ts'
import { findAgentKeyOwner } from './agentKeys.ts'
import { sendExternalAgentPing } from './externalAgents.ts'
import { sniffMime, storeAsset } from './assets.ts'

const AVATAR_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const

/** /api/agents: the custom agents Settings and Workspace manage, and under
 *  /api/agents/builtin the same team's changes to the built-in agents. `?workspace=`
 *  names a workspace's (members only); without it they are the signed-in
 *  person's own, used on their personal canvases. The /api session gate
 *  upstream means impersonating admins can look but not change anything. */
export const customAgentsRouter = Router()

/** Whether a person may read and change a scope's agents. */
function canUseAgentScope(scope: AgentScope, userId: string): boolean {
  return 'personal' in scope || isWorkspaceMember(scope.workspaceId, userId)
}

function scopeOf(req: Request, res: Response): AgentScope | null {
  const workspace = req.query.workspace
  const scope: AgentScope = typeof workspace === 'string' && workspace ? { workspaceId: workspace } : { personal: true }
  if (canUseAgentScope(scope, req.user!.id)) return scope
  res.status(403).json({ error: 'you are not a member of this workspace' })
  return null
}

function announce(scope: AgentScope, userId: string) {
  broadcastCustomAgents('workspaceId' in scope ? scope : { ownerId: userId })
}

function failed(res: Response, e: unknown, what: string) {
  if (e instanceof AgentInputError) res.status(400).json({ error: e.message })
  else {
    console.error(`[agents] ${what} failed`, e)
    res.status(500).json({ error: `the agent could not be ${what === 'delete' ? 'removed' : 'saved'} — try again` })
  }
}

async function checkExternalFields(
  scope: AgentScope,
  userId: string,
  webhookUrl: string | null | undefined,
  agentKeyId: string | null | undefined,
): Promise<string | null> {
  if (webhookUrl) {
    const problem = await targetProblem(webhookUrl)
    if (problem) return problem
  }
  if (agentKeyId) {
    const owner = await findAgentKeyOwner(agentKeyId)
    if (!owner) return 'that API key does not exist or was revoked'
    if (owner !== userId && !('workspaceId' in scope && isWorkspaceMember(scope.workspaceId, owner))) {
      return 'that API key does not belong to you or a member of this workspace'
    }
  }
  return null
}

customAgentsRouter.get('/', (req, res) => {
  const scope = scopeOf(req, res)
  if (scope) res.json(listCustomAgents(scope, req.user!.id))
})

customAgentsRouter.post('/', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const input = parseCustomAgentInput(req.body)
  if (!input.ok) return res.status(400).json({ error: input.error })
  const userId = req.user!.id
  if (input.value.external) {
    const problem = await checkExternalFields(scope, userId, input.value.webhookUrl, input.value.agentKeyId)
    if (problem) return res.status(400).json({ error: problem })
  }
  try {
    const agent = await createCustomAgent(scope, userId, input.value, () => canUseAgentScope(scope, userId))
    announce(scope, userId)
    captureFeature(userId, 'custom_agent_created', 'ui', {
      scope: 'workspaceId' in scope ? 'workspace' : 'personal',
      reviewer: input.value.reviewer,
      external: !!input.value.external,
    })
    res.json(agent)
  } catch (e) {
    failed(res, e, 'create')
  }
})

customAgentsRouter.patch('/:handle', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const userId = req.user!.id
  const external = isExternalAgentRow(scope, userId, req.params.handle)
  const patch = parseCustomAgentPatch(req.body, { external })
  if (!patch.ok) return res.status(400).json({ error: patch.error })
  if (external) {
    const problem = await checkExternalFields(scope, userId, patch.value.webhookUrl, patch.value.agentKeyId)
    if (problem) return res.status(400).json({ error: problem })
  }
  try {
    const agent = await updateCustomAgent(scope, userId, req.params.handle, patch.value, () =>
      canUseAgentScope(scope, userId),
    )
    if (!agent) return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    res.json(agent)
  } catch (e) {
    failed(res, e, 'update')
  }
})

customAgentsRouter.post(
  '/:handle/avatar',
  express.raw({ type: () => true, limit: MAX_AVATAR_BYTES + 1024 }),
  async (req, res) => {
    const scope = scopeOf(req, res)
    if (!scope) return
    const userId = req.user!.id
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    if (buf.length === 0) return res.status(400).json({ error: 'choose an image file' })
    if (buf.length > MAX_AVATAR_BYTES) return res.status(400).json({ error: 'the photo is over 2 MB' })
    const mime = sniffMime(buf)
    const ext = mime && mime in AVATAR_EXT ? AVATAR_EXT[mime as keyof typeof AVATAR_EXT] : undefined
    if (!mime || !ext) return res.status(400).json({ error: 'png, jpg, webp and gif photos are accepted' })
    try {
      const asset = await storeAsset(buf, { mime, ext }, { ownerId: userId, uploadedBy: userId })
      const avatar = `/a/${asset.id}.${asset.ext}`
      const agent = await setCustomAgentAvatar(scope, userId, req.params.handle, avatar, () =>
        canUseAgentScope(scope, userId),
      )
      if (!agent) return res.status(404).json({ error: 'agent not found' })
      announce(scope, userId)
      res.json(agent)
    } catch (e) {
      failed(res, e, 'update')
    }
  },
)

customAgentsRouter.delete('/:handle/avatar', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const userId = req.user!.id
  try {
    const agent = await setCustomAgentAvatar(scope, userId, req.params.handle, null, () =>
      canUseAgentScope(scope, userId),
    )
    if (!agent) return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    res.json(agent)
  } catch (e) {
    failed(res, e, 'update')
  }
})

customAgentsRouter.post('/:handle/rotate-secret', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const userId = req.user!.id
  try {
    const rotated = await rotateExternalAgentSecret(scope, userId, req.params.handle, () =>
      canUseAgentScope(scope, userId),
    )
    if (!rotated) return res.status(404).json({ error: 'external agent not found' })
    res.json({ ok: true, agent: rotated.agent, webhookSecret: rotated.webhookSecret })
  } catch (e) {
    failed(res, e, 'update')
  }
})

customAgentsRouter.post('/:handle/test', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const record = getExternalAgentRecord(scope, req.user!.id, req.params.handle)
  if (!record) return res.status(404).json({ error: 'external agent not found' })
  const result = await sendExternalAgentPing(record)
  res.json(result)
})

customAgentsRouter.delete('/:handle', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const userId = req.user!.id
  try {
    if (!(await deleteCustomAgent(scope, userId, req.params.handle, () => canUseAgentScope(scope, userId))))
      return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    res.json({ ok: true })
  } catch (e) {
    failed(res, e, 'delete')
  }
})

/* the built-in agents as this team has them: on or off, and edited */
customAgentsRouter.get('/builtin', (req, res) => {
  const scope = scopeOf(req, res)
  if (scope) res.json(listBuiltInAgents(scope, req.user!.id))
})

customAgentsRouter.patch('/builtin/:id', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const patch = parseBuiltInAgentPatch(req.params.id, req.body)
  if (!patch.ok) return res.status(400).json({ error: patch.error })
  const userId = req.user!.id
  try {
    const agent = await updateBuiltInAgent(scope, userId, req.params.id, patch.value, () =>
      canUseAgentScope(scope, userId),
    )
    if (!agent) return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    if (patch.value.disabled !== undefined)
      captureFeature(userId, 'builtin_agent_toggled', 'ui', { role: req.params.id, enabled: !patch.value.disabled })
    res.json(agent)
  } catch (e) {
    failed(res, e, 'update')
  }
})

/* undo the team's edits to a built-in agent; on or off stays */
customAgentsRouter.delete('/builtin/:id', async (req, res) => {
  const scope = scopeOf(req, res)
  if (!scope) return
  const userId = req.user!.id
  try {
    const agent = await resetBuiltInAgent(scope, userId, req.params.id, () => canUseAgentScope(scope, userId))
    if (!agent) return res.status(404).json({ error: 'agent not found' })
    announce(scope, userId)
    res.json(agent)
  } catch (e) {
    failed(res, e, 'update')
  }
})
