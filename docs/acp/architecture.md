# ACP Architecture — current state and migration plan

Branch: `feature/acp-runtime` (fork `rodsilvavieira2/openchamber`, upstream `openchamber/openchamber`).
Scope: issue #2010 (Must first, then Should), MVP = OpenCode + Codex + Claude + Custom ACP behind a flag.
Reference PoC: `TomzxForks/openchamber` branch `feat/2010-acp-support` (consulted, not copied).
SDK pins at time of writing: `@opencode/client` / `@opencode/schema` `2.0.21` (OpenCode 2.x only).
ACP SDK: `@agentclientprotocol/sdk` `1.7.0` (server-only, `packages/web`).

Progress: M1 `AgentClient` + OpenCode adapter landed (no behavior change);
M2 process manager, feature flag, SDK connection, and fake-agent handshake
landed. M3 translation into v2 wire payloads + event source landed. M4 routes
`/api/agent/acp/{initialize,prompt,cancel,permission,shutdown,status}` landed
and registered before the proxy, with shutdown teardown. M5 UI `AcpClient` +
`getActiveAgentClient()` at the create/prompt/abort/permission seams + backend
selector in Settings landed. M7 tool-call mapping and permission
request/response landed.
Claude and Codex are config-level registrations on the same `AcpAgentRuntime`
(no provider branches): Codex via `npx -y @agentclientprotocol/codex-acp`,
Claude via `claude-code-acp`. Automated validation uses the fake ACP agent;
checking the real Codex/Claude binaries requires their CLIs and credentials,
so it stays a manual gate (see §14).

## 1. Current OpenCode flow

```text
UI (packages/ui, shared React)
  │
  ├─ opencodeClient (packages/ui/src/lib/opencode/client.ts:2116, class OpencodeService)
  │    └─ @opencode/client SDK → runtimeFetch transport → /api/* (relative; never hardcoded host)
  │
  ├─ runtimeFetch (packages/ui/src/lib/runtime-fetch.ts:334) + RuntimeAPIs
  │    └─ OpenChamber-owned routes (/health, /api/fs/*, /api/sessions/status, /api/openchamber/*)
  │
  ▼
Server (packages/web/server/index.js, Express)
  ├─ proxy.js: /api/* → managed `opencode serve` (readiness + worktree holds, archive overlay)
  ├─ event-stream/: upstream-reader (GET /api/event SSE) → delta-coalescer → global-hub
  │    (replay 2048 events / 8 MiB) → WS /api/global/event/ws + SSE fan-out + openchamber:* synthetics
  └─ lifecycle.js: spawn/supervise managed `opencode serve` (neutral cwd) + health + orphan reap
       registry dir: ~/.config/openchamber/managed-opencode/<pid>.json

Sync (packages/ui/src/sync/)
  session-actions.createSession → opencodeClient.createSession → registerSessionDirectory
  session-ui-store.optimisticSend → opencodeClient.sendMessage|sendCommand
  event-pipeline (SSE sdk.event.subscribe | WS) → events.ts translateWireEvent → reducer → child stores
  bootstrap.ts (global + per-directory) → persistence: server authoritative, localStorage snapshot only
```

Wire knowledge is quarantined in `packages/ui/src/lib/opencode/`:
`client.ts` (sole SDK funnel), `model.ts` (domain model — the abstraction target),
`projection.ts` (wire→domain), `events.ts` (`translateWireEvent`, exhaustiveness-guarded),
`tools.ts` (the only place allowed to branch on tool name), `ids.ts` (client-minted ids).

## 2. Target agent flow

```text
UI (domain types only: Session/Message/Part/PermissionRequest/FormRequest)
  │
  AgentRuntime API (new; backend-neutral)
  │   createSession / prompt|sendMessage / cancel|abortSession / list|resume|close|delete
  │   respondToPermission / capabilities()
  │
  ├─ OpenCodeBackend (thin adapter over existing OpencodeService; behavior unchanged)
  │
  └─ ACPBackend (generic; configured per agent, never per-provider code)
       │  AgentRegistry: codex | claude | custom (command/args/env/cwd)
       │  Capability negotiation after `initialize` drives the UI (no `if agent === ...`)
       ▼
     AcpTransport (stdio first; HTTP/WS later, not in this cycle)
       │  spawn ACP agent process (server/extension-host only — never browser/webview/mobile)
       ▼  JSON-RPC 2.0 (stdout = protocol, stderr = logs only)
     initialize → session/new → session/prompt → session/update notifications → turn end
       ▼
     acp-translate (pure ACP notify → normalized SyncEvent) → existing global-hub → existing sync pipeline
```

Adding a new ACP agent must be config-only:

```yaml
agents:
  new-agent:
    name: New Agent
    backend: acp
    transport: stdio
    command: new-agent
    args: [--acp]
```

Quality test: if onboarding Claude requires touching chat, sidebar, tools,
permissions, session state, or renderers, the abstraction is wrong.

## 3. Files affected

| Area | Files | Change |
|---|---|---|
| Agent abstraction (new) | `packages/ui/src/lib/agent/types.ts`, `active-client.ts`, `config.ts` | `AgentClient` interface, backend selector (session-create + prompt seams only) |
| OpenCode adapter | `packages/ui/src/lib/opencode/client.ts` | `OpencodeService` implements `AgentClient`; thin pass-through |
| ACP UI adapter (new) | `packages/ui/src/lib/agent/acp-client.ts`, `use-acp-session-bootstrap.ts` | `AgentClient` over `/api/agent/acp/*` via `runtimeFetch` |
| Selection UI (new) | `components/sections/agent-backend/AgentBackendPage.tsx`, `stores/useAgentBackendStore.ts` | Settings primitives + locale + search registry (skills: `settings-ui-patterns`, `locale-ui-patterns`, `theme-system`) |
| Sync seams | `sync/session-actions.ts`, `sync/session-ui-store.ts`, `sync/sync-context.tsx`, `sync/use-sync.ts` | Route create/prompt through active client; reducer untouched |
| ACP server (new) | `packages/web/server/lib/acp/{agent-process-manager,acp-connection,acp-event-source,acp-translate,routes,acp-config,env,telemetry}.js` + `__tests__/fixtures/mock-agent.js` | Spawn, handshake, translate, endpoints, flag |
| Server wiring | `packages/web/server/index.js`, `packages/web/package.json`, `lib/event-stream/global-hub.js`, `lib/opencode/feature-routes-runtime.js` | Register `/api/agent/acp/*` BEFORE generic proxy; server-only `@agentclientprotocol/sdk` dep |
| VS Code | `packages/vscode/src/acpAgentProcessRegistry.ts`, `opencode.ts` | Host-side spawn via `spawnOwnedProcess` pattern; bridge forwards to same endpoints |
| Electron / mobile | (no new code expected) | In-process server covers desktop; mobile uses remote server (see §5) |

Presentation leaks to fix (domain indirection, not rewrites):
`ModelControls.tsx`, `FormCard.tsx`, `FormFieldControl.tsx`, `FormDock.tsx`,
`formCardState.ts` (`PermissionEffect`/`FormField`/`FormValue`),
`sections/providers/*` + `sections/mcp/*` (`IntegrationInfo`/`ConnectionInfo`/`IntegrationOAuthMethod`).

## 4. Runtime boundaries

- `packages/ui`: shared React, state, sync, runtime contracts. Never spawns processes,
  never hardcodes hosts, never imports Electron/Node.
- `packages/web`: owns ALL subprocess spawning (`lifecycle.js`, `terminal/runtime.js`
  precedent) and ACP routes. `OPENCHAMBER_ACP_ENABLED` flag, default off.
- `packages/electron`: starts the web server in-process, never a sidecar.
  ACP child runs inside the imported server (main process has `child_process`);
  renderer/preload changes are out of scope. Shutdown bound (35 s) must cover the ACP child.
- `packages/vscode`: no OpenChamber server. ACP child spawns in the extension host
  (`owned-process.ts` pattern + shared registry dir/algorithm); webview reaches it
  via new `bridge.ts` messages. SSE proxy stays OpenCode-only.
- `packages/mobile`: remote-only, no spawn ever. ACP runs on the paired server;
  transport via `runtimeFetch` + SSE (SSE-locked on Capacitor). Relay mode must keep
  working: new routes go through shared transport, no raw `fetch`/`WebSocket`
  (skill: `relay-transport`).

Surface list (one line per runtime): web = full ACP via server routes; desktop =
  full ACP via in-process server; VS Code = full ACP via extension host; hosted
  mobile = full ACP via paired server; Capacitor = full ACP via paired server
  (SSE only, no local process). No runtime gets an accidental fallthrough.

## 5. Session flow

Today: `createSession` captures `runtimeKey` + client identity → `opencodeClient.createSession`
(model Auto stripped, `location.directory`) → `registerSessionDirectory` → child-store
insert → optional select + global upsert. Sends: `optimisticSend` (client-minted `msg_*`)
→ `sendMessage` (circuit breaker, model/agent switch, skill mentions, synthetics)
→ `session.prompt`. Sidebar lists come from directory stores + 45 s global poller;
close = archive overlay (OpenCode has no archive route); delete cascades with 404-as-success.

Target: `AgentSession { id, runtime: { type: "opencode" | "acp", agentId? }, cwd,
title?, capabilities, metadata? }`. Backend bound at creation, immutable after.
ACP sessions map to ACP `session/new` (cwd = session worktree dir, same as today);
`list/resume/close/delete` map onto sidebar + persistence in a later phase
(Should scope). Session records from one backend never leak into another backend's
reads; disappearance is only treated as deletion against two complete snapshots
of the same runtime/scope (skill: `sync-state-invariants`).

## 6. Event flow

Today: WS `/api/global/event/ws` (or SSE `sdk.event.subscribe` in VS Code/no-WS) →
`translateWireEvent`/`routeWireEvent` → per-directory queue (≤100 ms flush, delta
coalescing) → event reducer → child stores → `ChatMessage({info, parts})` renders
domain parts. Bootstrap/reconnect re-seeds from authoritative snapshots; failure
is never rendered as empty success (`null` ≠ `{}`).

Target: ACP `session/update` notifications → `acp-translate` (pure,
`agent_message_chunk` → `message.part.delta`, `tool_call(_update)` → tool
transitions, stop reason → completion; unknown kinds → `[]`) → `global-hub`
(`injectEvent`, spaces pattern as prior art) → the SAME pipeline. ID synthesis
reuses the `ascendingId` hex-timestamp scheme so ordering invariants hold.
Internal `AgentEvent` vocabulary (`message.text.delta`, `tool.started|updated|completed`,
`permission.requested`, `plan.updated`, `usage.updated`, `session.completed`, `error`);
raw ACP shapes never reach components.

## 7. Tool flow

Today: `ToolPart {callID, tool, state: pending|running|completed|error}`,
`projection.projectToolPart` + `events.ts` tool transitions, rendered by `ToolPart.tsx`
via `tools.ts` predicates. Background `shell`/`subagent` settle at once with
`metadata.sessionID` and re-busy the parent on result.

Target: ACP `tool_call`/`tool_call_update` → `AgentToolCall` → the SAME renderer.
No per-provider renderers. OpenCode-specific taxonomy (`shell/edit/patch/subagent`
names, envelope parsing) stays in the OpenCode adapter; ACP kind mapping lives
in `acp-translate`. Deferred (Should): shell/file-edit/MCP-specific validation,
terminal + client-filesystem capabilities.

## 8. Permission flow

Today: `permission.asked` → child store + global blocking index + card/dock/toast
(auto/safety held back until `openchamber.permission-left-for-user`) → user
once/always/reject → `session-actions.respondToPermission` (directory-ownership
rule: owning record's confirmed directory wins) → `permission.reply` →
`permission.replied` removes the request (404 → local remove + stale recovery).

Target: ACP permission request → `AgentRuntime` → SAME card/dock/toast →
user response → ACP response. Start with allow-once/deny; session/always only
when the agent advertises them. Replies resolve directory/session through the
same ownership rule. Capability `permissions: false` hides the affordance
instead of failing at click time.

## 9. Process lifecycle

```text
spawn (node child_process; main / server / extension-host only)
  → register pid file (~/.config/openchamber/managed-acp-agents/<pid>.json)
  → initialize (timeout; failure = visible error, OpenCode untouched)
  → capabilities stored → session/new → prompt turns (1 process : N sessions if stable)
  → cancel = protocol cancel; unresponsive = controlled fallback, not blind SIGKILL
  → shutdown/restart/exit → unregister only after confirmed exit; startup reaps verified orphans
```

Rules: stdout = ACP JSON-RPC (framed, `requestId → resolver`, timeouts);
stderr = logs/debug, never parsed as protocol, never auto-kills a session.
Auth/secrets via env/keychain/CLI login; never in config files, logs, or prompts.
Per-request cwd travels in the request (as `x-opencode-directory` does today);
the daemon cwd stays neutral. Windows: `windowsHide: true`, no console-flash
helpers (skill: `desktop-shell`).

## 10. Migration plan (PoC-validated, Must → Should)

- M1 `refactor(agent)`: `AgentClient` + OpenCode thin adapter, zero behavior change.
- M2 `feat(acp)`: process manager + `OPENCHAMBER_ACP_ENABLED` + server-only SDK dep.
  Resolve OQ1 first: `ClientSideConnection` transport ownership vs managed stdio.
- M3 `feat(acp)`: `acp-event-source` + `acp-translate` (correctness-critical seam).
  Gate: fake-agent turn renders live, sync layer untouched.
- M4 `feat(acp)`: `/api/agent/acp/{initialize,session/new,prompt,cancel,shutdown}`.
- M5 `feat(agent)`: UI `AcpClient` + active-client wiring (create/prompt seams) → Codex E2E.
- M6 `feat(ui)`: settings selection + Custom ACP form (shared primitives, locale, search).
- M7 `feat(acp)`: tool mapping → permissions → error surfacing + telemetry.
- M8: Claude via the same runtime (config/capability-only diffs); full lifecycle
  (list/resume/close/delete); advanced capabilities (models, reasoning, plans,
  slash, MCP, terminal, usage, images) capability-gated.

Out of this cycle: multi-agent orchestration, agent-to-agent comms, auto-reviewer/
merge, remote/HTTP/WS ACP, cloud registry, auto-install, complex worktree orchestration.

## 11. Analysis questions (§62) — answers

1. **Best `AgentRuntime` seam?** `OpencodeService` + `createRuntimeOpencodeClient`
   (`lib/opencode/client.ts:293-363,500-569`): every SDK verb funnels through it.
2. **Direct OpenCode type imports?** 47 `@opencode/client` hits; presentation leaks
   limited to `FormField/FormValue/PermissionEffect/IntegrationInfo/ConnectionInfo`
   in chat + providers/mcp sections (§3). `@opencode/schema` never imported directly.
3. **Session create/persist?** `session-actions.createSession`; server authoritative,
   localStorage snapshot (50, tombstoned); archive = overlay, metadata on record (≥2.0.15).
4. **Events to UI?** WS global / SSE → `translateWireEvent` → 100 ms flush →
   reducer → child stores → domain renderers (§6).
5. **Tool rendering?** `ToolPart.tsx` + `tools.ts` predicates; state machine
   pending→running→completed|error; background shell/subagent re-busy pattern (§7).
6. **Permissions?** Card/dock/toast + blocking index + ownership rule + held-back
   auto/safety replay (§8).
7. **Safe subprocess sites?** Web server, Electron main (in-process server),
   VS Code extension host. Never renderer/preload/webview/mobile (§4).
8. **Shared code?** UI + shape layers (`config-v2`, `provider-env-aliases`,
   registry re-exports); runtime modules own the rest.
9. **Stays OpenCode-specific?** Compatibility gate, CLI binary setting, provider
   circuit, stats/usage shapes, plugin/websearch translates, archive overlay,
   synthetic carriers, `session.command`.
10. **Smallest ACP-safe set?** M1–M4: interface + manager + translate + endpoints;
    UI rides unchanged until M5.
11. **Session→runtime binding?** `AgentSession.runtime {type, agentId}` at creation;
    caches keyed by runtime identity; switches invalidate generations.
12. **Worktrees preserved?** Yes: OpenChamber creates/manages; agent gets `cwd`
    per request; proxy holds reads until `git-ready`.
13. **Cancel?** `runtime.cancel()` → ACP cancel; fallback scoped to the session,
    process kept when the protocol allows.
14. **Capability mapping?** Post-`initialize` negotiation → `AgentCapabilities`;
    UI renders controls only for advertised capabilities.
15. **No ACP leakage?** Translators (`events.ts` precedent, `acp-translate`) emit
    `SyncEvent`s; components keep domain imports; `oxlint` anti-slop on new files.

## 12. Quality gates and baseline (2026-10-02, `bf6b9c5a2`)

- `bun run type-check`: GREEN (all workspaces). `bun run lint`: GREEN (1 pre-existing
  warning: `useSessionActions.ts:81` ref-cleanup).
- `bun run test`: pre-existing failures, NOT attributed to this fork —
  `scripts/bump-version.test.mjs` (expects 1.24.0, packs 1.23.1);
  `packages/sdk` examples bundle mismatch; `packages/ui` `markdownCore` perf timeout
  (5.5 s vs 5 s); `packages/web` `bin/cli.test.js` ngrok-fallback (30 s, network).
  vscode 54/54, electron 29/29 GREEN.
- Per phase: focused tests + package type-check/lint; `bun run dead-code` on
  added/renamed files; `bunx oxlint` on new TS/JS; `bun run build` before phase done.
- Unit: JSON-RPC req/res, pending resolution, notifications, shutdown, error paths,
  ACP→domain + capability + session mapping. Integration: fake agent
  spawn→initialize→new→prompt→stream→complete, no OpenCode. Manual: Codex then
  Claude (create/prompt/stream/cancel/tool).
- Normative errors: `AGENT_NOT_FOUND`, `AGENT_START_FAILED`,
  `AGENT_INITIALIZATION_FAILED`, `AGENT_DISCONNECTED`, `SESSION_CREATE_FAILED`,
  `SESSION_NOT_FOUND`, `PROMPT_FAILED`, `PERMISSION_FAILED`, `PROTOCOL_ERROR`,
  `TIMEOUT` — e.g. "Codex ACP executable not found.", "ACP initialize request timed out."
- Logs: `agent.runtime|opencode|acp|acp.process|acp.protocol|acp.session`;
  content/timing without full prompts; never secrets.

## 13. Manual validation (Codex / Claude)

Automated E2E runs against the fake agent
(`packages/web/server/lib/acp/__tests__/fixtures/mock-agent.mjs`). To validate
a real bridge:

```bash
export OPENCHAMBER_ACP_ENABLED=1
# Codex
npx -y @agentclientprotocol/codex-acp
# or Claude
npx claude-code-acp
```

1. Start the server (`bun run dev:web:server`), open Settings → Agent backend →
   ACP, pick Codex (or Custom with `claude-code-acp` and the agent's login done
   in the terminal first).
2. Create a chat session, send a prompt. The reply must stream; tool calls must
   render generically; a permission request must surface the permission card and
   approve/deny must unblock or stop the tool.
3. Stop the server and confirm the agent process is gone (shutdown teardown),
   restart and confirm no orphan remains (startup reaper).

Not done in this cycle (Should scope from #2010): `session/list`/`resume` in
the sidebar, remote HTTP/WS transports, plans,
slash commands, MCP forwarding, multi-agent orchestration.

Done after the first MVP cut: per-session modes/config options. The server
keeps each session's `modes`/`configOptions` snapshot (from `session/new`,
`set_*` responses, and `*_update` notifications) and serves it at
`POST /api/agent/acp/session/options|mode|config`; the chat renders an
`AcpSessionBar` above the composer for ACP-bound sessions with the agent chip,
a mode select, and one select per select-type config option (e.g. the agent's
model list). No provider-specific code: whatever the agent advertises appears.

## 14. Open questions

- OQ1 (resolved, M2): the SDK does **not** spawn. `@agentclientprotocol/sdk`
  exposes `ndJsonStream(output, input)` over our own
  `WritableStream`/`ReadableStream`, so the managed child's `stdin`/`stdout`
  (`Writable.toWeb`/`Readable.toWeb`) feed the SDK directly and the process
  manager keeps full ownership of spawn, registry, and teardown. Verified by the
  fake-agent integration test in `packages/web/server/lib/acp/__tests__`.
- Telemetry/observability sinks for ACP events (resolve at M7).
- Selection UX: settings section (PoC choice) vs sidebar dropdown (confirm pre-M6).
- Skills to load before implementation edits: `isolated-space-boundary` (agent
  exec/lifecycle), `enterprise-boundary` (key/endpoint entry, egress),
  `performance-engineering` (streaming hot path), `locale-ui-patterns` +
  `theme-system` (selector UI), `relay-transport` + `ui-api-decoupling`
  references (`implementation-map`, `runtime-parity`) for routes/bridges.
