/**
 * ACP `AgentClient` adapter.
 *
 * Talks to the OpenChamber server's `/api/agent/acp/*` routes through
 * `runtimeFetch`, so it works in every runtime the server is reachable from
 * (web, desktop, hosted mobile, VS Code bridge) without knowing where the agent
 * process actually runs. Streaming output arrives over the normal event
 * channel; these calls only start a session and drive turns.
 */

import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { ascendingId } from "@/lib/opencode/ids"
import type { Session } from "@/lib/opencode/model"
import type { MessagePage, SessionPage } from "@/lib/opencode/client"
import type { AgentCapabilities, AgentClient, AgentPromptInput, CreateAgentSessionInput } from "./types"

const ZERO_TOKENS: Session["tokens"] = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export type AcpAgentConfig = {
  agentId: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

const errorSchema = z.object({ error: z.string().min(1), code: z.string().optional() })
const initializeSchema = z.object({
  backend: z.literal("acp"),
  sessionId: z.string().min(1),
  directory: z.string().nullable(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
})
const promptSchema = z.object({ stopReason: z.string().nullable().optional() })
const okSchema = z.object({ ok: z.boolean().optional() })

export type AcpInitializeResponse = z.infer<typeof initializeSchema>

/** The narrow transport surface the client needs; `runtimeFetch` satisfies it. */
export type AcpFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Response>

type AcpRequestBody = {
  sessionId?: string
  messageId?: string
  text?: string
  requestId?: string
  decision?: string
  agentId?: string
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  directory?: string
}

export const createAcpClient = ({
  config,
  directory,
  fetchImpl = runtimeFetch,
}: {
  config: AcpAgentConfig
  directory?: string | null
  /** Injectable for tests; production uses the runtime-aware transport. */
  fetchImpl?: AcpFetch
}): AgentClient => {
  let currentDirectory: string | undefined = directory ?? undefined

  const resolveDirectory = (dir?: string | null): string | undefined =>
    dir === null ? undefined : (dir ?? currentDirectory)

  const post = async <T>(path: string, body: AcpRequestBody, schema: z.ZodType<T>): Promise<T> => {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const parsedError = errorSchema.safeParse(payload)
      throw new Error(parsedError.success ? parsedError.data.error : `ACP request failed (${response.status})`)
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) throw new Error("The ACP server returned an unexpected response.")
    return parsed.data
  }

  const createSession = async (params?: CreateAgentSessionInput, dir?: string | null): Promise<Session> => {
    const effectiveDirectory = resolveDirectory(dir)
    const body = await post(
      "/api/agent/acp/initialize",
      {
        agentId: config.agentId,
        name: config.name,
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        directory: effectiveDirectory,
      },
      initializeSchema,
    )
    const now = Date.now()
    return {
      id: body.sessionId,
      projectID: "",
      directory: body.directory ?? effectiveDirectory ?? "",
      title: params?.title ?? "",
      cost: 0,
      tokens: ZERO_TOKENS,
      time: { created: now, updated: now },
    }
  }

  const sendMessage = async (params: AgentPromptInput): Promise<string> => {
    const messageId = params.messageId ?? ascendingId("msg")
    await post(
      "/api/agent/acp/prompt",
      { sessionId: params.id, messageId, text: params.text },
      promptSchema,
    )
    return messageId
  }

  const abortSession = async (id: string): Promise<boolean> => {
    await post("/api/agent/acp/cancel", { sessionId: id }, okSchema)
    return true
  }

  const unsupported = (operation: string): never => {
    throw new Error(`The ACP backend does not support ${operation} yet.`)
  }

  return {
    backend: "acp",
    createSession,
    sendMessage,
    sendCommand: async () => unsupported("slash commands"),
    abortSession,
    replyToPermission: async (sessionID, requestID, reply) => {
      await post("/api/agent/acp/permission", { sessionId: sessionID, requestId: requestID, decision: reply }, okSchema)
      return true
    },
    listSessionsPage: async (): Promise<SessionPage> => unsupported("session listing"),
    getSessionMessages: async (): Promise<MessagePage> => unsupported("message history"),
    getDirectory: () => currentDirectory,
    setDirectory: (value?: string) => {
      currentDirectory = value
    },
    getBaseUrl: () => "/api",
    capabilities: (): AgentCapabilities => ({ canCancel: true }),
  }
}
