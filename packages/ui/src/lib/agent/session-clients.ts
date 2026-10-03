/**
 * Which client serves a session.
 *
 * The binding is an in-memory map written at creation, so resolution never
 * depends on store shape (and never throws when a store is partially mocked).
 * Sessions also carry the binding in `metadata.acp.agentId` as the durable,
 * debuggable record; after a reload the map is rebuilt from it on first use.
 * A Codex chat and a Claude chat therefore stay live side by side with no
 * global switch in between.
 */

import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { createAcpClient } from "./acp-client"
import { getActiveAgentClient } from "./active-client"
import { useAgentBackendStore } from "./config"
import { readSessionAcpAgentId, resolveAcpAgent } from "./registry"
import { boundAgentForSession, bindSessionToAgent } from "./session-bindings"
import type { AgentClient } from "./types"

const acpClients = new Map<string, AgentClient>()

/** The client for a registered ACP agent, cached per agent id. */
export const getAcpClient = (agentId: string): AgentClient => {
  const existing = acpClients.get(agentId)
  if (existing) return existing
  const custom = useAgentBackendStore.getState().config.acp
  const client = createAcpClient({ config: resolveAcpAgent(agentId, custom) })
  acpClients.set(agentId, client)
  return client
}

/** Drop cached ACP clients (custom definition changed, tests). */
export const clearAcpClientCache = (): void => {
  acpClients.clear()
}

export { bindSessionToAgent, boundAgentForSession, clearSessionBindings, unbindSession } from "./session-bindings"

const readStoredBinding = (sessionId: string): string | null => {
  try {
    const session = useGlobalSessionsStore.getState().entityById?.get(sessionId)
    return readSessionAcpAgentId(session?.metadata)
  } catch {
    // Partially mocked stores in tests, or a store mid-reset: no binding.
    return null
  }
}

/**
 * Resolve the client for a session: its bound ACP agent when the session
 * carries one, otherwise the default backend (OpenCode unless configured).
 */
export const getAgentClientForSession = (sessionId: string): AgentClient => {
  const bound = boundAgentForSession(sessionId) ?? readStoredBinding(sessionId)
  if (bound) {
    bindSessionToAgent(sessionId, bound)
    return getAcpClient(bound)
  }
  return getActiveAgentClient()
}
