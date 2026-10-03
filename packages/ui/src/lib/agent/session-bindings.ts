/**
 * In-memory session → ACP agent bindings.
 *
 * Kept in its own module so both the client (writer) and the resolver
 * (reader) share it without an import cycle.
 */

const sessionAgents = new Map<string, string>()

/** Remember which agent serves a session. */
export const bindSessionToAgent = (sessionId: string, agentId: string): void => {
  sessionAgents.set(sessionId, agentId)
}

/** Forget a session binding (session closed/deleted, tests). */
export const unbindSession = (sessionId: string): void => {
  sessionAgents.delete(sessionId)
}

/** The bound agent id, if any. */
export const boundAgentForSession = (sessionId: string): string | undefined => sessionAgents.get(sessionId)

/** Drop all bindings (tests). */
export const clearSessionBindings = (): void => {
  sessionAgents.clear()
}
