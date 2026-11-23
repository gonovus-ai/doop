import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/index.ts'
import { integrations, specflowWebhooks } from '../db/schema.ts'
import { ORIGIN } from '../links.ts'
import {
  DEFAULT_SPECFLOW_URL,
  listProjects,
  normalizeSpecFlowBaseUrl,
  SpecFlowError,
  verifyIdentity,
} from './client.ts'

const owned = (userId: string) => and(eq(integrations.userId, userId), eq(integrations.provider, 'specflow'))

/** Standard Webhooks secret: `whsec_` followed by canonical base64 of 24-64 bytes. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function isStandardWebhookSecret(secret: string): boolean {
  if (!secret.startsWith('whsec_')) return false
  const encoded = secret.slice(6)
  if (!CANONICAL_BASE64.test(encoded)) return false
  const len = Buffer.from(encoded, 'base64').length
  return len >= 24 && len <= 64
}

export async function getConnection(userId: string) {
  const [row] = await db.select().from(integrations).where(owned(userId))
  if (!row) return undefined
  return {
    ...row,
    baseUrl: row.accountName || DEFAULT_SPECFLOW_URL,
  }
}

export async function getWebhookReceiver(userId: string) {
  const [row] = await db.select().from(specflowWebhooks).where(eq(specflowWebhooks.userId, userId))
  return row
}

export async function getWebhookReceiverById(id: string) {
  const [row] = await db.select().from(specflowWebhooks).where(eq(specflowWebhooks.id, id))
  return row
}

export function webhookEndpointUrl(hookId: string): string {
  return `${ORIGIN}/webhooks/specflow/${encodeURIComponent(hookId)}`
}

export async function connectionStatus(userId: string) {
  const [conn, hook] = await Promise.all([getConnection(userId), getWebhookReceiver(userId)])
  return {
    connected: !!conn,
    ...(conn
      ? {
          baseUrl: conn.baseUrl,
          accountName: conn.baseUrl,
          connectedAt: conn.connectedAt,
          projectCount: conn.accounts.length,
        }
      : { baseUrl: DEFAULT_SPECFLOW_URL }),
    webhook: hook
      ? {
          configured: true,
          id: hook.id,
          endpointUrl: webhookEndpointUrl(hook.id),
          workspaceId: hook.workspaceId,
          targetAgent: hook.targetAgent,
        }
      : { configured: false },
  }
}

export async function connect(userId: string, apiKey: string, rawBaseUrl?: string) {
  const token = apiKey.trim()
  if (token.length < 12 || token.length > 512) {
    throw new SpecFlowError('Enter a valid SpecFlow User API key.', 400)
  }
  const baseUrl = normalizeSpecFlowBaseUrl(rawBaseUrl)
  await verifyIdentity(baseUrl, token)
  const projects = await listProjects(baseUrl, token).catch(() => [])
  const now = Date.now()
  const values = {
    accessToken: token,
    accountName: baseUrl,
    accounts: projects.map((p) => ({ id: p.id, name: p.name })),
    expiresAt: null,
    connectedAt: now,
    updatedAt: now,
  }
  await db
    .insert(integrations)
    .values({ id: nanoid(8), userId, provider: 'specflow', ...values })
    .onConflictDoUpdate({ target: [integrations.userId, integrations.provider], set: values })
}

export async function saveWebhookReceiver(
  userId: string,
  input: { signingSecret?: string; workspaceId?: string | null; targetAgent?: string },
) {
  const existing = await getWebhookReceiver(userId)
  const rawSecret = input.signingSecret?.trim()
  let secretToStore: string
  if (rawSecret) {
    if (!isStandardWebhookSecret(rawSecret)) {
      throw new SpecFlowError(
        'Enter the SpecFlow webhook signing secret starting with whsec_ (Standard Webhooks base64 format).',
        400,
      )
    }
    secretToStore = rawSecret
  } else if (existing) {
    secretToStore = existing.signingSecret
  } else {
    throw new SpecFlowError('Paste the whsec_ signing secret from SpecFlow to enable inbound webhooks.', 400)
  }

  const targetAgent = (input.targetAgent ?? existing?.targetAgent ?? 'claude').trim().replace(/^@+/, '').toLowerCase()
  if (!/^[a-z][a-z0-9]{1,23}$/.test(targetAgent)) {
    throw new SpecFlowError('Target agent must be a valid handle (e.g. claude or doop).', 400)
  }

  const workspaceId =
    input.workspaceId !== undefined ? input.workspaceId?.trim() || null : (existing?.workspaceId ?? null)
  const now = Date.now()
  const id = existing?.id ?? nanoid(12)

  await db
    .insert(specflowWebhooks)
    .values({
      id,
      userId,
      workspaceId,
      targetAgent,
      signingSecret: secretToStore,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: specflowWebhooks.userId,
      set: { workspaceId, targetAgent, signingSecret: secretToStore, updatedAt: now },
    })

  return {
    id,
    endpointUrl: webhookEndpointUrl(id),
    workspaceId,
    targetAgent,
  }
}

export async function deleteWebhookReceiver(userId: string) {
  await db.delete(specflowWebhooks).where(eq(specflowWebhooks.userId, userId))
}

export async function disconnect(userId: string) {
  await db.delete(integrations).where(owned(userId))
  await db.delete(specflowWebhooks).where(eq(specflowWebhooks.userId, userId))
}
