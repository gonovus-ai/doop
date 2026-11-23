import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import type { Request, Response } from 'express'
import { env } from './env.ts'

/**
 * Self-hosted SpecFlow Design System runtime for Doop:
 * 1. Same-origin reverse proxy `/ds/*` backed by GCS with in-memory gzip caching and CORS `*`
 *    so sandboxed canvas iframes (`sandbox="allow-scripts"`, opaque origin `null`) load real
 *    components from Doop's own origin without third-party domain dependencies.
 * 2. Server-side JSX -> ES2020 JS compilation via esbuild + FRAME_BOOTSTRAP-safe real-component
 *    HTML shell (`create_specflow_frame` / `update_specflow_frame`).
 * 3. Live design-system catalog reader (`get_design_system`) for `index.d.ts` & `tokens.json`.
 */

const DEFAULT_UPSTREAM_BASE = 'https://storage.googleapis.com/specflow-design-systems-2611/ds'
const LATEST_TTL_MS = 60_000
const PINNED_TTL_MS = 3_600_000
const MAX_CACHE_ENTRIES = 64
const FETCH_TIMEOUT_MS = 20_000
const MAX_ASSET_BYTES = 25 * 1024 * 1024

const MIME_BY_EXT: Record<string, { type: string; compress: boolean }> = {
  '.js': { type: 'application/javascript; charset=utf-8', compress: true },
  '.mjs': { type: 'application/javascript; charset=utf-8', compress: true },
  '.css': { type: 'text/css; charset=utf-8', compress: true },
  '.json': { type: 'application/json; charset=utf-8', compress: true },
  '.ts': { type: 'text/plain; charset=utf-8', compress: true },
  '.md': { type: 'text/markdown; charset=utf-8', compress: true },
  '.txt': { type: 'text/plain; charset=utf-8', compress: true },
  '.svg': { type: 'image/svg+xml; charset=utf-8', compress: true },
  '.woff2': { type: 'font/woff2', compress: false },
  '.woff': { type: 'font/woff', compress: false },
  '.png': { type: 'image/png', compress: false },
  '.jpg': { type: 'image/jpeg', compress: false },
  '.jpeg': { type: 'image/jpeg', compress: false },
  '.webp': { type: 'image/webp', compress: false },
}

interface CachedAsset {
  raw: Buffer
  gzip?: Buffer
  contentType: string
  etag: string
  cacheControl: string
  expiresAt: number
}

const assetCache = new Map<string, CachedAsset>()

export function dsUpstreamBase(): string {
  return (env.DOOP_DS_UPSTREAM_BASE || DEFAULT_UPSTREAM_BASE).replace(/\/+$/, '')
}

export function defaultDsName(): string {
  return (env.DOOP_DS_NAME || 'specflow').replace(/[^a-z0-9_-]/gi, '') || 'specflow'
}

export function defaultDsBaseUrl(dsName = defaultDsName()): string {
  const origin = new URL(env.BETTER_AUTH_URL).origin
  return `${origin}/ds/${dsName}/latest`
}

function trustedAssetPrefixes(): string[] {
  const origin = new URL(env.BETTER_AUTH_URL).origin
  return [`${origin}/ds/`, ...env.DOOP_TRUSTED_ASSET_PREFIXES]
}

export function validateDsBaseUrl(raw?: string): string {
  const candidate = (raw?.trim() || defaultDsBaseUrl()).replace(/\/+$/, '')
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

function mimeFor(subpath: string): { type: string; compress: boolean } | null {
  const lower = subpath.toLowerCase()
  for (const [ext, info] of Object.entries(MIME_BY_EXT)) {
    if (lower.endsWith(ext)) return info
  }
  return null
}

async function fetchUpstreamAsset(subpath: string): Promise<CachedAsset | null> {
  const now = Date.now()
  const hit = assetCache.get(subpath)
  if (hit && hit.expiresAt > now) {
    // Refresh insertion order for simple LRU behavior
    assetCache.delete(subpath)
    assetCache.set(subpath, hit)
    return hit
  }

  const mime = mimeFor(subpath)
  if (!mime) return null

  const upstreamUrl = `${dsUpstreamBase()}/${subpath}`
  const res = await fetch(upstreamUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Accept-Encoding': 'gzip, identity' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Upstream DS fetch failed (${res.status}) for ${subpath}`)

  const arr = await res.arrayBuffer()
  if (arr.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`Upstream DS asset exceeds size cap: ${subpath}`)
  }
  const raw = Buffer.from(arr)
  const gzip = mime.compress ? gzipSync(raw, { level: 6 }) : undefined
  const etag = `"${createHash('sha1').update(raw).digest('hex').slice(0, 16)}"`
  const isLatest = subpath.includes('/latest/')
  const ttlMs = isLatest ? LATEST_TTL_MS : PINNED_TTL_MS
  const cacheControl = isLatest ? 'public, max-age=60' : 'public, max-age=31536000, immutable'

  const entry: CachedAsset = {
    raw,
    gzip,
    contentType: mime.type,
    etag,
    cacheControl,
    expiresAt: now + ttlMs,
  }
  if (assetCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = assetCache.keys().next().value
    if (oldestKey) assetCache.delete(oldestKey)
  }
  assetCache.set(subpath, entry)
  return entry
}

/** Express handler for GET /ds/* (and OPTIONS /ds/*). */
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

  const wildcard = (req.params as Record<string, string | undefined>)['0'] ?? ''
  const subpath = sanitizeSubpath(wildcard)
  if (!subpath) {
    res.status(400).json({ error: 'invalid design system asset path' })
    return
  }

  try {
    const asset = await fetchUpstreamAsset(subpath)
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

export interface WrapSpecFlowOptions {
  theme?: 'light' | 'dark'
  title?: string
  extraCss?: string
  dsBaseUrl?: string
}

/**
 * Compile pure React JSX (defining `function App()` or `function Artboard()`) into a
 * complete Doop FRAME_BOOTSTRAP-compatible HTML document that renders real components
 * from `window.SpecFlow` + React 19 runtime over same-origin `/ds/*`.
 */
export async function wrapSpecFlowJsxHtml(jsxSource: string, opts: WrapSpecFlowOptions = {}): Promise<string> {
  const theme = opts.theme === 'dark' ? 'dark' : 'light'
  const isDark = theme === 'dark'
  const title = opts.title || 'SpecFlow Artboard'
  const extraCss = opts.extraCss || ''
  const dsBaseUrl = validateDsBaseUrl(opts.dsBaseUrl)
  const escapedTitle = title.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
  )
  const compiledJs = (await compileSpecFlowJsx(jsxSource, title)).replace(/<\/script/gi, '<\\/script')
  const runtimeUrl = `${dsBaseUrl}/runtime/react-runtime.js`
  const bundleUrl = `${dsBaseUrl}/components/bundle.js`

  return `<!DOCTYPE html>
<html lang="zh-CN" class="${isDark ? 'dark' : ''}" data-theme="${theme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedTitle}</title>
  <link rel="preload" as="script" href="${runtimeUrl}" crossorigin="anonymous" />
  <link rel="preload" as="script" href="${bundleUrl}" crossorigin="anonymous" />
  <link rel="stylesheet" href="${dsBaseUrl}/tokens.css" />
  <link rel="stylesheet" href="${dsBaseUrl}/components/bundle.css" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100%; }
    body {
      background: var(--background);
      color: var(--foreground);
      font-family: "Geist Variable", "Geist", "Noto Sans CJK SC", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-font-smoothing: antialiased;
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
        const SpecFlow = window.SpecFlow || {};
        const Lucide = window.LucideReact || {};

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

      loadScriptOnce(${JSON.stringify(runtimeUrl)}, () => Boolean(window.React && window.ReactDOM))
        .then(() => loadScriptOnce(${JSON.stringify(bundleUrl)}, () => Boolean(window.SpecFlow)))
        .then(mount)
        .catch((err) => showErr(err && err.message ? err.message : String(err)));
    })();
  </script>
</body>
</html>`
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

export async function getDesignSystemCatalog(opts: {
  section?: 'overview' | 'components' | 'tokens'
  query?: string
  dsName?: string
}): Promise<Record<string, unknown>> {
  const dsName = (opts.dsName || defaultDsName()).replace(/[^a-z0-9_-]/gi, '') || defaultDsName()
  const section = opts.section || 'overview'
  const baseUrl = defaultDsBaseUrl(dsName)

  if (section === 'tokens') {
    const tokAsset = await fetchUpstreamAsset(`${dsName}/latest/tokens.json`)
    if (!tokAsset) throw new Error(`tokens.json not found for design system "${dsName}"`)
    const tokensText = tokAsset.raw.toString('utf8')
    const parsed = JSON.parse(tokensText) as Record<string, unknown>
    if (!opts.query?.trim()) {
      return { dsName, baseUrl, section, tokens: parsed }
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
    return { dsName, baseUrl, section, query: opts.query, matches: filtered }
  }

  const dtsAsset = await fetchUpstreamAsset(`${dsName}/latest/components/index.d.ts`)
  if (!dtsAsset) throw new Error(`components/index.d.ts not found for design system "${dsName}"`)
  const dts = dtsAsset.raw.toString('utf8')
  const symbols = extractExportedSymbols(dts)

  if (section === 'components') {
    const queries = (opts.query || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const declarations = extractMatchingDtsSections(dts, queries)
    return {
      dsName,
      baseUrl,
      section,
      query: opts.query || '*',
      totalExports: symbols.length,
      declarations:
        declarations || 'No matching component declarations found. Check section="overview" for exact export names.',
    }
  }

  // overview
  const tokAsset = await fetchUpstreamAsset(`${dsName}/latest/tokens.json`)
  const tokenGroups = tokAsset ? Object.keys(JSON.parse(tokAsset.raw.toString('utf8')) as Record<string, unknown>) : []
  return {
    dsName,
    baseUrl,
    section: 'overview',
    runtime:
      'React 19 + ReactDOM + LucideReact + window.SpecFlow (auto-loaded by create_specflow_frame / update_specflow_frame)',
    totalExports: symbols.length,
    exportedSymbols: symbols,
    tokenGroups,
    usage:
      'Call get_design_system({ section: "components", query: "Button,Dialog,StatusIndicator" }) to inspect exact TypeScript props before writing JSX, then call create_specflow_frame or update_specflow_frame with pure JSX defining function App(). Never invent non-existent SpecFlow.* exports.',
  }
}
