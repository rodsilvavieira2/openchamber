import { describe, expect, test } from "bun:test"
import { DEFAULT_AGENT_BACKEND_CONFIG, parseAgentBackendConfig } from "./config"

describe("parseAgentBackendConfig", () => {
  test("falls back to OpenCode for missing or malformed input", () => {
    expect(parseAgentBackendConfig(null)).toEqual(DEFAULT_AGENT_BACKEND_CONFIG)
    expect(parseAgentBackendConfig("not json")).toEqual(DEFAULT_AGENT_BACKEND_CONFIG)
    expect(parseAgentBackendConfig(JSON.stringify({ backend: "bogus" }))).toEqual(DEFAULT_AGENT_BACKEND_CONFIG)
  })

  test("reads a persisted ACP selection and drops invalid arguments", () => {
    const parsed = parseAgentBackendConfig(
      JSON.stringify({
        backend: "acp",
        acp: { agentId: "claude", name: "Claude Code", command: "claude-code-acp", args: ["--acp", 42] },
      }),
    )
    expect(parsed.backend).toBe("acp")
    expect(parsed.acp).toMatchObject({ agentId: "claude", command: "claude-code-acp" })
    expect(parsed.acp.args).toEqual([])
  })

  test("defaults a missing command back to the built-in agent", () => {
    const parsed = parseAgentBackendConfig(JSON.stringify({ backend: "acp", acp: {} }))
    expect(parsed.acp.command).toBe(DEFAULT_AGENT_BACKEND_CONFIG.acp.command)
  })
})
