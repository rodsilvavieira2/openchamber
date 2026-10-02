import { describe, expect, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { getActiveAgentClient, setActiveAgentClient } from "./active-client"
import type { AgentClient } from "./types"

describe("active agent client", () => {
  test("defaults to the OpenCode backend", () => {
    setActiveAgentClient(null)
    const client: AgentClient = getActiveAgentClient()
    expect(client).toBe(opencodeClient)
    expect(client.backend).toBe("opencode")
    expect(client.capabilities()).toEqual({ canCancel: true })
  })

  test("clearing the active client falls back to OpenCode", () => {
    setActiveAgentClient(opencodeClient)
    expect(getActiveAgentClient()).toBe(opencodeClient)
    setActiveAgentClient(null)
    expect(getActiveAgentClient()).toBe(opencodeClient)
  })
})
