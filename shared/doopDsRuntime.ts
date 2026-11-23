import { buildDoopDsTag } from './designSystems.ts'

/**
 * Universal zero-dependency browser runtime for `<doop-ds>` real-component elements.
 *
 * Shared across:
 * 1. `src/lib/frameRuntime.ts` (FRAME_BOOTSTRAP live canvas + PrototypePlayer)
 * 2. `server/screenshot.ts` (headless Chromium `get_frame_screenshot` + `inspect_frame`)
 * 3. `src/components/ComponentThumb.tsx` (Components panel live thumbnails)
 *
 * Behaviour:
 * - Discovers every `<doop-ds ds="..." component="..." version?="..." props='...'>` in the document.
 * - Deduplicates manifest fetches, CSS `<link>` loads, and JS `<script>` loads per `(ds, version)`
 *   so multiple `<doop-ds>` instances in one frame share a single runtime load.
 * - Mounts each `<doop-ds>` via `ReactDOM.createRoot` inside a `<span data-doop-ds-root="1">` child,
 *   wrapped in an ErrorBoundary and an interactive state adapter so controlled components (like Toggle,
 *   Switch, Checkbox) respond to clicks immediately even when configured via static JSON `props`.
 * - Updates in-place with zero flicker when `props` / `component` / `ds` / `version` attributes change.
 * - Exposes `window.__doopReady` resolving only after all `<doop-ds>` elements have finished loading
 *   styles, scripts, and painting their first React frame.
 */
export const DOOP_DS_RUNTIME_SCRIPT = `(function () {
  if (window.__doopSyncDs) return;
  var state = window.__doopDs || (window.__doopDs = {
    manifests: {},
    css: {},
    scripts: {},
    roots: new WeakMap(),
    baseStyleInjected: false
  });

  function getOrigin(override) {
    if (override && typeof override === 'string') {
      window.__doopDsOrigin = override.replace(/\\/+$/, '');
    }
    if (window.__doopDsOrigin) return window.__doopDsOrigin;
    try {
      var base = document.querySelector('base[href]');
      if (base) return new URL(base.getAttribute('href')).origin;
    } catch (e) {}
    try {
      if (location.origin && location.origin !== 'null') return location.origin;
    } catch (e) {}
    return '';
  }

  function ensureBaseStyle() {
    if (state.baseStyleInjected) return;
    state.baseStyleInjected = true;
    var st = document.createElement('style');
    st.setAttribute('data-doop-ds-asset', '1');
    st.textContent = 'doop-ds{display:inline-block;vertical-align:top;}doop-ds>[data-doop-ds-root]{display:contents;}';
    (document.head || document.documentElement).appendChild(st);
  }

  function loadCssOnce(url) {
    if (state.css[url]) return state.css[url];
    var existing = document.querySelector('link[rel="stylesheet"][href="' + url.replace(/"/g, '\\\\"') + '"]');
    if (existing) {
      state.css[url] = Promise.resolve();
      return state.css[url];
    }
    state.css[url] = new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.setAttribute('data-doop-ds-asset', '1');
      link.onload = function () { resolve(); };
      link.onerror = function () { resolve(); };
      (document.head || document.documentElement).appendChild(link);
    });
    return state.css[url];
  }

  function loadScriptOnce(url, checkFn) {
    if (checkFn && checkFn()) return Promise.resolve();
    if (state.scripts[url]) return state.scripts[url];
    state.scripts[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.crossOrigin = 'anonymous';
      s.async = false;
      s.setAttribute('data-doop-ds-asset', '1');
      s.setAttribute('data-v-ran', '1');
      s.onload = function () {
        if (!checkFn || checkFn()) resolve();
        else reject(new Error('Loaded ' + url + ' but expected global was missing'));
      };
      s.onerror = function () {
        delete state.scripts[url];
        reject(new Error('Failed to load ' + url));
      };
      (document.head || document.documentElement).appendChild(s);
    });
    return state.scripts[url];
  }

  function loadManifestOnce(origin, ds, version) {
    var key = origin + '|' + ds + '|' + version;
    if (state.manifests[key]) return state.manifests[key];
    var url = origin + '/ds/' + encodeURIComponent(ds) + '/' + encodeURIComponent(version) + '/manifest.json';
    state.manifests[key] = fetch(url, { mode: 'cors' })
      .then(function (res) {
        if (!res.ok) throw new Error('Manifest ' + res.status + ' for ' + ds + '@' + version);
        return res.json();
      })
      .catch(function (err) {
        delete state.manifests[key];
        throw err;
      });
    return state.manifests[key];
  }

  function ensureRuntimeLoaded(origin, ds, version) {
    return loadManifestOnce(origin, ds, version).then(function (manifest) {
      var resolvedVer = (manifest && manifest.version) || version;
      var base = origin + '/ds/' + encodeURIComponent(ds) + '/' + encodeURIComponent(resolvedVer);
      var rt = manifest.runtime || {};
      var cssList = Array.isArray(rt.stylesheets) ? rt.stylesheets : [];
      var cssPromises = cssList.map(function (rel) {
        return loadCssOnce(rel.indexOf('http') === 0 || rel.indexOf('/') === 0 ? rel : base + '/' + rel);
      });

      var scriptSteps = [];
      if (rt.preset === 'react-18-umd') {
        scriptSteps.push({
          url: origin + '/ds/_runtime/react-18/react.production.min.js',
          check: function () { return Boolean(window.React); }
        });
        scriptSteps.push({
          url: origin + '/ds/_runtime/react-18/react-dom.production.min.js',
          check: function () { return Boolean(window.ReactDOM); }
        });
      }
      var pkgScripts = Array.isArray(rt.scripts) ? rt.scripts : [];
      for (var i = 0; i < pkgScripts.length; i++) {
        var rel = pkgScripts[i];
        var fullUrl = rel.indexOf('http') === 0 || rel.indexOf('/') === 0 ? rel : base + '/' + rel;
        var isLast = i === pkgScripts.length - 1;
        var gName = rt.globalName;
        var check = rel.indexOf('react-runtime.js') !== -1
          ? function () { return Boolean(window.React && window.ReactDOM); }
          : (isLast && gName ? (function (gn) { return function () { return Boolean(window[gn]); }; })(gName) : null);
        scriptSteps.push({ url: fullUrl, check: check });
      }

      var scriptChain = scriptSteps.reduce(function (acc, step) {
        return acc.then(function () { return loadScriptOnce(step.url, step.check); });
      }, Promise.resolve());

      return Promise.all([Promise.all(cssPromises), scriptChain]).then(function () { return manifest; });
    });
  }

  function resolveExport(rootObj, exportPath) {
    if (!rootObj || !exportPath) return null;
    var parts = String(exportPath).split('.');
    var cur = rootObj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return null;
      cur = cur[parts[i]];
    }
    return cur || null;
  }

  function parseProps(raw) {
    if (!raw) return {};
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function showNodeError(el, msg) {
    el.innerHTML = '';
    var box = document.createElement('span');
    box.setAttribute('data-doop-ds-root', '1');
    box.style.cssText = 'display:inline-block;padding:4px 8px;border-radius:4px;background:#fee2e2;color:#991b1b;font:11px/1.4 monospace;border:1px solid #fecaca;';
    box.textContent = String(msg);
    el.appendChild(box);
  }

  function getHostComponents(React) {
    if (state.hostCache && state.hostCache.React === React) return state.hostCache;

    function ErrorBoundary(props) {
      React.Component.call(this, props);
      this.state = { err: null };
    }
    ErrorBoundary.prototype = Object.create(React.Component.prototype);
    ErrorBoundary.prototype.constructor = ErrorBoundary;
    ErrorBoundary.getDerivedStateFromError = function (err) { return { err: err }; };
    ErrorBoundary.prototype.componentDidUpdate = function (prevProps) {
      if (prevProps.resetKey !== this.props.resetKey && this.state.err) {
        this.setState({ err: null });
      }
    };
    ErrorBoundary.prototype.render = function () {
      if (this.state.err) {
        return React.createElement('span', {
          style: {
            display: 'inline-block', padding: '4px 8px', borderRadius: 4,
            background: '#fee2e2', color: '#991b1b', fontFamily: 'monospace', fontSize: 11
          }
        }, String(this.state.err && this.state.err.message ? this.state.err.message : this.state.err));
      }
      return this.props.children;
    };

    function InteractiveAdapter(p) {
      var Comp = p.Comp;
      var extProps = p.extProps;
      var pair = React.useState(extProps);
      var local = pair[0];
      var setLocal = pair[1];

      React.useEffect(function () {
        setLocal(extProps);
      }, [p.propsKey]);

      var merged = Object.assign({}, local);
      if (typeof merged.checked === 'boolean') {
        if (typeof merged.onCheckedChange !== 'function') {
          merged.onCheckedChange = function (next) {
            setLocal(function (prev) { return Object.assign({}, prev, { checked: Boolean(next) }); });
          };
        }
        if (typeof merged.onChange !== 'function') {
          merged.onChange = function (ev) {
            var next = typeof ev === 'boolean' ? ev : (ev && ev.target && typeof ev.target.checked === 'boolean' ? ev.target.checked : !merged.checked);
            setLocal(function (prev) { return Object.assign({}, prev, { checked: Boolean(next) }); });
          };
        }
      }
      if (typeof merged.pressed === 'boolean' && typeof merged.onPressedChange !== 'function') {
        merged.onPressedChange = function (next) {
          setLocal(function (prev) { return Object.assign({}, prev, { pressed: Boolean(next) }); });
        };
      }
      if (typeof merged.open === 'boolean' && typeof merged.onOpenChange !== 'function') {
        merged.onOpenChange = function (next) {
          setLocal(function (prev) { return Object.assign({}, prev, { open: Boolean(next) }); });
        };
      }
      if (typeof merged.value === 'string' && typeof merged.onValueChange !== 'function') {
        merged.onValueChange = function (next) {
          setLocal(function (prev) { return Object.assign({}, prev, { value: String(next) }); });
        };
      }
      if (typeof merged.value === 'string' && typeof merged.onChange !== 'function') {
        merged.onChange = function (ev) {
          var next = typeof ev === 'string' ? ev : (ev && ev.target && typeof ev.target.value === 'string' ? ev.target.value : null);
          if (next !== null) setLocal(function (prev) { return Object.assign({}, prev, { value: next }); });
        };
      }

      React.useEffect(function () {
        if (typeof p.onPainted === 'function') {
          requestAnimationFrame(function () { requestAnimationFrame(p.onPainted); });
        }
      }, [p.propsKey]);

      return React.createElement(
        ErrorBoundary,
        { resetKey: p.propsKey },
        React.createElement(Comp, merged)
      );
    }

    state.hostCache = { React: React, InteractiveAdapter: InteractiveAdapter };
    return state.hostCache;
  }

  function mountOne(el, origin) {
    var ds = (el.getAttribute('ds') || '').trim();
    var compName = (el.getAttribute('component') || '').trim();
    var version = (el.getAttribute('version') || 'latest').trim() || 'latest';
    var propsRaw = el.getAttribute('props') || '';
    if (!ds || !compName) return Promise.resolve();

    var sig = ds + '|' + version + '|' + compName + '|' + propsRaw;
    var existing = state.roots.get(el);
    if (existing && existing.sig === sig && existing.mountEl && existing.mountEl.parentNode === el) {
      return Promise.resolve();
    }

    return ensureRuntimeLoaded(origin, ds, version).then(function (manifest) {
      var React = window.React;
      var ReactDOM = window.ReactDOM;
      if (!React || !ReactDOM) throw new Error('React runtime missing for ' + ds);
      var globalName = manifest && manifest.runtime && manifest.runtime.globalName;
      var ns = globalName ? window[globalName] : null;
      var Comp = resolveExport(ns, compName);
      if (!Comp) throw new Error(globalName + '.' + compName + ' not found');

      var record = state.roots.get(el);
      if (!record || !record.mountEl || record.mountEl.parentNode !== el) {
        if (record && record.root) {
          try { record.root.unmount(); } catch (e) {}
        }
        el.innerHTML = '';
        var mountEl = document.createElement('span');
        mountEl.setAttribute('data-doop-ds-root', '1');
        el.appendChild(mountEl);
        var root = typeof ReactDOM.createRoot === 'function' ? ReactDOM.createRoot(mountEl) : null;
        record = { root: root, mountEl: mountEl, sig: '' };
        state.roots.set(el, record);
      }

      record.sig = sig;
      var host = getHostComponents(React);
      var extProps = parseProps(propsRaw);
      return new Promise(function (resolve) {
        var settled = false;
        var finish = function () { if (!settled) { settled = true; resolve(); } };
        setTimeout(finish, 400);
        var elem = React.createElement(host.InteractiveAdapter, {
          Comp: Comp,
          extProps: extProps,
          propsKey: sig,
          onPainted: finish
        });
        if (record.root) {
          record.root.render(elem);
        } else if (typeof ReactDOM.render === 'function') {
          ReactDOM.render(elem, record.mountEl, finish);
        } else {
          finish();
        }
      });
    }).catch(function (err) {
      showNodeError(el, err && err.message ? err.message : String(err));
    });
  }

  function syncAll(originOverride) {
    var origin = getOrigin(originOverride);
    var nodes = document.querySelectorAll('doop-ds');
    if (!nodes.length) return Promise.resolve();
    ensureBaseStyle();
    var jobs = [];
    for (var i = 0; i < nodes.length; i++) {
      jobs.push(mountOne(nodes[i], origin));
    }
    var p = Promise.all(jobs).then(function () {
      return new Promise(function (r) {
        requestAnimationFrame(function () { requestAnimationFrame(r); });
      });
    });
    window.__doopReady = p;
    return p;
  }

  window.__doopSyncDs = syncAll;

  // Auto-run when loaded standalone (e.g. screenshot renderer or ComponentThumb iframe)
  if (!document.querySelector('script[data-v-boot]')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { syncAll(); });
    } else {
      syncAll();
    }
  }
})();`

/** Build a self-contained HTML preview document for rendering one `<doop-ds>` component thumbnail. */
export function buildDoopDsPreviewHtml(opts: {
  origin: string
  ds: string
  component: string
  version?: string
  props?: Record<string, unknown>
  width: number
  height: number
}): string {
  const tag = buildDoopDsTag({
    ds: opts.ds,
    component: opts.component,
    version: opts.version,
    props: opts.props,
  })
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: ${opts.width}px;
      height: ${opts.height}px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "Noto Sans CJK SC", "PingFang SC", sans-serif;
    }
  </style>
</head>
<body>
  ${tag}
  <script>window.__doopDsOrigin=${JSON.stringify(opts.origin)};${DOOP_DS_RUNTIME_SCRIPT.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`
}
