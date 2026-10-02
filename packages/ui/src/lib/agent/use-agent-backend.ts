/**
 * Keeps the active `AgentClient` in step with the backend selection.
 *
 * Mounted once at the app root. While the backend is OpenCode the active
 * client stays `null` (the default in `getActiveAgentClient`), so nothing about
 * the existing OpenCode flow changes; switching to ACP installs an `AcpClient`.
 */

import { useEffect } from "react"
import { createAcpClient } from "./acp-client"
import { setActiveAgentClient } from "./active-client"
import { useAgentBackendStore } from "./config"

export const useAgentBackendSync = (): void => {
  useEffect(() => {
    const apply = (config: ReturnType<typeof useAgentBackendStore.getState>["config"]): void => {
      setActiveAgentClient(config.backend === "acp" ? createAcpClient({ config: config.acp }) : null)
    }
    apply(useAgentBackendStore.getState().config)
    return useAgentBackendStore.subscribe((state) => apply(state.config))
  }, [])
}
