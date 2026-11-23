import { useMemo, useState } from 'react'
import { BIND_ATTR, SLOT_ATTR, isDeleted, type ComponentProp } from '../../shared/components'
import { buildDoopDsTag, defaultPropsForComponent, type DesignSystemPropDef } from '../../shared/designSystems'
import type { Frame } from '../../shared/types'
import { api } from '../lib/api'
import {
  changeInstance,
  componentContextOf,
  exposeOnMain,
  restoreDeletedComponent,
  templateValue,
  type ComponentContext,
} from '../lib/components'
import { doopDsContextOf, useCanvasDesignSystems, type DoopDsContext } from '../lib/designSystems'
import { useT } from '../lib/i18n'
import { isLayerLocked, replaceLayerHtml } from '../lib/layerEdits'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { Button } from './ui/button'
import { ComponentIcon, InstanceIcon } from './ui/icons'
import { ImagePicker } from './ImageFill'
import { NumberField, PropertyRow, SelectField, TextField } from './ui/property-field'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

/** The Design panel's head when the selection belongs to a component (canvas component or hosted `<doop-ds>`). */
export function ComponentSection({ frame, selector }: { frame: Frame; selector: string }) {
  const t = useT()
  const defs = useStore((s) => s.canvas?.components)
  const dsContext = useMemo(() => doopDsContextOf(frame.html, selector), [frame.html, selector])
  const context = useMemo(() => componentContextOf(frame.html, selector, defs ?? []), [frame.html, selector, defs])
  if (dsContext) {
    return <DoopDsSection frame={frame} context={dsContext} />
  }
  if (!context) return null
  return (
    <section data-slot="component-section" className="flex flex-col border-b border-line-soft px-3 pt-3 pb-2.5">
      <header className="mb-[5px] flex min-h-5 min-w-0 items-center gap-1.5 text-body font-medium text-ink">
        {context.kind === 'main' ? (
          <ComponentIcon size="rail" className="flex-none text-brand" data-component-icon="main" />
        ) : (
          <InstanceIcon size="rail" className="flex-none text-brand" data-component-icon="instance" />
        )}
        <span className="truncate">{context.def.name}</span>
        <span className="ml-auto flex-none text-caption font-normal text-ink-faint">
          {context.kind === 'main' ? t('components.main') : t('components.instance')}
        </span>
      </header>
      {context.kind === 'main' ? (
        <MainControls key={context.def.id} frame={frame} context={context} />
      ) : isDeleted(context.def) ? (
        <DeletedInstanceControls frame={frame} context={context} />
      ) : (
        <InstanceControls frame={frame} context={context} />
      )}
    </section>
  )
}

/** An instance whose component was deleted: it keeps its look and follows nothing, until the
 *  component is restored (every instance is linked again) or this one is detached. */
function DeletedInstanceControls({
  frame,
  context,
}: {
  frame: Frame
  context: Extract<ComponentContext, { kind: 'instance' }>
}) {
  const { def, instanceId, rootSelector } = context
  const t = useT()
  const canEdit = useStore(canEditOpenCanvas)
  const locked = isLayerLocked(frame, rootSelector)
  return (
    <div data-slot="deleted-component" className="flex flex-col gap-2">
      <p className="text-caption font-medium text-ink">{t('components.mainDeleted')}</p>
      <p className="text-caption text-ink-soft">{t('components.mainDeletedHint')}</p>
      {canEdit && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => void restoreDeletedComponent(def)}>
            {t('components.restoreComponent')}
          </Button>
          <Button
            size="sm"
            disabled={locked}
            onClick={() => {
              const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
              if (current) void changeInstance(current, { instanceId, detach: true })
            }}
          >
            {t('components.detach')}
          </Button>
        </div>
      )}
    </div>
  )
}

function InstanceControls({
  frame,
  context,
}: {
  frame: Frame
  context: Extract<ComponentContext, { kind: 'instance' }>
}) {
  const { def, instanceId, isRoot, rootSelector, selector } = context
  const locked = isLayerLocked(frame, selector)
  const t = useT()
  return (
    <>
      {!isRoot && (
        <Button
          size="inline"
          variant="link"
          className="self-start"
          onClick={() => useStore.getState().setSelectedElement({ frameId: frame.id, selector: rootSelector })}
        >
          {t('components.selectInstance')}
        </Button>
      )}
      {def.props.map((prop) => (
        <PropField
          key={`${instanceId}:${prop.name}`}
          canvasId={frame.canvasId}
          prop={prop}
          disabled={locked}
          value={context.props[prop.name]}
          fallback={prop.default ?? (prop.type === 'boolean' ? 'true' : templateValue(def, prop.name))}
          onChange={(value) => {
            /* the frame as it is now: an image pick waits on an upload, and undo's baseline
               and the lock check must not be the design from before it */
            const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
            if (!current || isLayerLocked(current, selector)) return
            void changeInstance(current, { instanceId, props: { [prop.name]: value } })
          }}
        />
      ))}
    </>
  )
}

function PropField({
  canvasId,
  prop,
  value,
  fallback,
  disabled,
  onChange,
}: {
  canvasId: string
  prop: ComponentProp
  disabled: boolean
  value: string | undefined
  fallback: string
  onChange: (value: string) => void
}) {
  const shown = value ?? fallback
  return <PropertyRow label={prop.name}>{propControl()}</PropertyRow>

  function propControl() {
    switch (prop.type) {
      case 'boolean':
        return (
          <Switch
            size="sm"
            className="my-auto"
            disabled={disabled}
            checked={shown !== 'false'}
            onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
            aria-label={prop.name}
          />
        )
      case 'enum':
        return (
          <SelectField
            label={prop.name}
            value={shown}
            disabled={disabled}
            options={(prop.options ?? []).map((option) => ({ value: option, label: option }))}
            onChange={onChange}
          />
        )
      case 'image':
        return (
          <ImagePicker
            canvasId={canvasId}
            src={shown}
            label={prop.name}
            disabled={disabled}
            className="h-[26px] min-w-0 flex-1 gap-1.5 rounded-row px-[3px] text-caption"
            onPick={async (resolve) => {
              const url = await resolve()
              if (url !== shown) onChange(url)
            }}
            onClear={() => onChange('')}
          />
        )
      case 'text':
      case 'link':
        return (
          <TextField
            label={prop.name}
            value={shown}
            disabled={disabled}
            className={prop.type === 'text' ? 'font-sans' : undefined}
            placeholder={prop.type === 'link' ? 'https://…' : undefined}
            onCommit={onChange}
          />
        )
    }
  }
}

function MainControls({ frame, context }: { frame: Frame; context: Extract<ComponentContext, { kind: 'main' }> }) {
  const { def, isRoot, selector } = context
  const t = useT()
  const locked = isLayerLocked(frame, selector)
  const [description, setDescription] = useState(def.description)
  /* a collaborator's or agent's change to the description takes the field
     over, so a blur here never writes the older text back over it */
  const [seen, setSeen] = useState(def.description)
  if (seen !== def.description) {
    setSeen(def.description)
    setDescription(def.description)
  }
  const instances = useStore(
    (s) =>
      s.canvas?.frames.reduce((total, f) => total + (f.html.split(` data-doop-instance="${def.id}"`).length - 1), 0) ??
      0,
  )
  const save = () => {
    if (description === def.description) return
    api
      .updateComponent(frame.canvasId, def.id, { description })
      .catch(() => useStore.getState().pushNotice(t('components.descriptionFailed')))
  }
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-caption text-ink-soft">
        {instances === 0 ? t('components.noInstances') : t('components.reachesInstances', { count: instances })}
      </p>
      <Textarea
        value={description}
        placeholder={t('components.descriptionPlaceholder')}
        aria-label={t('components.descriptionAria')}
        rows={2}
        onChange={(event) => setDescription(event.target.value)}
        onBlur={save}
      />
      {def.props.length > 0 && (
        <p className="text-caption text-ink-soft">
          {t('components.propsLabel')}{' '}
          <span className="font-mono text-ink">{def.props.map((prop) => prop.name).join(', ')}</span>
        </p>
      )}
      {!isRoot && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={locked} onClick={() => exposeOnMain(frame, selector, BIND_ATTR)}>
            {t('components.makeProp')}
          </Button>
          <Button size="sm" disabled={locked} onClick={() => exposeOnMain(frame, selector, SLOT_ATTR)}>
            {t('components.makeSlot')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Right Inspector property controls for a hosted Design System `<doop-ds>` real React component. */
function DoopDsSection({ frame, context }: { frame: Frame; context: DoopDsContext }) {
  const canEdit = useStore(canEditOpenCanvas)
  const locked = !canEdit || isLayerLocked(frame, context.rootSelector)
  const { systems } = useCanvasDesignSystems(frame.canvasId)
  const dsSummary = systems.find((s) => s.name === context.ds)
  const compDef = dsSummary?.manifest.components?.find((c) => c.exportName === context.component)
  const effectiveProps = { ...defaultPropsForComponent(compDef), ...context.props }

  const commit = (patch: { props?: Record<string, unknown>; version?: string }) => {
    const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
    if (!current || isLayerLocked(current, context.rootSelector)) return
    const nextTag = buildDoopDsTag({
      ds: context.ds,
      component: context.component,
      version: patch.version ?? context.version,
      props: patch.props ?? context.props,
      extraAttrs: context.extraAttrs,
    })
    replaceLayerHtml(current, context.rootSelector, nextTag)
  }

  const updateProp = (name: string, value: unknown) => {
    const nextProps = { ...effectiveProps, [name]: value }
    commit({ props: nextProps })
  }

  const declaredProps: DesignSystemPropDef[] = compDef?.props ?? []
  const declaredNames = new Set(declaredProps.map((p) => p.name))
  const extraProps: DesignSystemPropDef[] = Object.entries(context.props)
    .filter(([name]) => !declaredNames.has(name))
    .flatMap(([name, value]): DesignSystemPropDef[] => {
      if (typeof value === 'boolean') return [{ name, type: 'boolean' }]
      if (typeof value === 'number') return [{ name, type: 'number' }]
      if (typeof value === 'string') return [{ name, type: 'text' }]
      return []
    })
  const allProps = [...declaredProps, ...extraProps]

  const versionOptions = [
    {
      value: 'latest',
      label: dsSummary ? `latest (v${dsSummary.latestVersion})` : 'latest',
    },
    ...(dsSummary?.versions ?? []).map((v) => ({ value: v, label: `v${v}` })),
  ]
  if (context.version !== 'latest' && !versionOptions.some((o) => o.value === context.version)) {
    versionOptions.push({ value: context.version, label: `v${context.version}` })
  }

  return (
    <section
      data-slot="ds-component-section"
      data-ds-component={`${context.ds}:${context.component}`}
      className="flex flex-col border-b border-line-soft px-3 pt-3 pb-2.5"
    >
      <header className="mb-1 flex min-h-5 min-w-0 items-center gap-1.5 text-body font-medium text-ink">
        <InstanceIcon size="rail" className="flex-none text-brand" data-component-icon="ds" />
        <span className="truncate">{compDef?.displayName || context.component}</span>
        <span className="ml-auto flex-none rounded-pill bg-paper-deep px-1.5 py-0.5 font-mono text-micro font-normal text-ink-soft">
          {context.ds}
        </span>
      </header>
      <PropertyRow label="Version">
        <SelectField
          label="Version"
          value={context.version}
          disabled={locked}
          options={versionOptions}
          onChange={(value) => commit({ version: value })}
        />
      </PropertyRow>
      {allProps.map((prop) => {
        const raw = effectiveProps[prop.name]
        const label = prop.label || prop.name
        return (
          <PropertyRow key={`${context.rootSelector}:${prop.name}`} label={label}>
            {prop.type === 'boolean' ? (
              <Switch
                size="sm"
                className="my-auto"
                disabled={locked}
                checked={Boolean(raw)}
                onCheckedChange={(checked) => updateProp(prop.name, checked)}
                aria-label={label}
              />
            ) : prop.type === 'enum' ? (
              <SelectField
                label={label}
                value={typeof raw === 'string' ? raw : (prop.options?.[0] ?? '')}
                disabled={locked}
                options={(prop.options ?? []).map((option) => ({ value: option, label: option }))}
                onChange={(value) => updateProp(prop.name, value)}
              />
            ) : prop.type === 'number' ? (
              <NumberField
                label={label}
                value={typeof raw === 'number' && Number.isFinite(raw) ? raw : null}
                unit=""
                min={-Infinity}
                max={Infinity}
                disabled={locked}
                onCommit={(value) => updateProp(prop.name, value)}
              />
            ) : (
              <TextField
                label={label}
                value={raw === undefined || raw === null ? '' : String(raw)}
                disabled={locked}
                className="font-sans"
                onCommit={(value) => updateProp(prop.name, value)}
              />
            )}
          </PropertyRow>
        )
      })}
      {allProps.length === 0 && (
        <p className="mt-1.5 text-caption text-ink-soft">
          No editable props declared for {context.ds}:{context.component}.
        </p>
      )}
    </section>
  )
}
