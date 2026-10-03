import { describe, expect, test } from "bun:test"
import {
  BUILTIN_ACP_AGENTS,
  CUSTOM_ACP_AGENT_ID,
  listAcpAgentIds,
  readSessionAcpAgentId,
  resolveAcpAgent,
} from "./registry"

const custom = { agentId: "custom", name: "Custom", command: "my-acp", args: ["--stdio"] }

describe("ACP registry", () => {
  test("resolves builtins without touching the custom definition", () => {
    expect(resolveAcpAgent("codex", custom)).toMatchObject({ id: "codex", command: "npx" })
    expect(resolveAcpAgent("claude", custom)).toMatchObject({ id: "claude", command: "claude-code-acp" })
  })

  test("unknown ids fall back to the custom definition", () => {
    expect(resolveAcpAgent("whatever", custom)).toMatchObject({ id: CUSTOM_ACP_AGENT_ID, command: "my-acp" })
  })

  test("lists builtins first", () => {
    expect(listAcpAgentIds()[0]).toBe(BUILTIN_ACP_AGENTS[0].id)
    expect(listAcpAgentIds()).toContain(CUSTOM_ACP_AGENT_ID)
  })

  test("reads the session binding", () => {
    expect(readSessionAcpAgentId({ acp: { agentId: "claude" } })).toBe("claude")
    expect(readSessionAcpAgentId({})).toBe(null)
    expect(readSessionAcpAgentId(undefined)).toBe(null)
    expect(readSessionAcpAgentId({ acp: { agentId: 42 } })).toBe(null)
  })
})
