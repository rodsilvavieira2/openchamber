/**
 * Per-session ACP modes and config options (models, reasoning effort, ...).
 *
 * Whatever the agent advertises via `session/new` is rendered generically in
 * the chat; the UI never assumes a Codex-shaped or Claude-shaped option list.
 * State is runtime-only: a server restart drops sessions anyway.
 */

import { create } from "zustand"
import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"
import type { AcpFetch } from "./acp-client"

export type AcpSessionMode = {
  id: string
  name: string
  description?: string | null
}

export type AcpSessionModes = {
  currentModeId: string
  availableModes: AcpSessionMode[]
}

export type AcpConfigSelectValue = {
  value: string
  name: string
}

export type AcpConfigSelectOption = {
  id: string
  name: string
  description?: string | null
  type: "select"
  currentValue: string
  values: AcpConfigSelectValue[]
}

export type AcpConfigBooleanOption = {
  id: string
  name: string
  description?: string | null
  type: "boolean"
  currentValue: boolean
  values: []
}

export type AcpConfigOption = AcpConfigSelectOption | AcpConfigBooleanOption

export type AcpSessionOptionsStatus = "idle" | "loading" | "ready" | "error"

export type AcpSessionOptionsState = {
  status: AcpSessionOptionsStatus
  modes: AcpSessionModes | null
  configOptions: AcpConfigOption[]
  error?: string
}

const flatValueSchema = z.object({ value: z.string(), name: z.string() })
const groupSchema = z.object({ name: z.string(), options: z.array(flatValueSchema) })
const entrySchema = z.union([flatValueSchema, groupSchema])

const flattenValues = (entries: Array<z.infer<typeof entrySchema>>): AcpConfigSelectValue[] =>
  entries.flatMap((entry) => ("options" in entry ? entry.options : [entry]))

const selectOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable().optional(),
  type: z.literal("select"),
  currentValue: z.string().optional(),
  options: z.array(entrySchema).optional(),
})

const booleanOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable().optional(),
  type: z.literal("boolean"),
  currentValue: z.boolean().optional(),
})

const configOptionSchema = z.discriminatedUnion("type", [selectOptionSchema, booleanOptionSchema])

const modesSchema = z.object({
  currentModeId: z.string(),
  availableModes: z.array(z.object({ id: z.string(), name: z.string() })),
})

const optionsResponseSchema = z.object({
  sessionId: z.string(),
  modes: modesSchema.nullable().optional(),
  // Items are validated one by one so a single unknown option cannot sink
  // the whole snapshot.
  configOptions: z.array(z.unknown()).optional(),
})

const errorSchema = z.object({ error: z.string().min(1) })

let fetchImpl: AcpFetch = runtimeFetch

/** Override the transport in tests. */
export const setAcpSessionOptionsFetch = (fetch: AcpFetch): void => {
  fetchImpl = fetch
}

export const resetAcpSessionOptionsFetch = (): void => {
  fetchImpl = runtimeFetch
}

type RawOption = z.infer<typeof configOptionSchema>

const normalizeOption = (option: RawOption): AcpConfigOption | null => {
  switch (option.type) {
    case "boolean":
      return {
        id: option.id,
        name: option.name,
        description: option.description,
        type: "boolean",
        currentValue: option.currentValue ?? false,
        values: [],
      }
    case "select":
      return {
        id: option.id,
        name: option.name,
        description: option.description,
        type: "select",
        currentValue: option.currentValue ?? "",
        values: flattenValues(option.options ?? []),
      }
  }
}

const readError = async (response: Response): Promise<string> => {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.error : `Request failed (${response.status})`
}

type AcpSessionOptionsStore = {
  bySession: Record<string, AcpSessionOptionsState>
  load: (sessionId: string) => Promise<void>
  setMode: (sessionId: string, modeId: string) => Promise<void>
  setOption: (sessionId: string, configId: string, value: string | boolean) => Promise<void>
  clearSession: (sessionId: string) => void
}

const idleState = (): AcpSessionOptionsState => ({ status: "idle", modes: null, configOptions: [] })

const applyResponse = (
  sessionId: string,
  payload: z.input<typeof optionsResponseSchema>,
  set: (partial: Partial<AcpSessionOptionsStore>) => void,
  get: () => AcpSessionOptionsStore,
): boolean => {
  const parsed = optionsResponseSchema.safeParse(payload)
  if (!parsed.success) return false
  const rawList = parsed.data.configOptions ?? []
  const configOptions: AcpConfigOption[] = []
  for (const raw of rawList) {
    const item = configOptionSchema.safeParse(raw)
    if (!item.success) continue
    const normalized = normalizeOption(item.data)
    if (normalized) configOptions.push(normalized)
  }
  set({
    bySession: {
      ...get().bySession,
      [sessionId]: {
        status: "ready",
        modes: parsed.data.modes
          ? { currentModeId: parsed.data.modes.currentModeId, availableModes: parsed.data.modes.availableModes }
          : null,
        configOptions,
      },
    },
  })
  return true
}

export const useAcpSessionOptionsStore = create<AcpSessionOptionsStore>((set, get) => ({
  bySession: {},

  load: async (sessionId: string) => {
    const current = get().bySession[sessionId]
    if (current && (current.status === "loading" || current.status === "ready")) return
    set({ bySession: { ...get().bySession, [sessionId]: { ...idleState(), status: "loading" } } })
    const response = await fetchImpl("/api/agent/acp/session/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => null)
    if (!response || !response.ok) {
      const message = response ? await readError(response) : "Could not reach the OpenChamber server."
      set({ bySession: { ...get().bySession, [sessionId]: { ...idleState(), status: "error", error: message } } })
      return
    }
    const applied = applyResponse(sessionId, await response.json().catch(() => null), set, get)
    if (!applied) {
      set({ bySession: { ...get().bySession, [sessionId]: { ...idleState(), status: "error", error: "Unexpected options response." } } })
    }
  },

  setMode: async (sessionId: string, modeId: string) => {
    const response = await fetchImpl("/api/agent/acp/session/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, modeId }),
    }).catch(() => null)
    if (!response || !response.ok) return
    applyResponse(sessionId, await response.json().catch(() => null), set, get)
  },

  setOption: async (sessionId: string, configId: string, value: string | boolean) => {
    const previous = get().bySession[sessionId]
    const response = await fetchImpl("/api/agent/acp/session/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, configId, value }),
    }).catch(() => null)
    if (!response || !response.ok) {
      // Keep the previous snapshot; a failed set must not blank the picker.
      if (previous) set({ bySession: { ...get().bySession, [sessionId]: previous } })
      return
    }
    const applied = applyResponse(sessionId, await response.json().catch(() => null), set, get)
    if (!applied && previous) set({ bySession: { ...get().bySession, [sessionId]: previous } })
  },

  clearSession: (sessionId: string) => {
    const bySession = { ...get().bySession }
    delete bySession[sessionId]
    set({ bySession })
  },
}))
