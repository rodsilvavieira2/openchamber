import { afterEach, describe, expect, test } from "bun:test"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { opencodeClient } from "@/lib/opencode/client"
import {
  bindSessionToAgent,
  clearSessionBindings,
  getAgentClientForSession,
  unbindSession,
} from "./session-clients"

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const fakeSession = (id: string, agentId?: string) => ({
  id,
  projectID: "p",
  directory: "/work",
  title: "t",
  cost: 0,
  tokens: ZERO_TOKENS,
  time: { created: 1, updated: 1 },
  ...(agentId ? { metadata: { acp: { agentId } } } : {}),
})

afterEach(() => {
  clearSessionBindings()
  useGlobalSessionsStore.getState().removeSessions(["s-bound", "s-meta", "s-open"])
})

describe("getAgentClientForSession", () => {
  test("falls back to the default backend for unknown sessions", () => {
    expect(getAgentClientForSession("s-open")).toBe(opencodeClient)
  })

  test("routes a bound session to its ACP agent", () => {
    bindSessionToAgent("s-bound", "codex")
    const client = getAgentClientForSession("s-bound")
    expect(client.backend).toBe("acp")
    unbindSession("s-bound")
    expect(getAgentClientForSession("s-bound")).toBe(opencodeClient)
  })

  test("rebuilds the binding from session metadata after a reload", () => {
    useGlobalSessionsStore.getState().upsertSession(fakeSession("s-meta", "claude"))
    const client = getAgentClientForSession("s-meta")
    expect(client.backend).toBe("acp")
  })
})
