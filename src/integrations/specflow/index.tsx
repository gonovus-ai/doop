import { useEffect, useState } from 'react'
import type { ClientIntegration, SettingsCardProps } from '../index'
import { api, ApiError, req, type IntegrationsStatus } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from '../../components/ui/modal'
import { Note } from '../../components/ui/note'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { DisconnectButton, IntegrationCard } from '../ui'
import { useT } from '@/lib/i18n'

interface SpecFlowStatus {
  connected: boolean
  baseUrl?: string
  accountName?: string
  connectedAt?: number
  projectCount?: number
  webhook?: {
    configured: boolean
    id?: string
    endpointUrl?: string
    workspaceId?: string | null
    targetAgent?: string
  }
}

function statusOf(status: IntegrationsStatus): SpecFlowStatus {
  return (status.specflow ?? { connected: false }) as SpecFlowStatus
}

function SpecFlowTile({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, Math.round(size * 0.24)),
        background: '#111827',
        color: '#ffffff',
        display: 'inline-grid',
        placeItems: 'center',
        flex: 'none',
      }}
      aria-hidden
    >
      <svg width={Math.round(size * 0.56)} height={Math.round(size * 0.56)} viewBox="0 0 20 20" fill="none">
        <path
          d="M4 5.5C4 4.67 4.67 4 5.5 4H14.5C15.33 4 16 4.67 16 5.5C16 6.33 15.33 7 14.5 7H8.5C7.67 7 7 7.67 7 8.5C7 9.33 7.67 10 8.5 10H11.5C13.99 10 16 12.01 16 14.5C16 15.33 15.33 16 14.5 16H5.5C4.67 16 4 15.33 4 14.5C4 13.67 4.67 13 5.5 13H11.5C12.33 13 13 12.33 13 11.5C13 10.67 12.33 10 11.5 10"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

function SpecFlowSettingsCard({ status, busy, setBusy, setStatus, requestDisconnect, showToast }: SettingsCardProps) {
  const t = useT()
  const sf = statusOf(status)
  const [open, setOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState(sf.baseUrl || 'https://specflow.tools.gonovus.ai')
  const [token, setToken] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([])
  const [signingSecret, setSigningSecret] = useState('')
  const [workspaceId, setWorkspaceId] = useState<string>(sf.webhook?.workspaceId ?? '')
  const [targetAgent, setTargetAgent] = useState<string>(sf.webhook?.targetAgent ?? 'claude')
  const [copiedUrl, setCopiedUrl] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    api.listWorkspaces().then(
      (res) => {
        if (live) setWorkspaces(res.workspaces)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [open])

  function openSetup() {
    setBaseUrl(sf.baseUrl || 'https://specflow.tools.gonovus.ai')
    setWorkspaceId(sf.webhook?.workspaceId ?? '')
    setTargetAgent(sf.webhook?.targetAgent ?? 'claude')
    setSigningSecret('')
    setToken('')
    setReplacing(false)
    setError(null)
    setCopiedUrl(false)
    setOpen(true)
  }

  function closeSetup() {
    if (busy) return
    setOpen(false)
    setToken('')
    setSigningSecret('')
    setError(null)
    setReplacing(false)
  }

  async function connect() {
    if (busy || !token.trim()) return
    setBusy(true)
    setError(null)
    try {
      const next = await req<IntegrationsStatus>('/api/integrations/specflow/token', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim(), baseUrl: baseUrl.trim() || undefined }),
      })
      setStatus(next)
      setToken('')
      setReplacing(false)
      showToast(sf.connected ? t('automations.specflowKeyReplaced') : t('automations.specflowConnected'))
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.body.error ?? t('automations.specflowConnectFailed'))
          : t('automations.specflowConnectFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  async function saveWebhook() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await req<IntegrationsStatus>('/api/integrations/specflow/webhook', {
        method: 'PUT',
        body: JSON.stringify({
          ...(signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {}),
          workspaceId: workspaceId || null,
          targetAgent: targetAgent.trim() || 'claude',
        }),
      })
      setStatus(next)
      setSigningSecret('')
      showToast(t('automations.specflowWebhookSaved'))
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.body.error ?? t('automations.specflowWebhookFailed'))
          : t('automations.specflowWebhookFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  async function disableWebhook() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await req<IntegrationsStatus>('/api/integrations/specflow/webhook', { method: 'DELETE' })
      setStatus(next)
      showToast(t('automations.specflowWebhookRemoved'))
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.body.error ?? t('automations.specflowWebhookFailed'))
          : t('automations.specflowWebhookFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  const hostLabel = (() => {
    try {
      return new URL(sf.baseUrl || 'https://specflow.tools.gonovus.ai').host
    } catch {
      return sf.baseUrl || 'SpecFlow'
    }
  })()

  return (
    <>
      <IntegrationCard
        tile={<SpecFlowTile size={36} />}
        name="SpecFlow"
        detail={
          sf.connected
            ? t('automations.specflowDetail', { host: hostLabel, count: sf.projectCount ?? 0 })
            : t('automations.specflowPitch')
        }
        connected={sf.connected}
        footnote={
          sf.connected
            ? sf.webhook?.configured
              ? t('automations.specflowWebhookActive', { agent: sf.webhook.targetAgent ?? 'claude' })
              : t('automations.specflowApiActive')
            : ''
        }
        actions={
          <>
            <Button variant={sf.connected ? 'bare' : 'default'} size="sm" disabled={busy} onClick={openSetup}>
              {sf.connected ? t('automations.manage') : t('automations.connect')}
            </Button>
            {sf.connected && <DisconnectButton disabled={busy} onClick={requestDisconnect} />}
          </>
        }
      />
      <Modal open={open} onClose={closeSetup} size="md">
        <ModalTitle>{sf.connected ? t('automations.manageSpecFlow') : t('automations.connectSpecFlow')}</ModalTitle>
        <ModalLede>{t('automations.specflowLede')}</ModalLede>
        <div className="mt-5 flex flex-col gap-5">
          {error && (
            <Note role="alert" tone="error">
              {error}
            </Note>
          )}
          {sf.connected && !replacing && (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-copy font-semibold">{t('automations.specflowApiSection')}</h3>
                <p className="truncate text-caption text-ink-soft">{sf.baseUrl}</p>
              </div>
              <Button variant="bare" size="sm" disabled={busy} onClick={() => setReplacing(true)}>
                {t('automations.replaceKey')}
              </Button>
            </div>
          )}
          {(!sf.connected || replacing) && (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={(event) => {
                event.preventDefault()
                void connect()
              }}
            >
              <h3 className="text-copy font-semibold">{t('automations.specflowApiSection')}</h3>
              <p className="text-copy leading-relaxed text-ink-soft">{t('automations.specflowKeyHelp')}</p>
              <Input
                type="url"
                aria-label={t('automations.specflowUrlLabel')}
                placeholder="https://specflow.tools.gonovus.ai"
                value={baseUrl}
                disabled={busy}
                variant="well"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <div className="flex gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label={t('automations.specflowKeyLabel')}
                  placeholder={t('automations.specflowKeyPlaceholder')}
                  value={token}
                  disabled={busy}
                  variant="well"
                  className="min-w-0 flex-1"
                  onChange={(event) => {
                    setToken(event.target.value)
                    setError(null)
                  }}
                />
                <Button type="submit" size="sm" disabled={busy || !token.trim()}>
                  {busy ? t('automations.checking') : replacing ? t('automations.saveKey') : t('automations.connect')}
                </Button>
              </div>
              {replacing && (
                <Button
                  type="button"
                  variant="bare"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setToken('')
                    setError(null)
                    setReplacing(false)
                  }}
                >
                  {t('common.cancel')}
                </Button>
              )}
            </form>
          )}

          {sf.connected && (
            <form
              className="flex flex-col gap-2.5 border-t border-line-soft pt-4"
              onSubmit={(event) => {
                event.preventDefault()
                void saveWebhook()
              }}
            >
              <h3 className="text-copy font-semibold">{t('automations.specflowWebhookSection')}</h3>
              <p className="text-copy leading-relaxed text-ink-soft">{t('automations.specflowWebhookHelp')}</p>
              {sf.webhook?.configured && sf.webhook.endpointUrl && (
                <div className="flex items-center gap-2 rounded-control border border-line bg-well px-3 py-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-caption text-ink">
                    {sf.webhook.endpointUrl}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="bare"
                    onClick={() => {
                      void navigator.clipboard.writeText(sf.webhook!.endpointUrl!).then(() => setCopiedUrl(true))
                    }}
                  >
                    {copiedUrl ? t('automations.copied') : t('automations.copy')}
                  </Button>
                </div>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <Select
                  value={workspaceId || '__personal__'}
                  onValueChange={(v) => setWorkspaceId(v === '__personal__' ? '' : v)}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label={t('automations.specflowWorkspaceLabel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__personal__">{t('automations.specflowWorkspacePersonal')}</SelectItem>
                    {workspaces.map((ws) => (
                      <SelectItem key={ws.id} value={ws.id}>
                        {ws.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  aria-label={t('automations.specflowTargetAgentLabel')}
                  placeholder="@claude"
                  value={targetAgent}
                  disabled={busy}
                  variant="well"
                  className="font-mono"
                  onChange={(event) => setTargetAgent(event.target.value.replace(/^@+/, '').toLowerCase())}
                />
              </div>
              <Input
                type="password"
                autoComplete="off"
                aria-label={t('automations.specflowSigningSecretLabel')}
                placeholder={sf.webhook?.configured ? t('automations.specflowSigningSecretReplace') : 'whsec_…'}
                value={signingSecret}
                disabled={busy}
                variant="well"
                className="font-mono"
                onChange={(event) => setSigningSecret(event.target.value)}
              />
              <div className="flex items-center justify-end gap-2">
                {sf.webhook?.configured && (
                  <Button type="button" size="sm" variant="bare" disabled={busy} onClick={() => void disableWebhook()}>
                    {t('automations.specflowWebhookDisable')}
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={busy || (!sf.webhook?.configured && !signingSecret.trim())}>
                  {sf.webhook?.configured
                    ? t('automations.specflowWebhookUpdate')
                    : t('automations.specflowWebhookEnable')}
                </Button>
              </div>
            </form>
          )}
        </div>
        <ModalActions>
          <Button variant="bare" disabled={busy} onClick={closeSetup}>
            {t('common.close')}
          </Button>
        </ModalActions>
      </Modal>
    </>
  )
}

export const specflowIntegration: ClientIntegration = {
  id: 'specflow',
  name: 'SpecFlow',
  Tile: SpecFlowTile,
  SettingsCard: SpecFlowSettingsCard,
  isConnected: (status) => statusOf(status).connected,
  disconnect: () => req<IntegrationsStatus>('/api/integrations/specflow', { method: 'DELETE' }),
  disconnectCopy: 'automations.specflowDisconnectCopy',
}
