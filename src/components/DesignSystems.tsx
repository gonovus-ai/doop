import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { DS_MAX_GUIDE_CHARS, type DesignSystemDetail, type DesignSystemSummary } from '../../shared/designSystems'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { EmptyState } from './ui/empty-state'
import { Field } from './ui/field'
import { EditIcon, TrashIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { Textarea } from './ui/textarea'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

/**
 * Workspace Design Systems card: inspects hosted real-component bundles
 * served from /ds/<name>/<version|latest>/*, copies URLs, rolls back `latest`,
 * edits the live usage guide, and prunes old immutable releases.
 */
export function DesignSystems({ workspaceId, onToast }: { workspaceId: string; onToast: (message: string) => void }) {
  const [items, setItems] = useState<DesignSystemSummary[] | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Record<string, DesignSystemDetail>>({})
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null)
  const [editing, setEditing] = useState<DesignSystemSummary | null>(null)
  const [deletingRelease, setDeletingRelease] = useState<{ name: string; version: string } | null>(null)

  const reload = useCallback(async () => {
    setError('')
    try {
      const list = await api.listDesignSystems(workspaceId)
      setItems(list)
    } catch (e) {
      setItems([])
      setError(errorMessage(e, 'Could not load hosted design systems'))
    }
  }, [workspaceId])

  useEffect(() => {
    let live = true
    api.listDesignSystems(workspaceId).then(
      (list) => {
        if (live) setItems(list)
      },
      (e: unknown) => {
        if (!live) return
        setItems([])
        setError(errorMessage(e, 'Could not load hosted design systems'))
      },
    )
    return () => {
      live = false
    }
  }, [workspaceId])

  async function toggleExpand(name: string) {
    if (expanded[name]) {
      setExpanded((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      return
    }
    setLoadingDetail(name)
    try {
      const detail = await api.getDesignSystem(name)
      setExpanded((prev) => ({ ...prev, [name]: detail }))
    } catch (e) {
      setError(errorMessage(e, `Could not load releases for ${name}`))
    } finally {
      setLoadingDetail(null)
    }
  }

  async function handleRollback(name: string, version: string) {
    setError('')
    try {
      await api.rollbackDesignSystem(name, version)
      onToast(`${name} latest → ${version}`)
      await reload()
      const detail = await api.getDesignSystem(name)
      setExpanded((prev) => ({ ...prev, [name]: detail }))
    } catch (e) {
      setError(errorMessage(e, 'Rollback failed'))
    }
  }

  async function handleDeleteRelease(name: string, version: string) {
    setError('')
    try {
      await api.deleteDesignSystemRelease(name, version)
      onToast(`Removed ${name}@${version}`)
      await reload()
      const detail = await api.getDesignSystem(name)
      setExpanded((prev) => ({ ...prev, [name]: detail }))
    } catch (e) {
      setError(errorMessage(e, 'Could not remove release'))
    }
  }

  function copyText(value: string, label: string) {
    void navigator.clipboard?.writeText(value).then(
      () => onToast(`Copied ${label}`),
      () => onToast(value),
    )
  }

  return (
    <SettingsCard className="mt-5">
      <CardHeader>
        <CardTitle>Hosted Design Systems</CardTitle>
        <CardDescription>
          Versioned real-component bundles served from this server&apos;s{' '}
          <code className="font-mono text-caption">/ds/&lt;name&gt;/latest/</code> origin. Workspace members publish new
          immutable releases via MCP (<code className="font-mono text-caption">publish_design_system_bundle</code>) or
          CI with an Agent Key.
        </CardDescription>
      </CardHeader>

      {error && (
        <div className="px-4 pt-3 sm:px-[22px]">
          <Note tone="error">{error}</Note>
        </div>
      )}

      {items?.length === 0 ? (
        <div className="px-4 py-5 sm:px-[22px]">
          <EmptyState
            variant="dashed"
            className="border"
            title="No hosted design systems yet"
            description="Publish your first bundle (e.g. gonovus) via the publish_design_system_bundle MCP tool or POST /api/design-systems/<name>/tickets."
          />
        </div>
      ) : (
        <CardRow label="Bundles">
          <Note>
            {items === null
              ? 'Loading…'
              : `${items.length} design system${items.length === 1 ? '' : 's'} hosted in this workspace`}
          </Note>
        </CardRow>
      )}

      {items?.map((ds) => {
        const detail = expanded[ds.name]
        return (
          <div key={ds.name} className="border-t border-line">
            <CardRow
              label={
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{ds.name}</span>
                  <span className="rounded-pill bg-tint px-1.5 py-0.5 font-mono text-micro text-ink">
                    v{ds.latestVersion}
                  </span>
                  {ds.manifest.runtime.globalName && (
                    <span className="font-mono text-micro text-ink-faint">window.{ds.manifest.runtime.globalName}</span>
                  )}
                </div>
              }
              action={
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="bare" onClick={() => copyText(ds.latestBaseUrl, `${ds.name} latest URL`)}>
                    Copy URL
                  </Button>
                  <Button size="sm" variant="bare" onClick={() => setEditing(ds)}>
                    <EditIcon size="rail" /> Guide
                  </Button>
                  <Button
                    size="sm"
                    variant="bare"
                    disabled={loadingDetail === ds.name}
                    onClick={() => void toggleExpand(ds.name)}
                  >
                    {detail ? 'Hide versions' : `Versions (${ds.releaseCount})`}
                  </Button>
                </div>
              }
            >
              <p className="min-w-0 basis-full text-body text-ink-faint">
                {ds.displayName} · {ds.latestFiles.length} files ({formatBytes(ds.latestTotalBytes)}) ·{' '}
                {ds.manifest.runtime.preset} · updated {formatDate(ds.updatedAt)}
              </p>
            </CardRow>

            {detail && (
              <div className="bg-tint/40 px-4 py-3 text-body sm:px-[22px]">
                <div className="mb-2 font-medium text-ink">Releases</div>
                <div className="flex flex-col gap-2">
                  {detail.releases.map((rel) => {
                    const isLatest = rel.version === detail.latestVersion
                    return (
                      <div
                        key={rel.version}
                        className="flex flex-col gap-1.5 rounded-control border border-line bg-paper p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-medium text-ink">{rel.version}</span>
                            {isLatest && (
                              <span className="rounded-pill bg-ink px-1.5 py-0.5 text-micro font-medium text-paper">
                                latest
                              </span>
                            )}
                            <span className="text-caption text-ink-faint">
                              {rel.files.length} files · {formatBytes(rel.totalBytes)} · {formatDate(rel.createdAt)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {!isLatest && (
                              <>
                                <Button
                                  size="sm"
                                  variant="bare"
                                  onClick={() => void handleRollback(detail.name, rel.version)}
                                >
                                  Set as latest
                                </Button>
                                <Button
                                  size="sm"
                                  variant="bare"
                                  onClick={() => setDeletingRelease({ name: detail.name, version: rel.version })}
                                >
                                  <TrashIcon size="rail" /> Remove
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                        {rel.notes && <p className="text-caption text-ink-faint">{rel.notes}</p>}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-micro text-ink-faint">
                          {rel.files.map((f) => (
                            <span key={f.path}>
                              {f.path} ({formatBytes(f.bytes)})
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {editing && (
        <DesignSystemGuideModal
          ds={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            onToast(`Updated ${editing.name} metadata & guide`)
            void reload()
          }}
        />
      )}

      <ConfirmDialog
        open={deletingRelease !== null}
        onOpenChange={(open) => !open && setDeletingRelease(null)}
        title={deletingRelease ? `Remove ${deletingRelease.name}@${deletingRelease.version}?` : ''}
        description="Frames pinned directly to this version URL will stop loading its assets. The active latest version cannot be removed."
        confirmLabel="Remove release"
        destructive
        onConfirm={() => {
          if (deletingRelease) void handleDeleteRelease(deletingRelease.name, deletingRelease.version)
          setDeletingRelease(null)
        }}
      />
    </SettingsCard>
  )
}

function DesignSystemGuideModal({
  ds,
  onClose,
  onSaved,
}: {
  ds: DesignSystemSummary
  onClose: () => void
  onSaved: () => void
}) {
  const [displayName, setDisplayName] = useState(ds.displayName)
  const [description, setDescription] = useState(ds.description)
  const [guideMarkdown, setGuideMarkdown] = useState(ds.manifest.docs?.guideMarkdown ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setSaving(true)
    setError('')
    try {
      await api.updateDesignSystemMeta(ds.name, { displayName, description, guideMarkdown })
      onSaved()
    } catch (e) {
      setError(errorMessage(e, 'Could not save design system guide'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} className="max-w-[640px]">
      <ModalTitle>Design System Guide · {ds.name}</ModalTitle>
      <ModalLede>
        Served live to AI agents via{' '}
        <code className="font-mono">
          get_design_system(&#123; ds_name: &quot;{ds.name}&quot;, section: &quot;guide&quot; &#125;)
        </code>
        .
      </ModalLede>
      <div className="mt-4 flex flex-col gap-3">
        {error && <Note tone="error">{error}</Note>}
        <Field label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={`Live Usage Guide (Markdown, max ${DS_MAX_GUIDE_CHARS} chars)`}>
          <Textarea
            rows={10}
            value={guideMarkdown}
            onChange={(e) => setGuideMarkdown(e.target.value)}
            placeholder="Document how agents should load and compose components from this design system…"
          />
        </Field>
      </div>
      <ModalActions>
        <Button variant="bare" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </ModalActions>
    </Modal>
  )
}
