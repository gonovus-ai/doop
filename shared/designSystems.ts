/**
 * Shared types, limits, and path/name validation for Doop's Design System Registry.
 * Used by server/designSystemRegistry.ts, server/specflowDesignSystem.ts,
 * server/mcp.ts, server/designSystemRoutes.ts, and src/components/DesignSystems.tsx.
 */

export const DS_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const DS_RESERVED_NAMES: ReadonlySet<string> = new Set(['latest', '_runtime', 'runtime'])

export const DS_VERSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
export const DS_RESERVED_VERSIONS: ReadonlySet<string> = new Set(['latest'])

export const DS_MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB per file (>= 2 MB requirement)
export const DS_MAX_RELEASE_BYTES = 30 * 1024 * 1024 // 30 MB per release
export const DS_MAX_FILES_PER_RELEASE = 128
export const DS_MAX_GUIDE_CHARS = 32_000

export type DesignSystemRuntimePreset = 'react-18-umd' | 'react-19-bundle' | 'none'

export interface DesignSystemRuntimeConfig {
  /** Built-in shared runtime preset loaded before package scripts. */
  preset: DesignSystemRuntimePreset
  /** Global variable attached by the component bundle, e.g. "GoNovusA" or "SpecFlow". */
  globalName?: string
  /** Optional extra globals exposed in JSX scope: { localIdentifier: "WindowGlobalName" }. */
  extraGlobals?: Record<string, string>
  /** Ordered stylesheets relative to /ds/<name>/<version>/. */
  stylesheets: string[]
  /** Ordered scripts relative to /ds/<name>/<version>/ (loaded after preset runtime). */
  scripts: string[]
  /** Optional body CSS rules (font-family, background, color) for create_ds_frame. */
  bodyCss?: string
  /** Class added to <html> in dark mode (default "dark"). */
  darkClass?: string
  /** Attribute set on <html> with "light"|"dark" (default "data-theme"). */
  themeAttr?: string
}

export interface DesignSystemDocsConfig {
  dtsPath?: string
  tokensJsonPath?: string
  tokensCssPath?: string
  catalogPath?: string
  conventionsPath?: string
  /** Live editable usage guide markdown returned by get_design_system({ section: "guide" }). */
  guideMarkdown?: string
}

export interface DesignSystemManifest {
  displayName?: string
  description?: string
  runtime: DesignSystemRuntimeConfig
  docs?: DesignSystemDocsConfig
}

export interface DesignSystemFileMeta {
  path: string
  bytes: number
  sha256: string
  contentType: string
}

export interface DesignSystemReleaseSummary {
  version: string
  files: DesignSystemFileMeta[]
  totalBytes: number
  notes: string | null
  publishedBy: string
  createdAt: number
  manifest: DesignSystemManifest
}

export interface DesignSystemSummary {
  name: string
  workspaceId: string
  displayName: string
  description: string
  latestVersion: string
  manifest: DesignSystemManifest
  latestFiles: DesignSystemFileMeta[]
  latestTotalBytes: number
  releaseCount: number
  versions: string[]
  latestBaseUrl: string
  versionedBaseUrl: string
  createdBy: string
  updatedBy: string
  createdAt: number
  updatedAt: number
}

export interface DesignSystemDetail extends DesignSystemSummary {
  releases: DesignSystemReleaseSummary[]
}

export const DS_MIME_BY_EXT: ReadonlyArray<{ ext: string; type: string; compress: boolean }> = [
  { ext: '.d.ts', type: 'text/plain; charset=utf-8', compress: true },
  { ext: '.js', type: 'application/javascript; charset=utf-8', compress: true },
  { ext: '.mjs', type: 'application/javascript; charset=utf-8', compress: true },
  { ext: '.css', type: 'text/css; charset=utf-8', compress: true },
  { ext: '.json', type: 'application/json; charset=utf-8', compress: true },
  { ext: '.ts', type: 'text/plain; charset=utf-8', compress: true },
  { ext: '.md', type: 'text/markdown; charset=utf-8', compress: true },
  { ext: '.txt', type: 'text/plain; charset=utf-8', compress: true },
  { ext: '.svg', type: 'image/svg+xml; charset=utf-8', compress: true },
  { ext: '.woff2', type: 'font/woff2', compress: false },
  { ext: '.woff', type: 'font/woff', compress: false },
  { ext: '.ttf', type: 'font/ttf', compress: false },
  { ext: '.otf', type: 'font/otf', compress: false },
  { ext: '.png', type: 'image/png', compress: false },
  { ext: '.jpg', type: 'image/jpeg', compress: false },
  { ext: '.jpeg', type: 'image/jpeg', compress: false },
  { ext: '.webp', type: 'image/webp', compress: false },
]

export function mimeForDsFile(relPath: string): { type: string; compress: boolean } | null {
  const lower = relPath.toLowerCase()
  for (const entry of DS_MIME_BY_EXT) {
    if (lower.endsWith(entry.ext)) return { type: entry.type, compress: entry.compress }
  }
  return null
}

export function validateDsName(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!DS_NAME_RE.test(trimmed)) return null
  if (DS_RESERVED_NAMES.has(trimmed)) return null
  return trimmed
}

export function validateDsVersion(raw: string): string | null {
  const trimmed = raw.trim()
  if (!DS_VERSION_RE.test(trimmed)) return null
  if (DS_RESERVED_VERSIONS.has(trimmed.toLowerCase())) return null
  return trimmed
}

export function sanitizeDsFilePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+/, '')
  if (!trimmed || trimmed.length > 200) return null
  if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(trimmed)) return null
  const segments = trimmed.split('/')
  if (segments.some((s) => s === '.' || s === '..')) return null
  if (!mimeForDsFile(trimmed)) return null
  return trimmed
}

function defaultGlobalForName(name: string): string {
  if (name === 'gonovus') return 'GoNovusA'
  if (name === 'specflow') return 'SpecFlow'
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('')
}

function defaultDisplayName(name: string): string {
  if (name === 'gonovus') return 'GoNovus Design System'
  if (name === 'specflow') return 'SpecFlow Design System'
  return `${defaultGlobalForName(name)} Design System`
}

export interface PartialManifestInput {
  displayName?: string
  description?: string
  runtime?: Partial<DesignSystemRuntimeConfig>
  docs?: Partial<DesignSystemDocsConfig>
}

export function resolveDesignSystemManifest(
  name: string,
  filePaths: string[],
  input?: PartialManifestInput,
  previous?: DesignSystemManifest,
): DesignSystemManifest {
  const set = new Set(filePaths)
  const cssFiles = filePaths
    .filter((p) => p.endsWith('.css'))
    .sort((a, b) => {
      const aTok = a === 'tokens.css' || a.endsWith('/tokens.css') ? 0 : 1
      const bTok = b === 'tokens.css' || b.endsWith('/tokens.css') ? 0 : 1
      if (aTok !== bTok) return aTok - bTok
      return a.localeCompare(b)
    })
  const hasBundledReactRuntime = set.has('runtime/react-runtime.js')
  const bundleJs = filePaths.filter(
    (p) =>
      (p.endsWith('.js') || p.endsWith('.mjs')) && p !== 'runtime/babel.min.js' && p !== 'runtime/react-runtime.js',
  )
  const defaultScripts = [
    ...(hasBundledReactRuntime ? ['runtime/react-runtime.js'] : []),
    ...bundleJs.sort((a, b) => a.localeCompare(b)),
  ]
  const inferredPreset: DesignSystemRuntimePreset = hasBundledReactRuntime
    ? 'react-19-bundle'
    : bundleJs.length > 0
      ? 'react-18-umd'
      : 'none'

  const prevRuntime = previous?.runtime
  const inRuntime = input?.runtime

  const runtime: DesignSystemRuntimeConfig = {
    preset: inRuntime?.preset ?? prevRuntime?.preset ?? inferredPreset,
    globalName: inRuntime?.globalName ?? prevRuntime?.globalName ?? defaultGlobalForName(name),
    extraGlobals:
      inRuntime?.extraGlobals ??
      prevRuntime?.extraGlobals ??
      (name === 'specflow' ? { Lucide: 'LucideReact' } : undefined),
    stylesheets: inRuntime?.stylesheets?.length
      ? inRuntime.stylesheets
      : cssFiles.length > 0
        ? cssFiles
        : (prevRuntime?.stylesheets ?? []),
    scripts: inRuntime?.scripts?.length
      ? inRuntime.scripts
      : defaultScripts.length > 0
        ? defaultScripts
        : (prevRuntime?.scripts ?? []),
    bodyCss: inRuntime?.bodyCss ?? prevRuntime?.bodyCss,
    darkClass: inRuntime?.darkClass ?? prevRuntime?.darkClass ?? 'dark',
    themeAttr: inRuntime?.themeAttr ?? prevRuntime?.themeAttr ?? 'data-theme',
  }

  const prevDocs = previous?.docs
  const inDocs = input?.docs
  const docs: DesignSystemDocsConfig = {
    dtsPath: inDocs?.dtsPath ?? (set.has('components/index.d.ts') ? 'components/index.d.ts' : prevDocs?.dtsPath),
    tokensJsonPath: inDocs?.tokensJsonPath ?? (set.has('tokens.json') ? 'tokens.json' : prevDocs?.tokensJsonPath),
    tokensCssPath:
      inDocs?.tokensCssPath ?? (set.has('tokens.css') ? 'tokens.css' : (cssFiles[0] ?? prevDocs?.tokensCssPath)),
    catalogPath: inDocs?.catalogPath ?? (set.has('catalog.json') ? 'catalog.json' : prevDocs?.catalogPath),
    conventionsPath:
      inDocs?.conventionsPath ?? (set.has('conventions.md') ? 'conventions.md' : prevDocs?.conventionsPath),
    guideMarkdown: inDocs?.guideMarkdown !== undefined ? inDocs.guideMarkdown : prevDocs?.guideMarkdown,
  }

  return {
    displayName: input?.displayName?.trim() || previous?.displayName || defaultDisplayName(name),
    description: input?.description !== undefined ? input.description.trim() : (previous?.description ?? ''),
    runtime,
    docs,
  }
}
