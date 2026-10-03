import { afterEach, describe, expect, test } from "bun:test"
import { resetAcpStoreFetch, setAcpStoreFetch, useAcpStore } from "./acp-store"
import type { AcpFetch } from "./acp-client"

type StatusAgent = { agentId: string; connected?: boolean; sessionIds?: string[] };
type TestBody =
  | { backend: string; agentId: string; sessionIds: string[]; capabilities: Record<string, boolean> }
  | { enabled: boolean; agents: StatusAgent[] }
  | { ok: boolean }
  | { error: string; code?: string };
const json = (body: TestBody, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fakeFetch = (handler: (input: string) => Response): AcpFetch =>
  async (input: string) => handler(input)

afterEach(() => {
  resetAcpStoreFetch()
  useAcpStore.setState({ agents: {} })
})

describe("useAcpStore", () => {
  test("connect marks the agent connected", async () => {
    setAcpStoreFetch(fakeFetch((input) => {
      if (input.endsWith("/initialize")) return json({ backend: "acp", agentId: "codex", sessionIds: [], capabilities: {} })
      return json({ ok: false }, 404)
    }))

    await useAcpStore.getState().connect("codex")

    const agent = useAcpStore.getState().agents.codex
    expect(agent.status).toBe("connected")
    expect(agent.error).toBeUndefined()
  })

  test("a failed handshake surfaces the server message", async () => {
    setAcpStoreFetch(fakeFetch(() => json({ error: "spawn ENOENT", code: "AGENT_START_FAILED" }, 502)))

    await useAcpStore.getState().connect("codex")

    const agent = useAcpStore.getState().agents.codex
    expect(agent.status).toBe("error")
    expect(agent.error).toBe("spawn ENOENT")
  })

  test("disconnect clears a connected agent", async () => {
    const calls: string[] = []
    setAcpStoreFetch(fakeFetch((input) => {
      calls.push(input)
      if (input.endsWith("/initialize")) return json({ backend: "acp", agentId: "codex", sessionIds: [], capabilities: {} })
      return json({ ok: true })
    }))

    await useAcpStore.getState().connect("codex")
    await useAcpStore.getState().disconnect("codex")

    expect(useAcpStore.getState().agents.codex.status).toBe("off")
    expect(calls.some((url) => url.endsWith("/shutdown"))).toBe(true)
  })

  test("refresh merges the server agent list", async () => {
    setAcpStoreFetch(fakeFetch((input) => {
      if (input.endsWith("/status")) {
        return json({ enabled: true, agents: [{ agentId: "claude", connected: true, sessionIds: ["s1"] }] })
      }
      return json({ ok: false }, 404)
    }))

    await useAcpStore.getState().refresh()

    const agent = useAcpStore.getState().agents.claude
    expect(agent.status).toBe("connected")
    expect(agent.sessionIds).toEqual(["s1"])
  })
})
