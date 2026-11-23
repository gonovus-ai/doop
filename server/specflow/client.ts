import { randomUUID } from 'node:crypto'
import { targetProblem } from '../webhooks.ts'

/**
 * Typed HTTP client for SpecFlow's v1 REST API using User API Key (`x-api-key`).
 * Base URL defaults to https://specflow.tools.gonovus.ai and is validated with
 * `targetProblem()` so SSRF rules apply consistently.
 */

export const DEFAULT_SPECFLOW_URL = 'https://specflow.tools.gonovus.ai'
const TIMEOUT_MS = 15_000

export class SpecFlowError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

export interface SpecFlowProject {
  id: string
  name: string
  workspaceId: string
  key?: string
  prefix?: string
  archivedAt?: string | null
  trashedAt?: string | null
}

export interface SpecFlowScreen {
  id: string
  name: string
  description: string | null
  version?: string
  image: { kind: 'url'; url: string } | { kind: 'asset'; assetId: string } | null
}

export function normalizeSpecFlowBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '') || DEFAULT_SPECFLOW_URL
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new SpecFlowError('Enter a valid SpecFlow server URL (e.g. https://specflow.tools.gonovus.ai).', 400)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SpecFlowError('SpecFlow server URL must start with https:// or http://.', 400)
  }
  if (parsed.username || parsed.password) {
    throw new SpecFlowError('Credentials in the SpecFlow server URL are not supported.', 400)
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
}

async function apiRequest<T>(
  baseUrl: string,
  apiKey: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options?: { body?: unknown; idempotencyKey?: string; ifMatch?: string },
): Promise<T> {
  const url = `${baseUrl}${path}`
  const problem = await targetProblem(url)
  if (problem) throw new SpecFlowError(problem, 400)

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    Accept: 'application/json',
  }
  if (options?.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options?.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  if (options?.ifMatch) headers['If-Match'] = options.ifMatch

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new SpecFlowError(`Could not reach SpecFlow: ${msg}`, 502)
  }

  const rawText = await res.text().catch(() => '')
  let json: unknown
  try {
    json = rawText ? JSON.parse(rawText) : {}
  } catch {
    json = undefined
  }

  if (!res.ok) {
    const serverMsg =
      json &&
      typeof json === 'object' &&
      'message' in json &&
      typeof (json as { message: unknown }).message === 'string'
        ? (json as { message: string }).message
        : json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
          ? (json as { error: string }).error
          : ''
    const status =
      res.status === 401 || res.status === 403 ? 401 : res.status >= 400 && res.status < 500 ? res.status : 502
    throw new SpecFlowError(serverMsg || `SpecFlow returned HTTP ${res.status}`, status)
  }

  return json as T
}

export async function verifyIdentity(baseUrl: string, apiKey: string): Promise<{ userId: string }> {
  const data = await apiRequest<{ user?: { id?: string } }>(baseUrl, apiKey, 'GET', '/v1/identity')
  const userId = data?.user?.id
  if (!userId) throw new SpecFlowError('SpecFlow did not return a user identity for this API key.', 401)
  return { userId }
}

const PROJECT_STATUS_MAP: Record<string, string> = {
  active: 'Active',
  archived: 'Archived',
  trashed: 'Trashed',
}

export async function listProjects(
  baseUrl: string,
  apiKey: string,
  options?: { status?: string; workspaceId?: string },
): Promise<SpecFlowProject[]> {
  const qs = new URLSearchParams()
  if (options?.status) {
    qs.set('status', PROJECT_STATUS_MAP[options.status.toLowerCase()] ?? options.status)
  }
  if (options?.workspaceId) qs.set('workspaceId', options.workspaceId)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const data = await apiRequest<{ projects?: Record<string, unknown>[] }>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/projects${suffix}`,
  )
  const rows = Array.isArray(data?.projects) ? data.projects : []
  return rows
    .map((p): SpecFlowProject | null => {
      const id = typeof p.id === 'string' ? p.id : ''
      const name = typeof p.name === 'string' ? p.name : ''
      const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : ''
      if (!id || !name) return null
      return {
        id,
        name,
        workspaceId,
        ...(typeof p.key === 'string' ? { key: p.key } : {}),
        ...(typeof p.prefix === 'string' ? { prefix: p.prefix } : {}),
        archivedAt: typeof p.archivedAt === 'string' ? p.archivedAt : null,
        trashedAt: typeof p.trashedAt === 'string' ? p.trashedAt : null,
      }
    })
    .filter((p): p is SpecFlowProject => p !== null)
}

export async function listWorkItems(
  baseUrl: string,
  apiKey: string,
  projectId: string,
  params?: { search?: string; status?: string; limit?: number; cursor?: string },
): Promise<unknown> {
  const qs = new URLSearchParams()
  if (params?.search) qs.set('search', params.search)
  if (params?.status) qs.set('status', params.status)
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.cursor) qs.set('cursor', params.cursor)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return apiRequest<unknown>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/projects/${encodeURIComponent(projectId)}/work-items${suffix}`,
  )
}

export async function getWorkItem(
  baseUrl: string,
  apiKey: string,
  projectId: string,
  workItemId: string,
): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}`,
  )
}

export async function createWorkItem(
  baseUrl: string,
  apiKey: string,
  projectId: string,
  input: {
    title: string
    description?: string
    resourceLinks?: { kind: 'document' | 'other'; title: string; url: string }[]
  },
): Promise<{ id: string; key?: string; title: string; url: string }> {
  const body: Record<string, unknown> = {
    title: input.title.trim().slice(0, 300),
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 20_000) } : {}),
    ...(input.resourceLinks?.length ? { resourceLinks: input.resourceLinks } : {}),
  }
  const data = await apiRequest<{ workItem?: Record<string, unknown> }>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/projects/${encodeURIComponent(projectId)}/work-items`,
    { body, idempotencyKey: randomUUID() },
  )
  const item = data?.workItem ?? {}
  const id = typeof item.id === 'string' ? item.id : ''
  const key = typeof item.key === 'string' ? item.key : typeof item.identifier === 'string' ? item.identifier : id
  const title = typeof item.title === 'string' ? item.title : input.title
  const url = `${baseUrl}/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(key || id)}`
  return { id: id || key, key: key || undefined, title, url }
}

export async function addWorkItemComment(
  baseUrl: string,
  apiKey: string,
  projectId: string,
  workItemId: string,
  content: string,
): Promise<unknown> {
  return apiRequest<unknown>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/comments`,
    { body: { content: content.trim().slice(0, 20_000) }, idempotencyKey: randomUUID() },
  )
}

export async function addWorkItemResourceLink(
  baseUrl: string,
  apiKey: string,
  projectId: string,
  workItemId: string,
  title: string,
  url: string,
): Promise<unknown> {
  return apiRequest<unknown>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/resource-links`,
    {
      body: {
        target: {
          kind: 'document',
          title: title.trim().slice(0, 200),
          url: url.trim().slice(0, 4096),
        },
      },
      idempotencyKey: randomUUID(),
    },
  )
}

export async function searchSpecs(
  baseUrl: string,
  apiKey: string,
  workspaceId: string,
  query: string,
  limit = 20,
): Promise<unknown> {
  const qs = new URLSearchParams({ query, limit: String(limit) })
  return apiRequest<unknown>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/spec-search?${qs.toString()}`,
  )
}

export async function getSpecWithRevision(
  baseUrl: string,
  apiKey: string,
  workspaceId: string,
  specId: string,
): Promise<{ spec: unknown; currentRevision: unknown }> {
  const encodedWs = encodeURIComponent(workspaceId)
  const encodedSpec = encodeURIComponent(specId)
  const spec = await apiRequest<unknown>(baseUrl, apiKey, 'GET', `/v1/workspaces/${encodedWs}/specs/${encodedSpec}`)
  let currentRevision: unknown = null
  try {
    currentRevision = await apiRequest<unknown>(
      baseUrl,
      apiKey,
      'GET',
      `/v1/workspaces/${encodedWs}/specs/${encodedSpec}/current-revision`,
    )
  } catch {
    /* draft-only specs may not have a published Ready current revision yet */
  }
  return { spec, currentRevision }
}

export async function getGlossary(baseUrl: string, apiKey: string, workspaceId: string): Promise<unknown> {
  return apiRequest<unknown>(baseUrl, apiKey, 'GET', `/v1/workspaces/${encodeURIComponent(workspaceId)}/glossary`)
}

export async function listScreens(baseUrl: string, apiKey: string, workspaceId: string): Promise<SpecFlowScreen[]> {
  const data = await apiRequest<{ screens?: SpecFlowScreen[] }>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/screens`,
  )
  return Array.isArray(data?.screens) ? data.screens : []
}

export async function uploadScreenImage(
  baseUrl: string,
  apiKey: string,
  workspaceId: string,
  screenId: string,
  filename: string,
  png: Buffer,
): Promise<{ screen: SpecFlowScreen }> {
  const encodedWs = encodeURIComponent(workspaceId)
  const encodedScreen = encodeURIComponent(screenId)
  const reservation = await apiRequest<{
    uploadId: string
    uploadUrl: string
    headers?: Record<string, string>
  }>(baseUrl, apiKey, 'POST', `/v1/workspaces/${encodedWs}/screens/${encodedScreen}/image/uploads`, {
    body: {
      filename: filename.slice(0, 255),
      contentType: 'image/png',
      size: png.byteLength,
    },
    idempotencyKey: randomUUID(),
  })

  const uploadUrl = reservation.uploadUrl.startsWith('http')
    ? reservation.uploadUrl
    : `${baseUrl}${reservation.uploadUrl.startsWith('/') ? '' : '/'}${reservation.uploadUrl}`
  const uploadProblem = await targetProblem(uploadUrl)
  if (uploadProblem) throw new SpecFlowError(uploadProblem, 400)

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', ...(reservation.headers ?? {}) },
    body: new Uint8Array(png),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!putRes.ok) {
    throw new SpecFlowError(`SpecFlow screen image upload failed (HTTP ${putRes.status}).`, 502)
  }

  return apiRequest<{ screen: SpecFlowScreen }>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/workspaces/${encodedWs}/screens/${encodedScreen}/image/finalize`,
    {
      body: { uploadId: reservation.uploadId },
      idempotencyKey: randomUUID(),
    },
  )
}
