import { afterEach, describe, expect, test } from "bun:test"
import {
  resetAcpSessionOptionsFetch,
  setAcpSessionOptionsFetch,
  useAcpSessionOptionsStore,
  type AcpSessionModes,
} from "./acp-session-options"
import type { AcpFetch } from "./acp-client"

const MODES: AcpSessionModes = {
  currentModeId: "code",
  availableModes: [
    { id: "code", name: "Code" },
    { id: "ask", name: "Ask" },
  ],
}

const OPTIONS = [
  {
    id: "model",
    type: "select",
    name: "Model",
    currentValue: "mock-model-a",
    options: [
      { value: "mock-model-a", name: "Mock Model A" },
      { value: "mock-model-b", name: "Mock Model B" },
    ],
  },
]

type TestOption = {
  id: string
  type: string
  name: string
  currentValue?: string | boolean
  options?: Array<{ value: string; name: string }>
}

type TestBody = {
  sessionId?: string
  modes?: AcpSessionModes
  configOptions?: TestOption[]
  error?: string
}

type TestRequestBody = {
  sessionId?: string
  modeId?: string
  configId?: string
  value?: string | boolean
}

const json = (body: TestBody, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fakeFetch = (handler: (input: string, body: TestRequestBody) => Response): AcpFetch =>
  async (input, init) => handler(input, JSON.parse(init.body ?? "{}"))

afterEach(() => {
  resetAcpSessionOptionsFetch()
  useAcpSessionOptionsStore.setState({ bySession: {} })
})

describe("useAcpSessionOptionsStore", () => {
  test("loads modes and config options for a session", async () => {
    setAcpSessionOptionsFetch(
      fakeFetch(() => json({ sessionId: "s1", modes: MODES, configOptions: OPTIONS })),
    )

    await useAcpSessionOptionsStore.getState().load("s1")

    const state = useAcpSessionOptionsStore.getState().bySession.s1
    expect(state.status).toBe("ready")
    expect(state.modes?.currentModeId).toBe("code")
    expect(state.configOptions.map((option) => option.id)).toEqual(["model"])
    expect(state.configOptions[0].values.map((value) => value.value)).toEqual(["mock-model-a", "mock-model-b"])
  })

  test("switching the mode refreshes the snapshot", async () => {
    setAcpSessionOptionsFetch(
      fakeFetch((input, body) => {
        if (input.endsWith("/session/mode")) {
          expect(body).toMatchObject({ sessionId: "s1", modeId: "ask" })
          return json({ sessionId: "s1", modes: { ...MODES, currentModeId: "ask" }, configOptions: OPTIONS })
        }
        return json({ sessionId: "s1", modes: MODES, configOptions: OPTIONS })
      }),
    )

    await useAcpSessionOptionsStore.getState().load("s1")
    await useAcpSessionOptionsStore.getState().setMode("s1", "ask")

    expect(useAcpSessionOptionsStore.getState().bySession.s1.modes?.currentModeId).toBe("ask")
  })

  test("setting an option posts the value and refreshes", async () => {
    const calls: TestRequestBody[] = []
    setAcpSessionOptionsFetch(
      fakeFetch((input, body) => {
        calls.push(body)
        return json({ sessionId: "s1", modes: MODES, configOptions: OPTIONS })
      }),
    )

    await useAcpSessionOptionsStore.getState().load("s1")
    await useAcpSessionOptionsStore.getState().setOption("s1", "model", "mock-model-b")

    expect(calls[calls.length - 1]).toMatchObject({ sessionId: "s1", configId: "model", value: "mock-model-b" })
  })

  test("a failed load surfaces an error instead of hanging", async () => {
    setAcpSessionOptionsFetch(fakeFetch(() => json({ error: "gone" }, 404)))

    await useAcpSessionOptionsStore.getState().load("s1")

    const state = useAcpSessionOptionsStore.getState().bySession.s1
    expect(state.status).toBe("error")
    expect(state.error).toBe("gone")
  })
})
