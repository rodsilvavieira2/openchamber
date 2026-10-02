import { describe, expect, test } from "bun:test"
import { createAcpClient, type AcpFetch } from "./acp-client"

type Captured = { url: string; body: unknown }

const config = { agentId: "codex", name: "Codex", command: "npx", args: ["-y", "codex-acp"] }

const fakeFetch = (responses: Array<{ status?: number; body: unknown }>) => {
  const calls: Captured[] = []
  let index = 0
  const fetchImpl: AcpFetch = async (input, init) => {
    calls.push({ url: input, body: JSON.parse(init.body) })
    const spec = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { calls, fetchImpl }
}

describe("AcpClient", () => {
  test("creates a session through the ACP initialize route", async () => {
    const { calls, fetchImpl } = fakeFetch([
      { body: { backend: "acp", sessionId: "sess-1", directory: "/work", capabilities: {} } },
    ])
    const client = createAcpClient({ config, directory: "/work", fetchImpl })

    const session = await client.createSession({ title: "T" }, "/work")

    expect(client.backend).toBe("acp")
    expect(session.id).toBe("sess-1")
    expect(session.directory).toBe("/work")
    expect(calls[0].url).toBe("/api/agent/acp/initialize")
    expect(calls[0].body).toMatchObject({ command: "npx", args: ["-y", "codex-acp"], directory: "/work" })
  })

  test("sends a prompt with the client message id", async () => {
    const { calls, fetchImpl } = fakeFetch([
      { body: { backend: "acp", sessionId: "sess-1", directory: "/work", capabilities: {} } },
      { body: { stopReason: "end_turn" } },
    ])
    const client = createAcpClient({ config, fetchImpl })
    await client.createSession(undefined, "/work")

    const returned = await client.sendMessage({
      id: "sess-1",
      providerID: "acp",
      text: "hello",
      messageId: "msg_user_1",
    })

    expect(returned).toBe("msg_user_1")
    expect(calls[1].url).toBe("/api/agent/acp/prompt")
    expect(calls[1].body).toEqual({ sessionId: "sess-1", messageId: "msg_user_1", text: "hello" })
  })

  test("cancels through the ACP cancel route", async () => {
    const { calls, fetchImpl } = fakeFetch([{ body: { ok: true } }])
    const client = createAcpClient({ config, fetchImpl })

    expect(await client.abortSession("sess-1")).toBe(true)
    expect(calls[0].url).toBe("/api/agent/acp/cancel")
    expect(calls[0].body).toEqual({ sessionId: "sess-1" })
  })

  test("surfaces the server error message", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 502, body: { error: "Codex ACP executable not found.", code: "AGENT_INITIALIZATION_FAILED" } },
    ])
    const client = createAcpClient({ config, fetchImpl })

    await expect(client.createSession()).rejects.toThrow("Codex ACP executable not found.")
  })

  test("reports unsupported capabilities explicitly", async () => {
    const { fetchImpl } = fakeFetch([{ body: {} }])
    const client = createAcpClient({ config, fetchImpl })

    expect(() => client.replyToPermission("s", "r", "once")).toThrow(/does not support/)
    await expect(client.listSessionsPage()).rejects.toThrow(/does not support/)
  })
})
