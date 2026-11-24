/**
 * The composer's pick: which of the person's connections the next task goes
 * to, and the model on it. It is this browser's choice (`doop:agent-runner`
 * in localStorage), independent of the Settings default that comments and
 * automations run on, and resolved against what is connected whenever the
 * picker shows it, so a connection that was dropped falls back to the default.
 */
import { create } from 'zustand'
import { api } from './api'
import { useStore } from './store'
import { parseRunnerPick, resolveRunnerPick, type AgentRunners, type RunnerPick } from '../../shared/agentRunner'
import type { AgentRole } from '../../shared/agents'
import { useEffect } from 'react'

export const RUNNER_PICK_KEY = 'doop:agent-runner'
export const EXTERNAL_AGENT_PICK_KEY = 'doop:external-agent'

export function readStoredPick(storage: Pick<Storage, 'getItem'> | undefined): RunnerPick | null {
  try {
    const raw = storage?.getItem(RUNNER_PICK_KEY)
    return raw ? (parseRunnerPick(JSON.parse(raw)) ?? null) : null
  } catch {
    return null
  }
}

function readStoredExternalAgent(storage: Pick<Storage, 'getItem'> | undefined): string | null {
  try {
    const raw = storage?.getItem(EXTERNAL_AGENT_PICK_KEY)
    return typeof raw === 'string' ? raw : null
  } catch {
    return null
  }
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** Resolve which external agent (if any) is currently selected for the canvas
 *  composer. `externalAgentId === ''` means the user explicitly chose the
 *  built-in Doop Agent / model runner; `null` means unset, in which case we
 *  default to the canvas's first external agent when no model account is
 *  connected so the user can chat with their external agent right away. */
export function resolveExternalAgent(
  team: readonly AgentRole[] | undefined,
  externalAgentId: string | null,
  runners: AgentRunners | null,
): AgentRole | undefined {
  const externals = (team ?? []).filter((r) => r.external)
  if (externals.length === 0) return undefined
  if (externalAgentId === '') return undefined
  if (externalAgentId) {
    const matched = externals.find((r) => r.id === externalAgentId)
    if (matched) return matched
  }
  if (runners && runners.runners.length === 0) return externals[0]
  return undefined
}

export const useRunnerPick = create<{
  stored: RunnerPick | null
  runners: AgentRunners | null
  /** null = auto, '' = explicitly built-in Doop Agent/model, non-empty = external agent id */
  externalAgentId: string | null
  setPick: (pick: RunnerPick) => void
  setExternalAgent: (agentId: string | null) => void
}>((set) => ({
  stored: readStoredPick(storage()),
  runners: null,
  externalAgentId: readStoredExternalAgent(storage()),
  setPick: (pick) => {
    try {
      storage()?.setItem(RUNNER_PICK_KEY, JSON.stringify(pick))
      storage()?.setItem(EXTERNAL_AGENT_PICK_KEY, '')
    } catch {
      /* private mode: the pick lives for this page only */
    }
    set({ stored: pick, externalAgentId: '' })
  },
  setExternalAgent: (agentId) => {
    try {
      if (agentId === null) storage()?.removeItem(EXTERNAL_AGENT_PICK_KEY)
      else storage()?.setItem(EXTERNAL_AGENT_PICK_KEY, agentId)
    } catch {
      /* private mode */
    }
    set({ externalAgentId: agentId })
  },
}))

/** Asks the server for the connections whenever a mount or a connection
 *  change (`allowanceVersion`) makes the list stale. */
export function useAgentRunners(): AgentRunners | null {
  const version = useStore((s) => s.allowanceVersion)
  const runners = useRunnerPick((s) => s.runners)
  useEffect(() => {
    let stale = false
    api.agentRunners().then(
      (next) => {
        /* an answer without the list (an older server, a stubbed route) is
           nothing connected, never a crash in the composer */
        if (!stale)
          useRunnerPick.setState({ runners: { ...next, runners: Array.isArray(next?.runners) ? next.runners : [] } })
      },
      () => {},
    )
    return () => {
      stale = true
    }
  }, [version])
  return runners
}

/** The pick a card should carry right now, or nothing when the person has
 *  no connection of their own (the card runs on the server tier). */
export function currentRunnerPick(): RunnerPick | undefined {
  const { runners, stored } = useRunnerPick.getState()
  return resolveRunnerPick(runners, stored)?.pick
}
