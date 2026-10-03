/**
 * Backend-neutral agent contract.
 *
 * The shared UI reaches an agent through `AgentClient`. Today the only
 * implementation is OpenCode (`OpencodeService`); a second implementation
 * (ACP, over the server's `/api/agent/acp/*` routes) is added behind this
 * seam so chat, sidebar, tools, and permissions never learn which agent is
 * running.
 *
 * Method names and shapes deliberately mirror the existing OpenCode surface
 * (`createSession`, `sendMessage`, `abortSession`, `replyToPermission`) so the
 * OpenCode adapter is a true pass-through rather than a rewrite. The prompt
 * turn is `sendMessage` because that is the domain verb the sync layer already
 * uses everywhere.
 *
 * Wire types stay out of this file: it speaks the domain model in
 * `@/lib/opencode/model`. The only OpenCode-adjacent imports are the
 * already-backend-neutral input aliases re-exported by the adapter.
 */

import type { Metadata, ModelRef, PermissionReply, Session } from "@/lib/opencode/model"
import type {
  FileInputLite,
  MessagePage,
  SessionListOptions,
  SessionPage,
  SkillMentions,
  SyntheticContextInput,
} from "@/lib/opencode/client"

/** Which agent backend serves a session. One backend is active at a time. */
export type AgentBackendType = "opencode" | "acp"

/** How the agent admits a prompt relative to a running turn. */
type AgentDelivery = "steer" | "queue"

/** Parameters for creating a session, mirrored from the OpenCode surface. */
export type CreateAgentSessionInput = {
  id?: string
  title?: string
  agent?: string
  model?: ModelRef
  metadata?: Metadata
  /** ACP only: which registered agent serves the session. Ignored by OpenCode. */
  agentId?: string
}

/** A prompt turn sent to a session. */
export type AgentPromptInput = {
  runtimeKey?: string
  id: string
  /** Switch the session to this model before sending; omit when unchanged. */
  model?: ModelRef
  /** Switch the session to this agent before sending; omit when unchanged. */
  agent?: string
  /** Provider the prompt runs on, for the provider circuit breaker. */
  providerID: string
  text: string
  files?: Array<FileInputLite>
  context?: SyntheticContextInput[]
  messageId?: string
  agentMentions?: Array<{ name: string; source?: { value: string; start: number; end: number } }>
  metadata?: Metadata
  delivery?: AgentDelivery
  directory?: string | null
  skills?: SkillMentions
}

/** A slash command run in a session. */
export type AgentCommandInput = {
  runtimeKey?: string
  id: string
  model?: ModelRef
  agent?: string
  command: string
  arguments?: string
  files?: Array<FileInputLite>
  context?: SyntheticContextInput[]
  delivery?: AgentDelivery
  directory?: string | null
}

/**
 * Capabilities a backend reports. Minimal for now; ACP agents advertise more
 * after `initialize`, and the UI grows controls only for what it is told.
 */
export type AgentCapabilities = {
  /** The backend can cancel an in-flight turn. */
  canCancel: boolean
}

/**
 * The agent-transport seam. Implementations:
 *   - `OpencodeService` (thin adapter over the existing `@opencode/client` wrapper)
 *   - `AcpClient` (JSON-RPC over stdio via the server's `/api/agent/acp/*` routes)
 */
export interface AgentClient {
  /** Backend identifier. */
  readonly backend: AgentBackendType
  /** Create a session bound to this backend. */
  createSession(params?: CreateAgentSessionInput, directory?: string | null): Promise<Session>
  /** Send a prompt; returns the client-generated message id. */
  sendMessage(params: AgentPromptInput): Promise<string>
  /** Run a slash command in the session (best-effort; ACP may not support it). */
  sendCommand(params: AgentCommandInput): Promise<void>
  /** Cancel the in-flight turn for a session. */
  abortSession(id: string, directory?: string | null): Promise<boolean>
  /** Answer a permission request. */
  replyToPermission(
    sessionID: string,
    requestID: string,
    reply: PermissionReply,
    options?: { message?: string; directory?: string | null },
  ): Promise<boolean>
  /** List sessions known to the backend, for the sidebar. */
  listSessionsPage(options?: SessionListOptions): Promise<SessionPage>
  /** Load one page of a session's messages. */
  getSessionMessages(
    id: string,
    options?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
    directory?: string | null,
  ): Promise<MessagePage>
  /** The directory the client is currently scoped to. */
  getDirectory(): string | undefined
  /** Scope the client to a directory. */
  setDirectory(directory: string | undefined): void
  /** Base URL the backend is reached through. */
  getBaseUrl(): string
  /** Capabilities this backend exposes. */
  capabilities(): AgentCapabilities
}
