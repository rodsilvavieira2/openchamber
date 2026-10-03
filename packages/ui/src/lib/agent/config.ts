/**
 * Agent backend configuration and the active-backend sync.
 *
 * The user picks one backend (OpenCode by default, ACP opt-in). The selection
 * is persisted and, whenever it changes, the shared UI's active `AgentClient`
 * is swapped. ACP sessions stay one at a time for now: the client holds the
 * single ACP session the server currently has open.
 */

import { create } from "zustand"
import { z } from "zod"
import type { AcpAgentConfig } from "./acp-client"

export type AgentBackendType = "opencode" | "acp"

export type AgentBackendConfig = {
  backend: AgentBackendType
  /** Which registered ACP agent new chats use when the backend is ACP. */
  defaultAcpAgentId: string
  acp: AcpAgentConfig
}

/** The agent the ACP backend starts when the user has not chosen another. */
export const DEFAULT_ACP_AGENT: AcpAgentConfig = {
  agentId: "codex",
  name: "Codex",
  command: "npx",
  args: ["-y", "@agentclientprotocol/codex-acp"],
}

export const DEFAULT_AGENT_BACKEND_CONFIG: AgentBackendConfig = {
  backend: "opencode",
  defaultAcpAgentId: "codex",
  acp: DEFAULT_ACP_AGENT,
}

const STORAGE_KEY = "oc.agent.backend.v1"

const persistedSchema = z.object({
  backend: z.enum(["opencode", "acp"]).catch("opencode"),
  defaultAcpAgentId: z.string().min(1).catch("codex"),
  acp: z
    .object({
      agentId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      command: z.string().min(1).optional(),
      args: z.array(z.string()).catch([]),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().min(1).optional(),
    })
    .optional(),
})

/** Parse persisted config. Malformed input falls back to the OpenCode default. */
export const parseAgentBackendConfig = (raw: string | null): AgentBackendConfig => {
  if (!raw) return DEFAULT_AGENT_BACKEND_CONFIG
  let parsed: ReturnType<typeof persistedSchema.safeParse>
  try {
    parsed = persistedSchema.safeParse(JSON.parse(raw))
  } catch {
    return DEFAULT_AGENT_BACKEND_CONFIG
  }
  if (!parsed.success) return DEFAULT_AGENT_BACKEND_CONFIG
  return {
    backend: parsed.data.backend,
    defaultAcpAgentId: parsed.data.defaultAcpAgentId,
    acp: parsed.data.acp
      ? {
          agentId: parsed.data.acp.agentId ?? DEFAULT_ACP_AGENT.agentId,
          name: parsed.data.acp.name ?? DEFAULT_ACP_AGENT.name,
          command: parsed.data.acp.command ?? DEFAULT_ACP_AGENT.command,
          args: parsed.data.acp.args,
          env: parsed.data.acp.env,
          cwd: parsed.data.acp.cwd,
        }
      : DEFAULT_ACP_AGENT,
  }
}

const readPersisted = (): AgentBackendConfig => {
  try {
    return parseAgentBackendConfig(localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_AGENT_BACKEND_CONFIG
  }
}

const persist = (config: AgentBackendConfig): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // A full/unavailable localStorage must not break backend selection.
  }
}

type AgentBackendStore = {
  config: AgentBackendConfig
  setConfig: (config: AgentBackendConfig) => void
}

export const useAgentBackendStore = create<AgentBackendStore>((set) => ({
  config: readPersisted(),
  setConfig: (config) => {
    persist(config)
    set({ config })
  },
}))
