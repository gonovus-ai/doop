import { useCallback, useEffect, useState } from 'react'
import {
  buildDoopDsTag,
  defaultPropsForComponent,
  parseDoopDsProps,
  type DesignSystemComponentDef,
  type DesignSystemSummary,
} from '../../shared/designSystems'
import { elementIdSelector } from '../../shared/elementId'
import type { Frame } from '../../shared/types'
import { api } from './api'
import { clientToWorld, frameAtPoint } from './commentMove'
import { recordCreate, recordUpdate } from './history'
import { t } from './i18n'
import { isLayerLocked } from './layerEdits'
import { elementPath } from './layers'
import { useStore } from './store'

/** Drag MIME type for a hosted Design System real React component card. */
export const DS_COMPONENT_DRAG_TYPE = 'application/x-doop-ds-component'

export interface DsComponentDrag {
  ds: string
  component: string
  version?: string
  props?: Record<string, unknown>
  previewSize?: { width?: number; height?: number }
  displayName?: string
}

export function dsDragData(drag: DsComponentDrag): string {
  return JSON.stringify(drag)
}

export function parseDsDrag(data: string): DsComponentDrag | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj.ds !== 'string' || typeof obj.component !== 'string' || !obj.ds || !obj.component) return null
    return {
      ds: obj.ds,
      component: obj.component,
      ...(typeof obj.version === 'string' && obj.version ? { version: obj.version } : {}),
      ...(obj.props && typeof obj.props === 'object' && !Array.isArray(obj.props)
        ? { props: obj.props as Record<string, unknown> }
        : {}),
      ...(obj.previewSize && typeof obj.previewSize === 'object'
        ? { previewSize: obj.previewSize as { width?: number; height?: number } }
        : {}),
      ...(typeof obj.displayName === 'string' && obj.displayName ? { displayName: obj.displayName } : {}),
    }
  } catch {
    return null
  }
}

/* Shared per-canvas cache so ComponentsPanel and ComponentSection don't duplicate fetches. */
const cache = new Map<string, DesignSystemSummary[]>()
const inflight = new Map<string, Promise<DesignSystemSummary[]>>()
const listeners = new Set<() => void>()

function fetchCanvasDesignSystems(canvasId: string, force = false): Promise<DesignSystemSummary[]> {
  if (!force && cache.has(canvasId)) return Promise.resolve(cache.get(canvasId)!)
  const existing = !force ? inflight.get(canvasId) : undefined
  if (existing) return existing
  const promise = api
    .canvasDesignSystems(canvasId)
    .then((list) => {
      cache.set(canvasId, list)
      for (const fn of listeners) fn()
      return list
    })
    .catch(() => cache.get(canvasId) ?? [])
    .finally(() => {
      if (inflight.get(canvasId) === promise) inflight.delete(canvasId)
    })
  inflight.set(canvasId, promise)
  return promise
}

export function useCanvasDesignSystems(canvasId: string | undefined): {
  systems: DesignSystemSummary[]
  reload: () => void
} {
  const [systems, setSystems] = useState<DesignSystemSummary[]>(() => (canvasId ? (cache.get(canvasId) ?? []) : []))

  useEffect(() => {
    if (!canvasId) return
    let live = true
    const sync = () => {
      if (live) setSystems(cache.get(canvasId) ?? [])
    }
    listeners.add(sync)
    void fetchCanvasDesignSystems(canvasId).then((list) => {
      if (live) setSystems(list)
    })
    return () => {
      live = false
      listeners.delete(sync)
    }
  }, [canvasId])

  const reload = useCallback(() => {
    if (!canvasId) return
    void fetchCanvasDesignSystems(canvasId, true)
  }, [canvasId])

  return { systems: canvasId ? systems : [], reload }
}

function adopt(before: Frame, after: Frame) {
  useStore.getState().upsertFrame(after)
  if (before.html !== after.html) recordUpdate(after.id, { html: before.html }, { html: after.html }, true)
}

function notifyFailure(error: unknown, fallback: string) {
  useStore.getState().pushNotice(error instanceof Error && error.message ? error.message : fallback)
}

function standaloneDsFrameHtml(tag: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" /></head><body style="margin:0;padding:24px;display:flex;align-items:center;justify-content:center;min-height:100vh;box-sizing:border-box">${tag}</body></html>`
}

/** Insert a hosted Design System component into the selected frame, or as a new frame. */
export async function placeDsComponent(ds: DesignSystemSummary, comp: DesignSystemComponentDef) {
  const s = useStore.getState()
  const frame = s.selectedId ? s.canvas?.frames.find((candidate) => candidate.id === s.selectedId) : undefined
  const props = defaultPropsForComponent(comp)
  try {
    if (frame) {
      const target = s.selectedElement?.frameId === frame.id ? s.selectedElement.selector : undefined
      if (frame.locked || (target && isLayerLocked(frame, target))) {
        s.pushNotice(t('components.locked'))
        return
      }
      const { frame: next, instanceId } = await api.insertInstance(frame.id, {
        ds: ds.name,
        component: comp.exportName,
        props,
        ...(target ? { target, position: 'after' } : {}),
      })
      adopt(frame, next)
      if (instanceId) {
        useStore.getState().setSelectedElement({ frameId: next.id, selector: elementIdSelector(instanceId) })
      }
      return
    }
    if (!s.canvas) return
    const width = Math.max(240, (comp.previewSize?.width ?? 240) + 48)
    const height = Math.max(120, (comp.previewSize?.height ?? 80) + 48)
    const tag = buildDoopDsTag({ ds: ds.name, component: comp.exportName, props })
    const created = await api.createFrame(s.canvas.id, {
      name: comp.displayName || comp.exportName,
      ...(s.activePageId ? { pageId: s.activePageId } : {}),
      width,
      height,
      html: standaloneDsFrameHtml(tag),
    })
    useStore.getState().upsertFrame(created)
    recordCreate(created)
    useStore.getState().select(created.id)
  } catch (error) {
    notifyFailure(error, t('components.placeFailed'))
  }
}

/** Drop a hosted Design System component card onto a frame (or empty canvas paper). */
export async function dropDsComponent(drag: DsComponentDrag, client: { x: number; y: number }) {
  const s = useStore.getState()
  if (!s.canvas) return
  const point = clientToWorld(client.x, client.y)
  const frame = frameAtPoint(s.canvas, s.activePageId ?? null, point)
  try {
    if (frame) {
      if (frame.locked) {
        s.pushNotice(t('components.locked'))
        return
      }
      const { frame: next, instanceId } = await api.insertInstance(frame.id, {
        ds: drag.ds,
        component: drag.component,
        ...(drag.version ? { version: drag.version } : {}),
        ...(drag.props ? { props: drag.props } : {}),
      })
      adopt(frame, next)
      s.select(frame.id)
      if (instanceId) {
        useStore.getState().setSelectedElement({ frameId: next.id, selector: elementIdSelector(instanceId) })
      }
      return
    }
    const width = Math.max(240, (drag.previewSize?.width ?? 240) + 48)
    const height = Math.max(120, (drag.previewSize?.height ?? 80) + 48)
    const tag = buildDoopDsTag({
      ds: drag.ds,
      component: drag.component,
      version: drag.version,
      props: drag.props,
    })
    const created = await api.createFrame(s.canvas.id, {
      name: drag.displayName || drag.component,
      ...(s.activePageId ? { pageId: s.activePageId } : {}),
      x: Math.round(point.x),
      y: Math.round(point.y),
      width,
      height,
      html: standaloneDsFrameHtml(tag),
    })
    useStore.getState().upsertFrame(created)
    recordCreate(created)
    useStore.getState().select(created.id)
  } catch (error) {
    notifyFailure(error, t('components.placeFailed'))
  }
}

export interface DoopDsContext {
  ds: string
  component: string
  version: string
  props: Record<string, unknown>
  rootSelector: string
  isRoot: boolean
  extraAttrs: Record<string, string>
}

/** Resolve `<doop-ds>` metadata for a selected element inside a frame's saved HTML. */
export function doopDsContextOf(html: string, selector: string): DoopDsContext | null {
  if (!html.includes('<doop-ds')) return null
  let el: Element | null
  try {
    el = new DOMParser().parseFromString(html, 'text/html').querySelector(selector)
  } catch {
    return null
  }
  if (!el) return null
  const host = el.closest('doop-ds')
  if (!host) return null
  const ds = (host.getAttribute('ds') ?? '').trim()
  const component = (host.getAttribute('component') ?? '').trim()
  if (!ds || !component) return null
  const version = (host.getAttribute('version') ?? 'latest').trim() || 'latest'
  const props = parseDoopDsProps(host.getAttribute('props'))
  const extraAttrs: Record<string, string> = {}
  for (const attr of Array.from(host.attributes)) {
    if (attr.name === 'ds' || attr.name === 'component' || attr.name === 'version' || attr.name === 'props') continue
    extraAttrs[attr.name] = attr.value
  }
  return {
    ds,
    component,
    version,
    props,
    rootSelector: elementPath(host),
    isRoot: host === el,
    extraAttrs,
  }
}
