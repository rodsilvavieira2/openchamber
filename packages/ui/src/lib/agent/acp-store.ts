/**
 * Live connection state of every ACP agent.
 *
 * Definitions come from the registry (builtins) plus the Custom definition in
 * settings; status is runtime-only and never persisted. Several agents may be
 * connected at once — that is the whole point of the ACP page.
 */

import { create } from "zustand"
import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"
import type { AcpFetch } from "./acp-client"
import {
  BUILTIN_ACP_AGENTS,
  CUSTOM_ACP_AGENT_ID,
  type AcpAgentDefinition,
} from "./registry"
import { useAgentBackendStore } from "./config"

export type AcpConnectionStatus = "off" | "starting" | "connected" | "error"

export type AcpAgentRuntime = {
  definition: AcpAgentDefinition
  status: AcpConnectionStatus
  sessionIds: string[]
  capabilityNames: string[]
  error?: string
}

const statusAgentSchema = z.object({
  agentId: z.string().min(1),
  label: z.string().optional(),
  connected: z.boolean().optional(),
  sessionIds: z.array(z.string()).optional(),
})
const statusSchema = z.object({ enabled: z.boolean(), agents: z.array(statusAgentSchema).optional() })
const errorSchema = z.object({ error: z.string().min(1) })

let fetchImpl: AcpFetch = runtimeFetch

/** Override the transport in tests. */
export const setAcpStoreFetch = (fetch: AcpFetch): void => {
  fetchImpl = fetch
}

export const resetAcpStoreFetch = (): void => {
  fetchImpl = runtimeFetch
}

const readError = async (response: Response): Promise<string> => {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.error : `Request failed (${response.status})`
}

/** All agents the page can offer: builtins plus the configured Custom one. */
export const listAcpAgentDefinitions = (): AcpAgentDefinition[] => {
  const custom = useAgentBackendStore.getState().config.acp
  return [...BUILTIN_ACP_AGENTS, { ...custom, id: CUSTOM_ACP_AGENT_ID }]
}

const emptyRuntime = (definition: AcpAgentDefinition): AcpAgentRuntime => ({
  definition,
  status: "off",
  sessionIds: [],
  capabilityNames: [],
})

type AcpStore = {
  agents: Record<string, AcpAgentRuntime>
  refresh: () => Promise<void>
  connect: (agentId: string) => Promise<void>
  disconnect: (agentId: string) => Promise<void>
}

const definitionOf = (agentId: string): AcpAgentDefinition | null =>
  listAcpAgentDefinitions().find((agent) => agent.id === agentId) ?? null

export const useAcpStore = create<AcpStore>((set, get) => ({
  agents: {},

  refresh: async () => {
    const response = await fetchImpl("/api/agent/acp/status", { method: "GET", headers: {} }).catch(() => null)
    if (!response || !response.ok) return
    const parsed = statusSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success || !parsed.data.enabled) return
    const agents = { ...get().agents }
    for (const entry of parsed.data.agents ?? []) {
      const definition = definitionOf(entry.agentId)
      if (!definition) continue
      const current = agents[entry.agentId] ?? emptyRuntime(definition)
      agents[entry.agentId] = {
        ...current,
        definition,
        status: "connected",
        sessionIds: entry.sessionIds ?? current.sessionIds,
        error: undefined,
      }
    }
    set({ agents })
  },

  connect: async (agentId: string) => {
    const definition = definitionOf(agentId)
    if (!definition) return
    const agents = { ...get().agents }
    agents[agentId] = { ...(agents[agentId] ?? emptyRuntime(definition)), definition, status: "starting", error: undefined }
    set({ agents })
    const response = await fetchImpl("/api/agent/acp/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: definition.id,
        name: definition.name,
        command: definition.command,
        args: definition.args,
        env: definition.env,
      }),
    }).catch(() => null)
    const next = { ...get().agents }
    if (!response || !response.ok) {
      const message = response ? await readError(response) : "Could not reach the OpenChamber server."
      next[agentId] = { ...(next[agentId] ?? emptyRuntime(definition)), definition, status: "error", error: message }
      set({ agents: next })
      return
    }
    const current = next[agentId] ?? emptyRuntime(definition)
    next[agentId] = { ...current, definition, status: "connected", error: undefined }
    set({ agents: next })
  },

  disconnect: async (agentId: string) => {
    await fetchImpl("/api/agent/acp/shutdown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    }).catch(() => null)
    const agents = { ...get().agents }
    const current = agents[agentId]
    if (!current) return
    agents[agentId] = { ...current, status: "off", sessionIds: [], error: undefined }
    set({ agents })
  },
}))
