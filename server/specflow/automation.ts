import type { SpecFlowStep } from '../../shared/automations.ts'
import { AutomationPullError } from '../extensions.ts'
import { canvasLink } from '../links.ts'
import { renderFrame } from '../screenshot.ts'
import { store } from '../store.ts'
import { createWorkItem, listProjects, listScreens, uploadScreenImage } from './client.ts'
import { getConnection } from './connection.ts'

async function requireConnection(ownerId: string) {
  const conn = await getConnection(ownerId)
  if (!conn) throw new AutomationPullError('Connect SpecFlow in Integrations first.', 'reconnect')
  return conn
}

export async function automationProjects(userId: string) {
  const conn = await requireConnection(userId)
  const projects = await listProjects(conn.baseUrl, conn.accessToken, { status: 'active' })
  return projects.filter((p) => !p.archivedAt && !p.trashedAt)
}

export async function automationScreens(userId: string, workspaceId: string) {
  const conn = await requireConnection(userId)
  return listScreens(conn.baseUrl, conn.accessToken, workspaceId)
}

export async function runSpecFlowAutomationStep(
  step: SpecFlowStep,
  ownerId: string,
  context: string,
): Promise<{ summary: string; url?: string }> {
  const conn = await requireConnection(ownerId)
  const canvas = store.getCanvas(step.canvasId)
  const canvasUrl = canvasLink(step.canvasId)
  const description = [step.description.trim(), context.trim()].filter(Boolean).join('\n\n')
  const created = await createWorkItem(conn.baseUrl, conn.accessToken, step.projectId, {
    title: step.title,
    description: description || undefined,
    resourceLinks: [
      {
        kind: 'document',
        title: canvas ? `Doop · ${canvas.name}` : 'Doop design canvas',
        url: canvasUrl,
      },
    ],
  })

  let screenNote = ''
  if (step.workspaceId && step.screenId && canvas) {
    const approved = canvas.frames
      .filter((f) => f.approval?.status === 'ready_for_dev')
      .sort((a, b) => (b.approval?.approvedAt ?? 0) - (a.approval?.approvedAt ?? 0))
    const targetFrame = approved[0] ?? [...canvas.frames].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (targetFrame) {
      const png = await renderFrame(targetFrame, 2)
      const safeName = `${targetFrame.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || targetFrame.id}.png`
      await uploadScreenImage(conn.baseUrl, conn.accessToken, step.workspaceId, step.screenId, safeName, png)
      screenNote = ` · synced “${targetFrame.name}” to screen`
    }
  }

  return {
    summary: `Created SpecFlow ${created.key ?? created.id}${screenNote}`,
    url: created.url,
  }
}
