import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { env } from './env.ts'
import * as storage from './storage.ts'
import * as workspaces from './workspaces.ts'
import {
  DS_MAX_FILE_BYTES,
  DS_MAX_FILES_PER_RELEASE,
  DS_MAX_GUIDE_CHARS,
  DS_MAX_RELEASE_BYTES,
  mimeForDsFile,
  resolveDesignSystemManifest,
  sanitizeDsFilePath,
  validateDsName,
  validateDsVersion,
  type DesignSystemDetail,
  type DesignSystemFileMeta,
  type DesignSystemManifest,
  type DesignSystemReleaseSummary,
  type DesignSystemSummary,
  type PartialManifestInput,
} from '../shared/designSystems.ts'

/**
 * First-class, workspace-scoped Design System Registry.
 *
 * - Metadata and release history live in PostgreSQL (`design_systems`,
 *   `design_system_releases`) and are mirrored in memory at boot for
 *   zero-DB-hop serving of `/ds/<name>/<version|latest>/*`.
 * - Release file bytes live in Doop's unified `server/storage.ts` under
 *   `ds/<name>/<version>/<relpath>` (local persistent disk or S3/R2 bucket).
 * - Publishing supports both staged one-time upload tickets (so agents stream
 *   530KB–5MB bundles directly from disk via curl with zero LLM token overhead)
 *   and direct inline/HTTP publishing, with atomic `latest` pointer updates and
 *   instant HTTP cache invalidation.
 */

type DsRow = typeof t.designSystems.$inferSelect
type ReleaseRow = typeof t.designSystemReleases.$inferSelect

const systems = new Map<string, DsRow>()
const releasesBySystem = new Map<string, Map<string, ReleaseRow>>()
const writeChains = new Map<string, Promise<unknown>>()
const changeListeners = new Set<(name: string) => void>()

export class DesignSystemError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function onDesignSystemChanged(listener: (name: string) => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

function notifyChanged(name: string): void {
  for (const listener of changeListeners) {
    try {
      listener(name)
    } catch {
      /* listener failure must never break writes */
    }
  }
}

function inDsOrder<T>(name: string, work: () => Promise<T>): Promise<T> {
  const next = (writeChains.get(name) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => {})
  writeChains.set(name, settled)
  void settled.then(() => {
    if (writeChains.get(name) === settled) writeChains.delete(name)
  })
  return next
}

export function dsStorageKey(name: string, version: string, relPath: string): string {
  return `ds/${name}/${version}/${relPath}`
}

function publicOrigin(): string {
  return new URL(env.BETTER_AUTH_URL).origin
}

export async function hydrateDesignSystems(): Promise<void> {
  const [allSystems, allReleases] = await Promise.all([
    db.select().from(t.designSystems),
    db.select().from(t.designSystemReleases).orderBy(desc(t.designSystemReleases.createdAt)),
  ])
  systems.clear()
  releasesBySystem.clear()
  for (const row of allSystems) {
    systems.set(row.name, row)
  }
  for (const rel of allReleases) {
    let byVer = releasesBySystem.get(rel.name)
    if (!byVer) {
      byVer = new Map()
      releasesBySystem.set(rel.name, byVer)
    }
    byVer.set(rel.version, rel)
  }
}

function sortedReleases(name: string): ReleaseRow[] {
  const map = releasesBySystem.get(name)
  if (!map) return []
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt)
}

function toReleaseSummary(row: ReleaseRow): DesignSystemReleaseSummary {
  return {
    version: row.version,
    files: row.files,
    totalBytes: row.totalBytes,
    notes: row.notes ?? null,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt,
    manifest: row.manifest,
  }
}

function toSummary(row: DsRow): DesignSystemSummary {
  const rels = sortedReleases(row.name)
  const latestRel = releasesBySystem.get(row.name)?.get(row.latestVersion) ?? rels[0]
  const origin = publicOrigin()
  return {
    name: row.name,
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    description: row.description,
    latestVersion: row.latestVersion,
    manifest: row.manifest,
    latestFiles: latestRel?.files ?? [],
    latestTotalBytes: latestRel?.totalBytes ?? 0,
    releaseCount: rels.length,
    versions: rels.map((r) => r.version),
    latestBaseUrl: `${origin}/ds/${row.name}/latest`,
    versionedBaseUrl: `${origin}/ds/${row.name}/${row.latestVersion}`,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function getRegisteredDesignSystem(name: string): DsRow | undefined {
  const valid = validateDsName(name)
  return valid ? systems.get(valid) : undefined
}

export function getRegisteredRelease(name: string, versionOrLatest: string): ReleaseRow | undefined {
  const validName = validateDsName(name)
  if (!validName) return undefined
  const ds = systems.get(validName)
  if (!ds) return undefined
  const version = versionOrLatest === 'latest' ? ds.latestVersion : versionOrLatest
  return releasesBySystem.get(validName)?.get(version)
}

export function listDesignSystemsForWorkspaces(workspaceIds: string[]): DesignSystemSummary[] {
  const allowed = new Set(workspaceIds)
  return [...systems.values()]
    .filter((row) => allowed.has(row.workspaceId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toSummary)
}

export function listDesignSystemsForUser(userId: string, workspaceId?: string): DesignSystemSummary[] {
  if (workspaceId) {
    if (!workspaces.isWorkspaceMember(workspaceId, userId)) {
      throw new DesignSystemError('you are not a member of this workspace', 403)
    }
    return listDesignSystemsForWorkspaces([workspaceId])
  }
  return listDesignSystemsForWorkspaces(workspaces.workspaceIdsFor(userId))
}

export function getDesignSystemDetailForUser(name: string, userId: string): DesignSystemDetail | null {
  const valid = validateDsName(name)
  if (!valid) return null
  const row = systems.get(valid)
  if (!row) return null
  if (!workspaces.isWorkspaceMember(row.workspaceId, userId)) {
    throw new DesignSystemError('you are not a member of the workspace that owns this design system', 403)
  }
  return {
    ...toSummary(row),
    releases: sortedReleases(row.name).map(toReleaseSummary),
  }
}

/** Resolve and validate which workspace owns a publish/mutation request. */
export function resolveAuthorizedWorkspace(
  name: string,
  userId: string | undefined,
  requestedWorkspaceId?: string,
): string {
  if (!userId) {
    throw new DesignSystemError('authentication required — only workspace members may publish design systems', 401)
  }
  const existing = systems.get(name)
  if (existing) {
    if (requestedWorkspaceId && requestedWorkspaceId !== existing.workspaceId) {
      throw new DesignSystemError(
        `design system "${name}" belongs to workspace ${existing.workspaceId}, not ${requestedWorkspaceId}`,
        403,
      )
    }
    if (!workspaces.isWorkspaceMember(existing.workspaceId, userId)) {
      throw new DesignSystemError('only members of the owning workspace may publish to this design system', 403)
    }
    return existing.workspaceId
  }

  if (requestedWorkspaceId) {
    const ws = workspaces.getWorkspace(requestedWorkspaceId)
    if (!ws || !workspaces.isWorkspaceMember(ws.id, userId)) {
      throw new DesignSystemError(`you are not a member of workspace "${requestedWorkspaceId}"`, 403)
    }
    return ws.id
  }

  const memberIds = workspaces.workspaceIdsFor(userId)
  if (memberIds.length === 0) {
    throw new DesignSystemError(
      'only workspace members may publish design systems — join or create a workspace first',
      403,
    )
  }
  if (memberIds.length === 1) return memberIds[0]!
  const names = memberIds.map((id) => `${id} (${workspaces.getWorkspace(id)?.name ?? id})`).join(', ')
  throw new DesignSystemError(
    `multiple workspaces found (${names}); pass workspace_id to choose which workspace owns "${name}"`,
    400,
  )
}

export interface PublishFileInput {
  path: string
  buffer: Buffer
}

export interface PublishReleaseOptions {
  name: string
  version: string
  userId: string
  workspaceId?: string
  files: PublishFileInput[]
  manifest?: PartialManifestInput
  notes?: string
  overwrite?: boolean
}

export interface PublishReleaseResult {
  designSystem: DesignSystemSummary
  release: DesignSystemReleaseSummary
  latestUrls: Record<string, string>
  versionedUrls: Record<string, string>
}

function validateAndSummarizeFiles(files: PublishFileInput[]): {
  normalized: Array<{ path: string; buffer: Buffer; meta: DesignSystemFileMeta }>
  totalBytes: number
} {
  if (files.length === 0) {
    throw new DesignSystemError('at least one file is required to publish a design system release', 400)
  }
  if (files.length > DS_MAX_FILES_PER_RELEASE) {
    throw new DesignSystemError(`at most ${DS_MAX_FILES_PER_RELEASE} files allowed per release`, 400)
  }
  const seen = new Set<string>()
  const normalized: Array<{ path: string; buffer: Buffer; meta: DesignSystemFileMeta }> = []
  let totalBytes = 0

  for (const file of files) {
    const safePath = sanitizeDsFilePath(file.path)
    if (!safePath) {
      throw new DesignSystemError(
        `invalid or unsupported file path "${file.path}" (allowed: .css, .js, .mjs, .json, .d.ts, .ts, .md, .txt, .svg, .woff2, .woff, .ttf, .otf, .png, .jpg, .webp)`,
        400,
      )
    }
    if (seen.has(safePath)) {
      throw new DesignSystemError(`duplicate file path "${safePath}" in release`, 400)
    }
    seen.add(safePath)
    if (file.buffer.length === 0) {
      throw new DesignSystemError(`file "${safePath}" is empty`, 400)
    }
    if (file.buffer.length > DS_MAX_FILE_BYTES) {
      throw new DesignSystemError(
        `file "${safePath}" (${file.buffer.length} bytes) exceeds the ${DS_MAX_FILE_BYTES / 1024 / 1024} MB single-file limit`,
        413,
      )
    }
    totalBytes += file.buffer.length
    if (totalBytes > DS_MAX_RELEASE_BYTES) {
      throw new DesignSystemError(`release total size exceeds the ${DS_MAX_RELEASE_BYTES / 1024 / 1024} MB limit`, 413)
    }
    const mime = mimeForDsFile(safePath)!
    const sha256 = createHash('sha256').update(file.buffer).digest('hex')
    normalized.push({
      path: safePath,
      buffer: file.buffer,
      meta: { path: safePath, bytes: file.buffer.length, sha256, contentType: mime.type },
    })
  }
  normalized.sort((a, b) => a.path.localeCompare(b.path))
  return { normalized, totalBytes }
}

function validateManifestInput(manifest?: PartialManifestInput): void {
  if (!manifest) return
  if (manifest.docs?.guideMarkdown && manifest.docs.guideMarkdown.length > DS_MAX_GUIDE_CHARS) {
    throw new DesignSystemError(`guide_markdown exceeds ${DS_MAX_GUIDE_CHARS} characters`, 400)
  }
  if (manifest.runtime?.globalName && !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(manifest.runtime.globalName)) {
    throw new DesignSystemError(`invalid runtime.globalName "${manifest.runtime.globalName}"`, 400)
  }
  for (const list of [manifest.runtime?.stylesheets, manifest.runtime?.scripts]) {
    if (!list) continue
    for (const entry of list) {
      if (!sanitizeDsFilePath(entry)) {
        throw new DesignSystemError(`invalid manifest asset path "${entry}"`, 400)
      }
    }
  }
}

export async function publishRelease(opts: PublishReleaseOptions): Promise<PublishReleaseResult> {
  const name = validateDsName(opts.name)
  if (!name) {
    throw new DesignSystemError(
      `invalid design system name "${opts.name}" (use lowercase letters, digits, hyphens/underscores; reserved: latest, _runtime, runtime)`,
      400,
    )
  }
  const version = validateDsVersion(opts.version)
  if (!version) {
    throw new DesignSystemError(
      `invalid version "${opts.version}" (use letters, digits, dots, hyphens/underscores; "latest" is reserved)`,
      400,
    )
  }
  validateManifestInput(opts.manifest)
  const { normalized, totalBytes } = validateAndSummarizeFiles(opts.files)

  return inDsOrder(name, async () => {
    const workspaceId = resolveAuthorizedWorkspace(name, opts.userId, opts.workspaceId)
    const existingDs = systems.get(name)
    const existingRel = releasesBySystem.get(name)?.get(version)
    if (existingRel && !opts.overwrite) {
      throw new DesignSystemError(
        `version "${version}" of "${name}" already exists (versions are immutable; bump version or pass overwrite=true)`,
        409,
      )
    }

    const manifest = resolveDesignSystemManifest(
      name,
      normalized.map((f) => f.path),
      opts.manifest,
      existingDs?.manifest,
    )

    // Write every object to unified storage before touching DB metadata.
    for (const file of normalized) {
      await storage.putObject(dsStorageKey(name, version, file.path), file.buffer, file.meta.contentType)
    }

    // If overwriting an existing version, delete any stale objects that were removed.
    if (existingRel) {
      const nextPaths = new Set(normalized.map((f) => f.path))
      for (const oldFile of existingRel.files) {
        if (!nextPaths.has(oldFile.path)) {
          await storage.deleteObject(dsStorageKey(name, version, oldFile.path)).catch(() => {})
        }
      }
    }

    const now = Date.now()
    const releaseRow: ReleaseRow = {
      name,
      version,
      manifest,
      files: normalized.map((f) => f.meta),
      totalBytes,
      notes: opts.notes?.trim() || null,
      publishedBy: opts.userId,
      createdAt: now,
    }

    const dsRow: DsRow = {
      name,
      workspaceId,
      displayName: manifest.displayName || name,
      description: manifest.description || '',
      latestVersion: version,
      manifest,
      createdBy: existingDs?.createdBy ?? opts.userId,
      updatedBy: opts.userId,
      createdAt: existingDs?.createdAt ?? now,
      updatedAt: now,
    }

    await db.transaction(async (tx) => {
      if (existingRel) {
        await tx
          .update(t.designSystemReleases)
          .set({
            manifest: releaseRow.manifest,
            files: releaseRow.files,
            totalBytes: releaseRow.totalBytes,
            notes: releaseRow.notes,
            publishedBy: releaseRow.publishedBy,
            createdAt: releaseRow.createdAt,
          })
          .where(and(eq(t.designSystemReleases.name, name), eq(t.designSystemReleases.version, version)))
      } else {
        await tx.insert(t.designSystemReleases).values(releaseRow)
      }

      if (existingDs) {
        await tx
          .update(t.designSystems)
          .set({
            displayName: dsRow.displayName,
            description: dsRow.description,
            latestVersion: dsRow.latestVersion,
            manifest: dsRow.manifest,
            updatedBy: dsRow.updatedBy,
            updatedAt: dsRow.updatedAt,
          })
          .where(eq(t.designSystems.name, name))
      } else {
        await tx.insert(t.designSystems).values(dsRow)
      }
    })

    systems.set(name, dsRow)
    let byVer = releasesBySystem.get(name)
    if (!byVer) {
      byVer = new Map()
      releasesBySystem.set(name, byVer)
    }
    byVer.set(version, releaseRow)
    notifyChanged(name)

    const origin = publicOrigin()
    const latestUrls: Record<string, string> = {}
    const versionedUrls: Record<string, string> = {}
    for (const file of normalized) {
      latestUrls[file.path] = `${origin}/ds/${name}/latest/${file.path}`
      versionedUrls[file.path] = `${origin}/ds/${name}/${version}/${file.path}`
    }

    return {
      designSystem: toSummary(dsRow),
      release: toReleaseSummary(releaseRow),
      latestUrls,
      versionedUrls,
    }
  })
}

export async function rollbackDesignSystem(
  rawName: string,
  rawVersion: string,
  userId: string | undefined,
): Promise<DesignSystemSummary> {
  const name = validateDsName(rawName)
  if (!name) throw new DesignSystemError(`invalid design system name "${rawName}"`, 400)
  const version = validateDsVersion(rawVersion)
  if (!version) throw new DesignSystemError(`invalid target version "${rawVersion}"`, 400)

  return inDsOrder(name, async () => {
    const existing = systems.get(name)
    if (!existing) throw new DesignSystemError(`design system "${name}" not found`, 404)
    resolveAuthorizedWorkspace(name, userId, existing.workspaceId)
    const targetRel = releasesBySystem.get(name)?.get(version)
    if (!targetRel) throw new DesignSystemError(`version "${version}" not found for "${name}"`, 404)

    const now = Date.now()
    const nextRow: DsRow = {
      ...existing,
      latestVersion: version,
      manifest: targetRel.manifest,
      displayName: targetRel.manifest.displayName || existing.displayName,
      description: targetRel.manifest.description ?? existing.description,
      updatedBy: userId!,
      updatedAt: now,
    }
    await db
      .update(t.designSystems)
      .set({
        latestVersion: nextRow.latestVersion,
        manifest: nextRow.manifest,
        displayName: nextRow.displayName,
        description: nextRow.description,
        updatedBy: nextRow.updatedBy,
        updatedAt: nextRow.updatedAt,
      })
      .where(eq(t.designSystems.name, name))
    systems.set(name, nextRow)
    notifyChanged(name)
    return toSummary(nextRow)
  })
}

export async function updateDesignSystemMeta(
  rawName: string,
  userId: string | undefined,
  patch: { displayName?: string; description?: string; guideMarkdown?: string },
): Promise<DesignSystemSummary> {
  const name = validateDsName(rawName)
  if (!name) throw new DesignSystemError(`invalid design system name "${rawName}"`, 400)
  if (patch.guideMarkdown !== undefined && patch.guideMarkdown.length > DS_MAX_GUIDE_CHARS) {
    throw new DesignSystemError(`guide_markdown exceeds ${DS_MAX_GUIDE_CHARS} characters`, 400)
  }

  return inDsOrder(name, async () => {
    const existing = systems.get(name)
    if (!existing) throw new DesignSystemError(`design system "${name}" not found`, 404)
    resolveAuthorizedWorkspace(name, userId, existing.workspaceId)

    const nextManifest: DesignSystemManifest = {
      ...existing.manifest,
      displayName: patch.displayName?.trim() || existing.displayName,
      description: patch.description !== undefined ? patch.description.trim() : existing.description,
      docs: {
        ...existing.manifest.docs,
        ...(patch.guideMarkdown !== undefined ? { guideMarkdown: patch.guideMarkdown } : {}),
      },
    }
    const now = Date.now()
    const nextRow: DsRow = {
      ...existing,
      displayName: nextManifest.displayName || existing.displayName,
      description: nextManifest.description ?? existing.description,
      manifest: nextManifest,
      updatedBy: userId!,
      updatedAt: now,
    }
    await db
      .update(t.designSystems)
      .set({
        displayName: nextRow.displayName,
        description: nextRow.description,
        manifest: nextRow.manifest,
        updatedBy: nextRow.updatedBy,
        updatedAt: nextRow.updatedAt,
      })
      .where(eq(t.designSystems.name, name))
    systems.set(name, nextRow)
    notifyChanged(name)
    return toSummary(nextRow)
  })
}

export async function deleteDesignSystemRelease(
  rawName: string,
  rawVersion: string,
  userId: string | undefined,
): Promise<boolean> {
  const name = validateDsName(rawName)
  if (!name) throw new DesignSystemError(`invalid design system name "${rawName}"`, 400)
  const version = validateDsVersion(rawVersion)
  if (!version) throw new DesignSystemError(`invalid version "${rawVersion}"`, 400)

  return inDsOrder(name, async () => {
    const existing = systems.get(name)
    if (!existing) return false
    resolveAuthorizedWorkspace(name, userId, existing.workspaceId)
    if (existing.latestVersion === version) {
      throw new DesignSystemError(
        `cannot delete active latest version "${version}" — rollback to another version first`,
        409,
      )
    }
    const rel = releasesBySystem.get(name)?.get(version)
    if (!rel) return false
    for (const file of rel.files) {
      await storage.deleteObject(dsStorageKey(name, version, file.path)).catch(() => {})
    }
    await db
      .delete(t.designSystemReleases)
      .where(and(eq(t.designSystemReleases.name, name), eq(t.designSystemReleases.version, version)))
    releasesBySystem.get(name)?.delete(version)
    notifyChanged(name)
    return true
  })
}

/** Read a file belonging to a registered design system release. Returns null if DS or file is absent. */
export async function readRegisteredAsset(
  name: string,
  versionOrLatest: string,
  relPath: string,
): Promise<{
  buffer: Buffer
  contentType: string
  compress: boolean
  resolvedVersion: string
  isLatest: boolean
} | null> {
  const validName = validateDsName(name)
  if (!validName) return null
  const ds = systems.get(validName)
  if (!ds) return null

  const isLatest = versionOrLatest === 'latest'
  const resolvedVersion = isLatest ? ds.latestVersion : versionOrLatest
  const rel = releasesBySystem.get(validName)?.get(resolvedVersion)
  if (!rel) return null
  const fileMeta = rel.files.find((f) => f.path === relPath)
  if (!fileMeta) return null
  const mime = mimeForDsFile(relPath)
  if (!mime) return null

  const buffer = await storage.getObject(dsStorageKey(validName, resolvedVersion, relPath))
  if (!buffer) return null
  return {
    buffer,
    contentType: mime.type,
    compress: mime.compress,
    resolvedVersion,
    isLatest,
  }
}

/* ------------------------------------------------------------------ */
/* Staged one-time publish tickets (PUT /ds-upload/:token/* + commit) */
/* ------------------------------------------------------------------ */

const TICKET_TTL_MS = 15 * 60 * 1000

interface PublishTicket {
  token: string
  name: string
  version: string
  workspaceId: string
  userId: string
  expectedFiles: string[]
  manifest?: PartialManifestInput
  notes?: string
  overwrite: boolean
  staged: Map<string, Buffer>
  totalBytes: number
  expiresAt: number
  committing: boolean
}

const publishTickets = new Map<string, PublishTicket>()

function purgeExpiredTickets(): void {
  const now = Date.now()
  for (const [token, ticket] of publishTickets) {
    if (ticket.expiresAt <= now && !ticket.committing) publishTickets.delete(token)
  }
}

export interface CreatePublishTicketOptions {
  name: string
  version: string
  userId: string | undefined
  workspaceId?: string
  expectedFiles?: string[]
  manifest?: PartialManifestInput
  notes?: string
  overwrite?: boolean
}

export interface PublishTicketResponse {
  token: string
  expiresAt: number
  name: string
  version: string
  workspaceId: string
  uploadBaseUrl: string
  commitUrl: string
  expectedFiles: string[]
  shellCommand: string
}

export function createPublishTicket(opts: CreatePublishTicketOptions): PublishTicketResponse {
  purgeExpiredTickets()
  const name = validateDsName(opts.name)
  if (!name) {
    throw new DesignSystemError(
      `invalid design system name "${opts.name}" (use lowercase letters, digits, hyphens/underscores)`,
      400,
    )
  }
  const version = validateDsVersion(opts.version)
  if (!version) {
    throw new DesignSystemError(`invalid version "${opts.version}" ("latest" is reserved)`, 400)
  }
  validateManifestInput(opts.manifest)
  const workspaceId = resolveAuthorizedWorkspace(name, opts.userId, opts.workspaceId)

  const existingRel = releasesBySystem.get(name)?.get(version)
  if (existingRel && !opts.overwrite) {
    throw new DesignSystemError(
      `version "${version}" of "${name}" already exists (versions are immutable; bump version or pass overwrite=true)`,
      409,
    )
  }

  const expectedFiles: string[] = []
  const seen = new Set<string>()
  for (const rawPath of opts.expectedFiles ?? []) {
    const safe = sanitizeDsFilePath(rawPath)
    if (!safe) {
      throw new DesignSystemError(`invalid or unsupported file path "${rawPath}"`, 400)
    }
    if (!seen.has(safe)) {
      seen.add(safe)
      expectedFiles.push(safe)
    }
  }
  if (expectedFiles.length > DS_MAX_FILES_PER_RELEASE) {
    throw new DesignSystemError(`at most ${DS_MAX_FILES_PER_RELEASE} files allowed per release`, 400)
  }

  const token = nanoid(32)
  const expiresAt = Date.now() + TICKET_TTL_MS
  publishTickets.set(token, {
    token,
    name,
    version,
    workspaceId,
    userId: opts.userId!,
    expectedFiles,
    manifest: opts.manifest,
    notes: opts.notes,
    overwrite: Boolean(opts.overwrite),
    staged: new Map(),
    totalBytes: 0,
    expiresAt,
    committing: false,
  })

  const origin = publicOrigin()
  const uploadBaseUrl = `${origin}/ds-upload/${token}`
  const commitUrl = `${uploadBaseUrl}/commit`
  const samplePaths =
    expectedFiles.length > 0 ? expectedFiles : ['tokens.css', 'components/bundle.css', 'components/bundle.js']
  const steps = [
    ...samplePaths.map((p) => `curl -fsS -T ./${p} "${uploadBaseUrl}/${p}"`),
    `curl -fsS -X POST "${commitUrl}"`,
  ]
  return {
    token,
    expiresAt,
    name,
    version,
    workspaceId,
    uploadBaseUrl,
    commitUrl,
    expectedFiles,
    shellCommand: steps.join(' && \\\n  '),
  }
}

export function getActivePublishTicket(token: string): PublishTicket | null {
  purgeExpiredTickets()
  const ticket = publishTickets.get(token)
  if (!ticket || ticket.expiresAt <= Date.now() || ticket.committing) return null
  return ticket
}

export function stageTicketFile(
  token: string,
  rawRelPath: string,
  buffer: Buffer,
): { path: string; bytes: number; sha256: string; stagedCount: number; expectedCount: number } {
  const ticket = getActivePublishTicket(token)
  if (!ticket) {
    throw new DesignSystemError(
      'invalid, expired, or already-committed publish ticket — request a new one via publish_design_system_bundle',
      410,
    )
  }
  const safePath = sanitizeDsFilePath(rawRelPath)
  if (!safePath) {
    throw new DesignSystemError(`invalid or unsupported file path "${rawRelPath}"`, 400)
  }
  if (ticket.expectedFiles.length > 0 && !ticket.expectedFiles.includes(safePath)) {
    throw new DesignSystemError(
      `unexpected file "${safePath}" — declared files for this ticket: ${ticket.expectedFiles.join(', ')}`,
      400,
    )
  }
  if (buffer.length === 0) {
    throw new DesignSystemError(`file "${safePath}" is empty`, 400)
  }
  if (buffer.length > DS_MAX_FILE_BYTES) {
    throw new DesignSystemError(
      `file "${safePath}" exceeds the ${DS_MAX_FILE_BYTES / 1024 / 1024} MB single-file limit`,
      413,
    )
  }
  const previousSize = ticket.staged.get(safePath)?.length ?? 0
  const nextTotal = ticket.totalBytes - previousSize + buffer.length
  if (nextTotal > DS_MAX_RELEASE_BYTES) {
    throw new DesignSystemError(`release total size exceeds the ${DS_MAX_RELEASE_BYTES / 1024 / 1024} MB limit`, 413)
  }
  if (!ticket.staged.has(safePath) && ticket.staged.size >= DS_MAX_FILES_PER_RELEASE) {
    throw new DesignSystemError(`at most ${DS_MAX_FILES_PER_RELEASE} files allowed per release`, 400)
  }
  ticket.staged.set(safePath, buffer)
  ticket.totalBytes = nextTotal
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  return {
    path: safePath,
    bytes: buffer.length,
    sha256,
    stagedCount: ticket.staged.size,
    expectedCount: ticket.expectedFiles.length,
  }
}

export async function commitPublishTicket(token: string): Promise<PublishReleaseResult> {
  const ticket = getActivePublishTicket(token)
  if (!ticket) {
    throw new DesignSystemError(
      'invalid, expired, or already-committed publish ticket — request a new one via publish_design_system_bundle',
      410,
    )
  }
  const missing = ticket.expectedFiles.filter((p) => !ticket.staged.has(p))
  if (missing.length > 0) {
    throw new DesignSystemError(`cannot commit: missing declared file(s): ${missing.join(', ')}`, 400)
  }
  if (ticket.staged.size === 0) {
    throw new DesignSystemError('cannot commit: no files have been uploaded to this ticket yet', 400)
  }

  ticket.committing = true
  try {
    const files: PublishFileInput[] = [...ticket.staged.entries()].map(([path, buffer]) => ({ path, buffer }))
    const result = await publishRelease({
      name: ticket.name,
      version: ticket.version,
      userId: ticket.userId,
      workspaceId: ticket.workspaceId,
      files,
      manifest: ticket.manifest,
      notes: ticket.notes,
      overwrite: ticket.overwrite,
    })
    publishTickets.delete(token)
    return result
  } catch (e) {
    ticket.committing = false
    throw e
  }
}

/* ------------------------------------------------------------------ */
/* Built-in same-origin shared runtimes (/ds/_runtime/...)            */
/* ------------------------------------------------------------------ */

const nodeRequire = createRequire(import.meta.url)

const BUILTIN_RUNTIME_SPECS: Record<string, { pkg: string; rel: string }> = {
  'react-18/react.production.min.js': { pkg: 'react', rel: 'umd/react.production.min.js' },
  'react-18/react-dom.production.min.js': { pkg: 'react-dom', rel: 'umd/react-dom.production.min.js' },
  'react-18/react.development.js': { pkg: 'react', rel: 'umd/react.development.js' },
  'react-18/react-dom.development.js': { pkg: 'react-dom', rel: 'umd/react-dom.development.js' },
}

const builtinCache = new Map<string, Buffer>()

export async function readBuiltinRuntimeAsset(
  runtimeSubpath: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const spec = BUILTIN_RUNTIME_SPECS[runtimeSubpath]
  if (!spec) return null
  const cached = builtinCache.get(runtimeSubpath)
  if (cached) return { buffer: cached, contentType: 'application/javascript; charset=utf-8' }
  try {
    const pkgJson = nodeRequire.resolve(`${spec.pkg}/package.json`)
    const filePath = path.join(path.dirname(pkgJson), spec.rel)
    const buffer = await fs.readFile(filePath)
    builtinCache.set(runtimeSubpath, buffer)
    return { buffer, contentType: 'application/javascript; charset=utf-8' }
  } catch {
    return null
  }
}
