/**
 * The ACP agent registry.
 *
 * Any CLI that speaks the Agent Client Protocol is just an entry here:
 * Codex, Claude Code, and one user-defined Custom agent. The UI never
 * branches on an agent name — it launches whatever the registry resolves and
 * drives the session through the generic `AgentClient` contract.
 */

import { z } from "zod"
import type { AcpAgentConfig } from "./acp-client"
import type { Metadata } from "@/lib/opencode/model"

export type AcpAgentDefinition = AcpAgentConfig & {
  /** Stable id used for session binding (`codex`, `claude`, `custom`). */
  id: string
}

export const CODEX_AGENT_ID = "codex"
export const CLAUDE_AGENT_ID = "claude"
export const CUSTOM_ACP_AGENT_ID = "custom"

export const BUILTIN_ACP_AGENTS: readonly AcpAgentDefinition[] = [
  {
    id: CODEX_AGENT_ID,
    agentId: CODEX_AGENT_ID,
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
  },
  {
    id: CLAUDE_AGENT_ID,
    agentId: CLAUDE_AGENT_ID,
    name: "Claude Code",
    command: "claude-code-acp",
    args: [],
  },
]

/** Resolve any known agent id to its launch definition. Unknown ids mean Custom. */
export const resolveAcpAgent = (agentId: string, custom: AcpAgentConfig): AcpAgentDefinition => {
  const builtin = BUILTIN_ACP_AGENTS.find((agent) => agent.id === agentId)
  if (builtin) return builtin
  return { ...custom, id: CUSTOM_ACP_AGENT_ID }
}

/** Every agent id the UI can offer, builtins first. */
export const listAcpAgentIds = (): string[] => [
  ...BUILTIN_ACP_AGENTS.map((agent) => agent.id),
  CUSTOM_ACP_AGENT_ID,
]

const sessionAcpSchema = z.object({
  acp: z.object({ agentId: z.string().min(1) }).optional(),
})

/** The ACP agent id a session is bound to, or null for OpenCode sessions. */
export const readSessionAcpAgentId = (metadata: Metadata | undefined): string | null => {
  const parsed = sessionAcpSchema.safeParse(metadata ?? {})
  if (!parsed.success) return null
  return parsed.data.acp?.agentId ?? null
}
