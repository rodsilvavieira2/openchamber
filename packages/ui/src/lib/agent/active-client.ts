/**
 * The active agent backend for the shared UI.
 *
 * Phase 1 of ACP support keeps this trivial on purpose: the only registered
 * backend is OpenCode, so every caller that goes through
 * `getActiveAgentClient()` behaves exactly as before. The selector (Phase 5)
 * swaps `activeAgentClient` when the user picks an ACP agent; until then the
 * accessor is a stable indirection, not a behavior change.
 */

import { opencodeClient } from "@/lib/opencode/client"
import type { AgentClient } from "./types"

let activeAgentClient: AgentClient | null = null

/**
 * Registers the backend a session should use, or `null` to fall back to
 * OpenCode. Callers must re-read `getActiveAgentClient()` at call time rather
 * than caching the result across a runtime or backend switch.
 */
export const setActiveAgentClient = (client: AgentClient | null): void => {
  activeAgentClient = client
}

/** The backend the UI should talk to. Defaults to OpenCode. */
export const getActiveAgentClient = (): AgentClient => activeAgentClient ?? opencodeClient
