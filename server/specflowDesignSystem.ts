import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import type { Request, Response } from 'express'
import { env } from './env.ts'
import {
  getRegisteredDesignSystem,
  getRegisteredRelease,
  onDesignSystemChanged,
  readBuiltinRuntimeAsset,
  readRegisteredAsset,
} from './designSystemRegistry.ts'
import { mimeForDsFile, type DesignSystemManifest } from '../shared/designSystems.ts'

/**
 * Self-hosted Multi-Design-System Runtime & Static Host for Doop:
 * 1. Same-origin `/ds/*` static host:
 *    - `/ds/_runtime/*`: built-in shared runtimes (React 18.3.1 UMD from node_modules)
 *      so sandboxed frames AND server-side Chromium screenshots (`guardPublicPageRequests`)
 *      work reliably with zero external CDN dependencies.
 *    - `/ds/<name>/<version|latest>/*`: served from Doop's first-class Design System Registry
 *      (PostgreSQL metadata + `server/storage.ts`) with in-memory gzip LRU caching, CORS `*`,
 *      CORP `cross-origin`, ETag/304, and instant cache eviction on publish/rollback.
 *    - Transparent upstream proxy fallback (`DOOP_DS_UPSTREAM_BASE`) for legacy externally
 *      hosted design systems (e.g. SpecFlow in Azure Blob) not yet migrated to the registry.
 * 2. Server-side JSX -> ES2020 JS compilation via esbuild + FRAME_BOOTSTRAP-safe real-component
 *    HTML shell (`create_ds_frame` / `update_ds_frame` and legacy `create_specflow_frame`).
 * 3. Live design-system catalog reader (`get_design_system`) supporting `overview`, `components`,
 *    `tokens` (with automatic `tokens.css` CSS variable parsing fallback), and `guide`.
 */

const DEFAULT_UPSTREAM_BASE = 'https://storage.googleapis.com/specflow-design-systems-2611/ds'
const LATEST_TTL_MS = 60_000
const PINNED_TTL_MS = 3_600_000
const MAX_CACHE_ENTRIES = 128
const FETCH_TIMEOUT_MS = 20_000
const MAX_UPSTREAM_ASSET_BYTES = 25 * 1024 * 1024

interface CachedAsset {
  raw: Buffer
  gzip?: Buffer
  contentType: string
  etag: string
  cacheControl: string
  expiresAt: number
}

const assetCache = new Map<string, CachedAsset>()

export function invalidateDesignSystemCache(name?: string): void {
  if (!name) {
    assetCache.clear()
    return
  }
  const prefix = `${name}/`
  for (const key of [...assetCache.keys()]) {
    if (key.startsWith(prefix)) assetCache.delete(key)
  }
}

onDesignSystemChanged((name) => {
  invalidateDesignSystemCache(name)
})

export function dsUpstreamBase(): string {
  return (env.DOOP_DS_UPSTREAM_BASE || DEFAULT_UPSTREAM_BASE).replace(/\/+$/, '')
}

export function defaultDsName(): string {
  return (env.DOOP_DS_NAME || 'specflow').replace(/[^a-z0-9_-]/gi, '') || 'specflow'
}

export function defaultDsBaseUrl(dsName = defaultDsName(), version = 'latest'): string {
  const origin = new URL(env.BETTER_AUTH_URL).origin
  return `${origin}/ds/${dsName}/${version}`
}

function trustedAssetPrefixes(): string[] {
  const origin = new URL(env.BETTER_AUTH_URL).origin
  return [`${origin}/ds/`, ...env.DOOP_TRUSTED_ASSET_PREFIXES]
}

export function validateDsBaseUrl(raw?: string, dsName = defaultDsName(), version = 'latest'): string {
  const candidate = (raw?.trim() || defaultDsBaseUrl(dsName, version)).replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Invalid ds_base_url: ${candidate}`)
  }
  const normalized = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
  const allowed = trustedAssetPrefixes().some((prefix) => `${normalized}/`.startsWith(prefix))
  if (!allowed) {
    throw new Error(`ds_base_url must match this server's /ds/ proxy or DOOP_TRUSTED_ASSET_PREFIXES`)
  }
  return normalized
}

function sanitizeSubpath(raw: string): string | null {
  const trimmed = raw.replace(/^\/+/, '')
  if (!trimmed || trimmed.length > 240) return null
  if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(trimmed)) return null
  const segments = trimmed.split('/')
  if (segments.some((s) => s === '.' || s === '..')) return null
  return trimmed
}

function putInCache(key: string, entry: CachedAsset): CachedAsset {
  if (assetCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = assetCache.keys().next().value
    if (oldestKey) assetCache.delete(oldestKey)
  }
  assetCache.set(key, entry)
  return entry
}

function buildCachedEntry(
  raw: Buffer,
  contentType: string,
  compress: boolean,
  isLatest: boolean,
  now: number,
): CachedAsset {
  const gzip = compress ? gzipSync(raw, { level: 6 }) : undefined
  const etag = `"${createHash('sha1').update(raw).digest('hex').slice(0, 16)}"`
  const ttlMs = isLatest ? LATEST_TTL_MS : PINNED_TTL_MS
  const cacheControl = isLatest
    ? 'public, max-age=60, stale-while-revalidate=30'
    : 'public, max-age=31536000, immutable'
  return { raw, gzip, contentType, etag, cacheControl, expiresAt: now + ttlMs }
}

async function resolveAsset(subpath: string): Promise<CachedAsset | null> {
  const now = Date.now()
  const hit = assetCache.get(subpath)
  if (hit && hit.expiresAt > now) {
    assetCache.delete(subpath)
    assetCache.set(subpath, hit)
    return hit
  }

  // 1. Built-in same-origin shared runtimes (/ds/_runtime/...)
  if (subpath.startsWith('_runtime/')) {
    const runtimeRel = subpath.slice('_runtime/'.length)
    const runtime = await readBuiltinRuntimeAsset(runtimeRel)
    if (!runtime) return null
    return putInCache(subpath, buildCachedEntry(runtime.buffer, runtime.contentType, true, false, now))
  }

  const mime = mimeForDsFile(subpath)
  if (!mime) return null

  // 2. First-class Design System Registry (<name>/<version|latest>/<relpath>)
  const parts = subpath.split('/')
  if (parts.length >= 3) {
    const [dsName, versionOrLatest, ...rest] = parts
    const relPath = rest.join('/')
    if (dsName && versionOrLatest && relPath) {
      const dsRow = getRegisteredDesignSystem(dsName)
      // Dynamic runtime manifest endpoint used by `<doop-ds>` elements to load CSS/JS cleanly
      if (relPath === 'manifest.json') {
        if (dsRow) {
          const isLatest = versionOrLatest === 'latest'
          const rel = getRegisteredRelease(dsName, versionOrLatest)
          if (!rel) return null
          const manifest = isLatest ? dsRow.manifest : rel.manifest
          const payload = Buffer.from(
            JSON.stringify({
              name: dsRow.name,
              version: rel.version,
              displayName: manifest.displayName || dsRow.displayName,
              runtime: manifest.runtime,
              components: manifest.components ?? [],
            }),
            'utf8',
          )
          const entry = buildCachedEntry(payload, 'application/json; charset=utf-8', true, isLatest, now)
          if (isLatest) entry.cacheControl = 'no-cache'
          return putInCache(subpath, entry)
        }
        if (dsName === 'specflow') {
          const fallback = fallbackManifestFor('specflow')
          const payload = Buffer.from(
            JSON.stringify({
              name: 'specflow',
              version: versionOrLatest,
              displayName: fallback.displayName,
              runtime: fallback.runtime,
              components: [],
            }),
            'utf8',
          )
          return putInCache(
            subpath,
            buildCachedEntry(payload, 'application/json; charset=utf-8', true, versionOrLatest === 'latest', now),
          )
        }
      }
      if (dsRow) {
        const reg = await readRegisteredAsset(dsName, versionOrLatest, relPath)
        if (!reg) return null
        return putInCache(subpath, buildCachedEntry(reg.buffer, reg.contentType, reg.compress, reg.isLatest, now))
      }
    }
  }

  // 3. Read-through fallback to legacy upstream (e.g. externally hosted SpecFlow in Azure Blob / GCS)
  const upstreamUrl = `${dsUpstreamBase()}/${subpath}`
  const res = await fetch(upstreamUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Accept-Encoding': 'gzip, identity' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Upstream DS fetch failed (${res.status}) for ${subpath}`)

  const arr = await res.arrayBuffer()
  if (arr.byteLength > MAX_UPSTREAM_ASSET_BYTES) {
    throw new Error(`Upstream DS asset exceeds size cap: ${subpath}`)
  }
  const raw = Buffer.from(arr)
  const isLatest = subpath.includes('/latest/')
  return putInCache(subpath, buildCachedEntry(raw, mime.type, mime.compress, isLatest, now))
}

/** Express handler for GET /ds/* (and HEAD / OPTIONS /ds/*). */
export async function serveDesignSystemAsset(req: Request, res: Response): Promise<void> {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.set('Cross-Origin-Resource-Policy', 'cross-origin')
  res.set('X-Content-Type-Options', 'nosniff')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }

  const wildcard = (req.params as Record<string, string | undefined>)['0'] ?? ''
  const subpath = sanitizeSubpath(wildcard)
  if (!subpath) {
    res.status(400).json({ error: 'invalid design system asset path' })
    return
  }

  try {
    const asset = await resolveAsset(subpath)
    if (!asset) {
      res.status(404).end()
      return
    }
    res.set('Content-Type', asset.contentType)
    res.set('Cache-Control', asset.cacheControl)
    res.set('ETag', asset.etag)
    res.set('Vary', 'Accept-Encoding')

    if (req.headers['if-none-match'] === asset.etag) {
      res.status(304).end()
      return
    }

    const acceptsGzip =
      typeof req.headers['accept-encoding'] === 'string' && req.headers['accept-encoding'].includes('gzip')
    if (asset.gzip && acceptsGzip) {
      res.set('Content-Encoding', 'gzip')
      res.set('Content-Length', String(asset.gzip.length))
      if (req.method === 'HEAD') res.status(200).end()
      else res.status(200).send(asset.gzip)
      return
    }

    res.set('Content-Length', String(asset.raw.length))
    if (req.method === 'HEAD') res.status(200).end()
    else res.status(200).send(asset.raw)
  } catch (e) {
    console.error('[ds-proxy] fetch failed', subpath, e)
    res.status(502).json({ error: e instanceof Error ? e.message : 'design system proxy failed' })
  }
}

type EsbuildTransform = (
  input: string,
  options: {
    loader: 'jsx' | 'tsx'
    jsx: 'transform'
    jsxFactory: string
    jsxFragment: string
    target: string
    sourcefile: string
  },
) => Promise<{ code: string }>

let cachedTransform: EsbuildTransform | null = null

async function loadEsbuildTransform(): Promise<EsbuildTransform> {
  if (cachedTransform) return cachedTransform
  try {
    const mod = (await import('esbuild')) as { transform?: EsbuildTransform }
    if (typeof mod.transform === 'function') {
      cachedTransform = mod.transform
      return cachedTransform
    }
  } catch {
    // Fall through to createRequire resolution
  }
  const req = createRequire(import.meta.url)
  for (const resolver of [() => req('esbuild'), () => createRequire(req.resolve('tsx/package.json'))('esbuild')]) {
    try {
      const mod = resolver() as { transform?: EsbuildTransform }
      if (typeof mod.transform === 'function') {
        cachedTransform = mod.transform
        return cachedTransform
      }
    } catch {
      // Try next resolver
    }
  }
  throw new Error('esbuild transform API is unavailable on this server')
}

export async function compileSpecFlowJsx(jsxSource: string, title = 'artboard'): Promise<string> {
  const transform = await loadEsbuildTransform()
  const safeName = `${title.replace(/[^a-zA-Z0-9._-]/g, '_') || 'artboard'}.jsx`
  const result = await transform(jsxSource, {
    loader: 'jsx',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    target: 'es2020',
    sourcefile: safeName,
  })
  return result.code
}

function fallbackManifestFor(dsName: string): DesignSystemManifest {
  if (dsName === 'gonovus') {
    return {
      displayName: 'GoNovus Design System',
      runtime: {
        preset: 'react-18-umd',
        globalName: 'GoNovusA',
        stylesheets: ['tokens.css', 'components/bundle.css'],
        scripts: ['components/bundle.js'],
        bodyCss:
          'background: var(--bg-surface-base, var(--background, #ffffff)); color: var(--text-primary, var(--foreground, #111111)); font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Noto Sans CJK SC", "PingFang SC", sans-serif); -webkit-font-smoothing: antialiased;',
        darkClass: 'dark',
        themeAttr: 'data-theme',
      },
      docs: {
        tokensCssPath: 'tokens.css',
        dtsPath: 'components/index.d.ts',
        tokensJsonPath: 'tokens.json',
      },
    }
  }
  return {
    displayName: 'SpecFlow Design System',
    runtime: {
      preset: 'react-19-bundle',
      globalName: 'SpecFlow',
      extraGlobals: { Lucide: 'LucideReact' },
      stylesheets: ['tokens.css', 'components/bundle.css'],
      scripts: ['runtime/react-runtime.js', 'components/bundle.js'],
      bodyCss:
        'background: var(--background); color: var(--foreground); font-family: "Geist Variable", "Geist", "Noto Sans CJK SC", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif; -webkit-font-smoothing: antialiased;',
      darkClass: 'dark',
      themeAttr: 'data-theme',
    },
    docs: {
      dtsPath: 'components/index.d.ts',
      tokensJsonPath: 'tokens.json',
      tokensCssPath: 'tokens.css',
      conventionsPath: 'conventions.md',
    },
  }
}

function resolveManifestFor(dsName: string, version = 'latest'): DesignSystemManifest {
  const rel = getRegisteredRelease(dsName, version)
  if (rel) return rel.manifest
  const ds = getRegisteredDesignSystem(dsName)
  if (ds) return ds.manifest
  return fallbackManifestFor(dsName)
}

export interface WrapDesignSystemOptions {
  dsName?: string
  dsVersion?: string
  theme?: 'light' | 'dark'
  title?: string
  extraCss?: string
  dsBaseUrl?: string
}

export type WrapSpecFlowOptions = WrapDesignSystemOptions

/**
 * Compile pure React JSX (defining `function App()` or `function Artboard()`) into a
 * complete Doop FRAME_BOOTSTRAP-compatible HTML document that renders real components
 * from any hosted Design System over same-origin `/ds/*`.
 */
export async function wrapDesignSystemJsxHtml(jsxSource: string, opts: WrapDesignSystemOptions = {}): Promise<string> {
  const dsName = (opts.dsName || defaultDsName()).replace(/[^a-z0-9_-]/gi, '').toLowerCase() || defaultDsName()
  const dsVersion = opts.dsVersion?.trim() || 'latest'
  const manifest = resolveManifestFor(dsName, dsVersion)
  const theme = opts.theme === 'dark' ? 'dark' : 'light'
  const isDark = theme === 'dark'
  const title = opts.title || `${manifest.displayName || dsName} Artboard`
  const extraCss = opts.extraCss || ''
  const dsBaseUrl = validateDsBaseUrl(opts.dsBaseUrl, dsName, dsVersion)
  const origin = new URL(env.BETTER_AUTH_URL).origin
  const escapedTitle = title.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
  )
  const compiledJs = (await compileSpecFlowJsx(jsxSource, title)).replace(/<\/script/gi, '<\\/script')

  const scriptSteps: Array<{ url: string; checkExpr: string }> = []
  if (manifest.runtime.preset === 'react-18-umd') {
    scriptSteps.push(
      { url: `${origin}/ds/_runtime/react-18/react.production.min.js`, checkExpr: 'Boolean(window.React)' },
      { url: `${origin}/ds/_runtime/react-18/react-dom.production.min.js`, checkExpr: 'Boolean(window.ReactDOM)' },
    )
  }
  const bundleScripts = manifest.runtime.scripts
  for (let i = 0; i < bundleScripts.length; i++) {
    const rel = bundleScripts[i]!
    const url = `${dsBaseUrl}/${rel}`
    let checkExpr = 'true'
    if (rel.endsWith('react-runtime.js')) {
      checkExpr = 'Boolean(window.React && window.ReactDOM)'
    } else if (i === bundleScripts.length - 1 && manifest.runtime.globalName) {
      checkExpr = `Boolean(window[${JSON.stringify(manifest.runtime.globalName)}])`
    }
    scriptSteps.push({ url, checkExpr })
  }

  const preloadLinks = scriptSteps
    .map((s) => `  <link rel="preload" as="script" href="${s.url}" crossorigin="anonymous" />`)
    .join('\n')
  const stylesheetLinks = manifest.runtime.stylesheets
    .map((rel) => `  <link rel="stylesheet" href="${dsBaseUrl}/${rel}" />`)
    .join('\n')

  const globalBindings: string[] = []
  if (manifest.runtime.globalName) {
    const g = manifest.runtime.globalName
    globalBindings.push(`        const ${g} = window[${JSON.stringify(g)}] || {};`)
  }
  if (manifest.runtime.extraGlobals) {
    for (const [ident, winKey] of Object.entries(manifest.runtime.extraGlobals)) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident)) {
        globalBindings.push(`        const ${ident} = window[${JSON.stringify(winKey)}] || {};`)
      }
    }
  }

  const bodyCss =
    manifest.runtime.bodyCss ||
    'background: var(--background, var(--bg-surface-base, #ffffff)); color: var(--foreground, var(--text-primary, #111111)); font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Noto Sans CJK SC", "PingFang SC", sans-serif); -webkit-font-smoothing: antialiased;'
  const darkClass = manifest.runtime.darkClass || 'dark'
  const themeAttr = manifest.runtime.themeAttr || 'data-theme'

  const loadChainCode = scriptSteps.length
    ? scriptSteps
        .map((s, idx) =>
          idx === 0
            ? `      loadScriptOnce(${JSON.stringify(s.url)}, () => ${s.checkExpr})`
            : `        .then(() => loadScriptOnce(${JSON.stringify(s.url)}, () => ${s.checkExpr}))`,
        )
        .join('\n') +
      '\n        .then(mount)\n        .catch((err) => showErr(err && err.message ? err.message : String(err)));'
    : '      mount();'

  return `<!DOCTYPE html>
<html lang="zh-CN" class="${isDark ? darkClass : ''}" ${themeAttr}="${theme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedTitle}</title>
${preloadLinks}
${stylesheetLinks}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100%; }
    body {
      ${bodyCss}
    }
    ${extraCss}
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    (() => {
      let resolveReady;
      window.__doopReady = new Promise((r) => { resolveReady = r; });
      const done = () => { if (resolveReady) { const r = resolveReady; resolveReady = null; r(); } };

      const showErr = (msg) => {
        let el = document.getElementById("__sf_err");
        if (!el) {
          el = document.createElement("pre");
          el.id = "__sf_err";
          el.style.cssText = "padding:16px;margin:16px;border-radius:8px;background:#fee2e2;color:#991b1b;font-family:monospace;font-size:12px;white-space:pre-wrap;border:1px solid #fecaca;";
          document.body.prepend(el);
        }
        el.textContent += String(msg) + "\\n";
        done();
      };

      const loadScriptOnce = (url, check) => {
        if (check()) return Promise.resolve();
        window.__sfLoads = window.__sfLoads || {};
        if (window.__sfLoads[url]) return window.__sfLoads[url];
        window.__sfLoads[url] = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = url;
          s.crossOrigin = "anonymous";
          s.async = false;
          s.setAttribute("data-v-ran", "1");
          s.onload = () => (check() ? resolve() : reject(new Error("Loaded " + url + " but expected global is missing")));
          s.onerror = () => {
            delete window.__sfLoads[url];
            reject(new Error("Failed to load script: " + url));
          };
          (document.head || document.documentElement).appendChild(s);
        });
        return window.__sfLoads[url];
      };

      const runFactory = () => {
        const React = window.React;
        const { useState, useEffect, useMemo, useRef, Fragment } = React;
${globalBindings.join('\n')}

${compiledJs}

        const RootComp = typeof App !== "undefined" ? App : (typeof Artboard !== "undefined" ? Artboard : null);
        if (!RootComp) {
          throw new Error("JSX must define a top-level function App() or Artboard() component.");
        }
        return RootComp;
      };

      const mount = () => {
        try {
          const RootComp = runFactory();
          const React = window.React;
          class ArtboardErrorBoundary extends React.Component {
            constructor(props) {
              super(props);
              this.state = { error: null };
            }
            static getDerivedStateFromError(error) {
              return { error };
            }
            componentDidCatch(error) {
              showErr(error && error.stack ? error.stack : String(error));
            }
            render() {
              if (this.state.error) return null;
              return this.props.children;
            }
          }
          const renderInto = () => {
            const rootEl = document.getElementById("root");
            if (!rootEl) return;
            window.__sfMounting = true;
            if (window.__sfRoot) {
              try { window.__sfRoot.unmount(); } catch {}
              window.__sfRoot = null;
            }
            if (window.__sfHost && window.__sfHost.parentNode) {
              window.__sfHost.parentNode.removeChild(window.__sfHost);
            }
            const host = document.createElement("div");
            host.setAttribute("data-sf-host", "1");
            host.style.cssText = "width:100%;min-height:100%;";
            rootEl.appendChild(host);
            window.__sfHost = host;
            function ReadyWrapper() {
              React.useEffect(() => {
                window.__sfMounting = false;
                requestAnimationFrame(() => requestAnimationFrame(done));
              }, []);
              return React.createElement(
                ArtboardErrorBoundary,
                null,
                React.createElement(RootComp),
              );
            }
            window.__sfRoot = window.ReactDOM.createRoot(host);
            window.__sfRoot.render(React.createElement(ReadyWrapper));
            setTimeout(() => { window.__sfMounting = false; }, 150);
          };
          window.__sfMountCurrent = renderInto;
          renderInto();

          if (!window.__sfObserver) {
            window.__sfObserver = new MutationObserver(() => {
              if (window.__sfMounting) return;
              const rootEl = document.getElementById("root");
              if (rootEl && rootEl.childNodes.length === 0 && typeof window.__sfMountCurrent === "function") {
                setTimeout(() => {
                  const r = document.getElementById("root");
                  if (!window.__sfMounting && r && r.childNodes.length === 0) window.__sfMountCurrent();
                }, 16);
              }
            });
            window.__sfObserver.observe(document.body, { childList: true, subtree: true });
          }
        } catch (err) {
          showErr(err && err.stack ? err.stack : String(err));
        }
      };

${loadChainCode}
    })();
  </script>
</body>
</html>`
}

export async function wrapSpecFlowJsxHtml(jsxSource: string, opts: WrapSpecFlowOptions = {}): Promise<string> {
  return wrapDesignSystemJsxHtml(jsxSource, { ...opts, dsName: opts.dsName ?? 'specflow' })
}

function extractExportedSymbols(dts: string): string[] {
  const names = new Set<string>()
  for (const m of dts.matchAll(/^export\s+(?:declare\s+)?(?:const|function|class|var|let)\s+([A-Za-z0-9_$]+)/gm)) {
    if (m[1]) names.add(m[1])
  }
  for (const m of dts.matchAll(/^export\s*\{([^}]+)\}(?!\s*from)/gm)) {
    for (const part of (m[1] || '').split(',')) {
      const trimmed = part.trim()
      if (!trimmed || trimmed.startsWith('type ')) continue
      const asMatch = /\bas\s+([A-Za-z0-9_$]+)/.exec(trimmed)
      const name = asMatch ? asMatch[1] : trimmed.split(/\s+/)[0]
      if (name && /^[A-Za-z0-9_$]+$/.test(name)) names.add(name)
    }
  }
  return [...names].sort()
}

function extractMatchingDtsSections(dts: string, queries: string[], maxChars = 24_000): string {
  const sections = dts.split(/(?=^\/\/ ── [^\n]+ ──$)/m).filter((s) => s.startsWith('// ── '))
  const lowered = queries.map((q) => q.toLowerCase()).filter(Boolean)
  const matched: string[] = []
  let total = 0

  for (const section of sections) {
    const header = section.slice(0, section.indexOf('\n')).toLowerCase()
    const declMatches = [
      ...section.matchAll(/(?:export\s+)?(?:declare\s+)?(?:const|function|class|interface|type)\s+([A-Za-z0-9_$]+)/g),
    ].map((m) => (m[1] || '').toLowerCase())
    const hit =
      lowered.length === 0 ||
      lowered.some((q) => header.includes(q) || declMatches.some((sym) => sym === q || sym.includes(q)))
    if (!hit) continue

    const trimmed = section.trim()
    if (total + trimmed.length > maxChars) {
      matched.push(`/* ... truncated at ${maxChars} chars; narrow your query (e.g. "Button,Dialog") ... */`)
      break
    }
    matched.push(trimmed)
    total += trimmed.length + 2
  }
  return matched.join('\n\n')
}

function extractCssCustomProperties(css: string): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const m of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);/g)) {
    const k = m[1]?.trim()
    const v = m[2]?.trim()
    if (k && v && !(k in tokens)) tokens[k] = v
  }
  return tokens
}

export async function getDesignSystemCatalog(opts: {
  section?: 'overview' | 'components' | 'tokens' | 'guide'
  query?: string
  dsName?: string
  dsVersion?: string
}): Promise<Record<string, unknown>> {
  const dsName = (opts.dsName || defaultDsName()).replace(/[^a-z0-9_-]/gi, '').toLowerCase() || defaultDsName()
  const version = opts.dsVersion?.trim() || 'latest'
  const section = opts.section || 'overview'
  const baseUrl = defaultDsBaseUrl(dsName, version)
  const manifest = resolveManifestFor(dsName, version)
  const registered = getRegisteredDesignSystem(dsName)
  const release = getRegisteredRelease(dsName, version)

  if (section === 'guide') {
    if (manifest.docs?.guideMarkdown) {
      return { dsName, version: release?.version ?? version, baseUrl, section, guide: manifest.docs.guideMarkdown }
    }
    const convPath = manifest.docs?.conventionsPath || 'conventions.md'
    const convAsset = await resolveAsset(`${dsName}/${version}/${convPath}`)
    if (convAsset) {
      return {
        dsName,
        version: release?.version ?? version,
        baseUrl,
        section,
        guide: convAsset.raw.toString('utf8'),
      }
    }
    return {
      dsName,
      version: release?.version ?? version,
      baseUrl,
      section,
      guide: null,
      note: `No custom guideMarkdown or conventions.md stored for "${dsName}". Check get_guide({ topic: "${dsName}-components" }) or inspect runtime manifest in section="overview".`,
    }
  }

  if (section === 'tokens') {
    const tokJsonPath = manifest.docs?.tokensJsonPath || 'tokens.json'
    const tokAsset = await resolveAsset(`${dsName}/${version}/${tokJsonPath}`)
    if (tokAsset) {
      const parsed = JSON.parse(tokAsset.raw.toString('utf8')) as Record<string, unknown>
      if (!opts.query?.trim()) {
        return { dsName, version: release?.version ?? version, baseUrl, section, source: tokJsonPath, tokens: parsed }
      }
      const terms = opts.query
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      const filtered: Record<string, unknown> = {}
      const walk = (obj: unknown, prefix = '') => {
        if (!obj || typeof obj !== 'object') return
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const keyPath = prefix ? `${prefix}.${k}` : k
          if (terms.some((t) => keyPath.toLowerCase().includes(t))) {
            filtered[keyPath] = v
          } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            walk(v, keyPath)
          }
        }
      }
      walk(parsed)
      return { dsName, version: release?.version ?? version, baseUrl, section, query: opts.query, matches: filtered }
    }

    // Fallback: parse CSS custom properties directly from tokens.css
    const tokCssPath = manifest.docs?.tokensCssPath || 'tokens.css'
    const cssAsset = await resolveAsset(`${dsName}/${version}/${tokCssPath}`)
    if (!cssAsset) throw new Error(`Neither ${tokJsonPath} nor ${tokCssPath} found for design system "${dsName}"`)
    const cssTokens = extractCssCustomProperties(cssAsset.raw.toString('utf8'))
    if (!opts.query?.trim()) {
      return {
        dsName,
        version: release?.version ?? version,
        baseUrl,
        section,
        source: tokCssPath,
        tokenCount: Object.keys(cssTokens).length,
        tokens: cssTokens,
      }
    }
    const terms = opts.query
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const matches: Record<string, string> = {}
    for (const [k, v] of Object.entries(cssTokens)) {
      if (terms.some((t) => k.toLowerCase().includes(t) || v.toLowerCase().includes(t))) {
        matches[k] = v
      }
    }
    return {
      dsName,
      version: release?.version ?? version,
      baseUrl,
      section,
      source: tokCssPath,
      query: opts.query,
      matches,
    }
  }

  const dtsPath = manifest.docs?.dtsPath || 'components/index.d.ts'
  const dtsAsset = await resolveAsset(`${dsName}/${version}/${dtsPath}`)
  const dts = dtsAsset ? dtsAsset.raw.toString('utf8') : null
  const symbols = dts ? extractExportedSymbols(dts) : []

  if (section === 'components') {
    if (dts) {
      const queries = (opts.query || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const declarations = extractMatchingDtsSections(dts, queries)
      return {
        dsName,
        version: release?.version ?? version,
        baseUrl,
        section,
        query: opts.query || '*',
        totalExports: symbols.length,
        declarations:
          declarations || 'No matching component declarations found. Check section="overview" for exact export names.',
      }
    }
    const catPath = manifest.docs?.catalogPath || 'catalog.json'
    const catAsset = await resolveAsset(`${dsName}/${version}/${catPath}`)
    if (catAsset) {
      return {
        dsName,
        version: release?.version ?? version,
        baseUrl,
        section,
        source: catPath,
        catalog: JSON.parse(catAsset.raw.toString('utf8')) as unknown,
      }
    }
    return {
      dsName,
      version: release?.version ?? version,
      baseUrl,
      section,
      globalName: manifest.runtime.globalName,
      note: `No ${dtsPath} or ${catPath} uploaded for "${dsName}" yet. Load section="guide" or get_guide({ topic: "${dsName}-components" }) for component usage, or include components/index.d.ts in the next publish_design_system_bundle release.`,
    }
  }

  // overview
  const tokAsset = await resolveAsset(`${dsName}/${version}/${manifest.docs?.tokensJsonPath || 'tokens.json'}`)
  const tokenGroups = tokAsset ? Object.keys(JSON.parse(tokAsset.raw.toString('utf8')) as Record<string, unknown>) : []
  const origin = new URL(env.BETTER_AUTH_URL).origin
  const runtimeScripts = [
    ...(manifest.runtime.preset === 'react-18-umd'
      ? [
          `${origin}/ds/_runtime/react-18/react.production.min.js`,
          `${origin}/ds/_runtime/react-18/react-dom.production.min.js`,
        ]
      : []),
    ...manifest.runtime.scripts.map((s) => `${baseUrl}/${s}`),
  ]
  const stylesheets = manifest.runtime.stylesheets.map((s) => `${baseUrl}/${s}`)

  return {
    dsName,
    displayName: manifest.displayName || dsName,
    version: release?.version ?? version,
    latestVersion: registered?.latestVersion ?? 'upstream',
    baseUrl,
    section: 'overview',
    globalName: manifest.runtime.globalName,
    runtimePreset: manifest.runtime.preset,
    stylesheets,
    scripts: runtimeScripts,
    files: release?.files.map((f) => ({ path: f.path, bytes: f.bytes, contentType: f.contentType })) ?? undefined,
    totalExports: symbols.length,
    exportedSymbols: symbols,
    tokenGroups,
    usage: `Use create_ds_frame({ ds_name: "${dsName}", jsx }) to render real window.${manifest.runtime.globalName || dsName} components, or load stylesheets & scripts above directly in frame HTML.`,
  }
}
